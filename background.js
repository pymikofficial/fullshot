// Tracks tabs currently mid-capture, so a second click while one is running
// doesn't attach the debugger twice and crash.
const capturingTabs = new Set();

// v1.0.1 forced deviceScaleFactor: 1 regardless of the page's real pixel
// density, so a 944px-wide capture only ever had 944 real pixels of width no
// matter how text-dense the source page was, blurry on any zoom. This forces
// a real scale instead.
const CAPTURE_SCALE = 2;

// Two independent ceilings on a single CDP capture: a per-dimension limit
// (GPU texture size limits mean captures much beyond ~16,384px in one
// dimension can fail or come back corrupted) and a total-pixel limit (the
// captured PNG is held as a base64 data URL in the MV3 service worker's
// memory, which is more constrained than a normal page context). At
// CAPTURE_SCALE 2x, forcing real resolution means far less content fits in
// one shot than the old scale-1 code assumed, so instead of silently
// cropping anything past a fixed height (what v1.0.1 did), a page that
// doesn't fit gets split into multiple full-resolution files instead of one
// blurry or truncated one.
const MAX_DIMENSION_PX = 16000;
const MAX_CAPTURE_PIXELS = 40000000;

// Outer bound on total page height processed at all, independent of
// splitting, purely to keep pathological infinite-scroll pages from
// generating an unbounded number of part files.
const MAX_PARTS = 12;

const SCROLL_STEP = 600;
const SCROLL_PAUSE_MS = 120;

chrome.action.onClicked.addListener((tab) => {
  runCapture(tab).catch((err) => {
    console.error('Full Webpage Screenshot error:', err);
    const message = err.userFacing ? err.message : 'Something went wrong capturing this page. Try again in a moment.';
    notify('Capture failed', message);
    setBadge(tab.id, '!', '#ff6b6b');
    setTimeout(() => clearBadge(tab.id), 2500);
    capturingTabs.delete(tab.id);
  });
});

// The pre-scroll pass (run inside the page) reports progress here so the
// toolbar badge can show something other than a static "..." for a few seconds.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'fullshot-scroll-progress' && sender.tab && capturingTabs.has(sender.tab.id)) {
    setBadge(sender.tab.id, `${msg.pct}%`, '#a78bfa');
  }
});

function userError(message) {
  return Object.assign(new Error(message), { userFacing: true });
}

async function runCapture(tab) {
  if (!tab.id || !tab.url) {
    throw userError('No active tab found.');
  }
  if (isRestrictedUrl(tab.url)) {
    throw userError("Can't capture this page (browser-internal or restricted pages aren't allowed).");
  }
  if (capturingTabs.has(tab.id)) {
    return; // already running, ignore the extra click
  }

  capturingTabs.add(tab.id);
  setBadge(tab.id, '...', '#a78bfa');

  let debuggerAttached = false;

  try {
    // Pre-scroll pass: trigger any lazy-loaded images/content before we capture,
    // then return to the top so sticky headers render in their natural state.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrollThroughPage,
      args: [SCROLL_STEP, SCROLL_PAUSE_MS]
    });
    setBadge(tab.id, '...', '#a78bfa');

    await attachDebugger(tab.id);
    debuggerAttached = true;

    await sendCommand(tab.id, 'Page.enable', {});
    const metrics = await sendCommand(tab.id, 'Page.getLayoutMetrics', {});
    const contentSize = metrics.cssContentSize || metrics.contentSize;

    const rawWidth = Math.ceil(contentSize.width);
    const rawHeight = Math.ceil(contentSize.height);

    // If a single dimension is so wide that even width alone would blow the
    // texture-size ceiling at full scale, shrink the effective scale for
    // this capture rather than clip content. Rare in practice: most pages
    // that are extremely wide are wide because of one runaway element, not
    // real content worth full resolution.
    const scale = rawWidth * CAPTURE_SCALE > MAX_DIMENSION_PX
      ? Math.max(1, Math.floor((MAX_DIMENSION_PX / rawWidth) * 10) / 10)
      : CAPTURE_SCALE;

    const width = rawWidth;

    // Max CSS height that fits in one capture at this scale, respecting both
    // the per-dimension ceiling and the total-pixel ceiling.
    const maxCssHeightByDimension = Math.floor(MAX_DIMENSION_PX / scale);
    const maxCssHeightByPixels = Math.floor(MAX_CAPTURE_PIXELS / (width * scale * scale));
    const maxCssHeightPerCapture = Math.max(1, Math.min(maxCssHeightByDimension, maxCssHeightByPixels));

    // Outer safety bound: cap total processed height so a pathological
    // infinite-scroll page can't generate an unbounded number of parts.
    const totalHeight = Math.min(rawHeight, maxCssHeightPerCapture * MAX_PARTS);

    const parts = [];
    if (totalHeight <= maxCssHeightPerCapture) {
      // Fits in one shot: identical approach to v1.0.1 (resize the viewport
      // to the full content height and capture once, no scrolling involved,
      // so sticky headers only ever render once), just at real resolution
      // instead of forced 1x.
      const data = await captureAtCurrentScroll(tab.id, width, totalHeight, scale);
      parts.push(data);
    } else {
      // Doesn't fit even at full resolution: split into multiple
      // full-resolution files instead of silently cropping or blurring.
      // Known tradeoff: each part is captured after scrolling the real page
      // to that offset, so a sticky/fixed header will render again at the
      // top of every part after the first, unlike the single-shot path.
      let offset = 0;
      while (offset < totalHeight) {
        const sliceHeight = Math.min(maxCssHeightPerCapture, totalHeight - offset);
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (y) => window.scrollTo(0, y),
          args: [offset]
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
        const data = await captureAtCurrentScroll(tab.id, width, sliceHeight, scale);
        parts.push(data);
        offset += sliceHeight;
      }
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.scrollTo(0, 0)
      });
    }

    await detachDebugger(tab.id);
    debuggerAttached = false;

    const baseFilename = buildFilename(tab.url, tab.title);
    for (let i = 0; i < parts.length; i++) {
      const filename = parts.length > 1
        ? baseFilename.replace(/\.png$/, `_part${i + 1}-of-${parts.length}.png`)
        : baseFilename;
      await chrome.downloads.download({
        url: 'data:image/png;base64,' + parts[i],
        filename,
        saveAs: false
      });
    }

    setBadge(tab.id, '✓', '#5cd6a3');
    notify(
      'Screenshot saved',
      parts.length > 1
        ? `${baseFilename.split('/').pop()} split into ${parts.length} full-resolution parts`
        : baseFilename.split('/').pop()
    );
    setTimeout(() => clearBadge(tab.id), 1800);
  } finally {
    if (debuggerAttached) {
      await detachDebugger(tab.id);
    }
    capturingTabs.delete(tab.id);
  }
}

// Resizes the emulated viewport to (width x cssHeight) at the given scale
// and captures whatever's currently in view. Caller is responsible for
// scrolling the real page to the right offset first, this only handles the
// viewport-resize-and-capture step shared by both the single-shot and
// multi-part paths.
async function captureAtCurrentScroll(tabId, width, cssHeight, scale) {
  await sendCommand(tabId, 'Emulation.setDeviceMetricsOverride', {
    width,
    height: cssHeight,
    deviceScaleFactor: scale,
    mobile: false
  });

  // Let the page settle at its new size before capturing, layout/reflow
  // and any scroll-position resets need a beat to finish.
  await new Promise((resolve) => setTimeout(resolve, 300));

  const result = await sendCommand(tabId, 'Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false
  });

  await sendCommand(tabId, 'Emulation.clearDeviceMetricsOverride', {});
  return result.data;
}

function attachDebugger(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

function detachDebugger(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => resolve());
  });
}

function sendCommand(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

// Runs inside the page itself via chrome.scripting.executeScript.
function scrollThroughPage(step, pauseMs) {
  return new Promise((resolve) => {
    const totalHeight = document.documentElement.scrollHeight;
    let current = 0;

    function step_() {
      window.scrollTo(0, current);
      current += step;
      const pct = Math.min(100, Math.round((current / totalHeight) * 100));
      try {
        chrome.runtime.sendMessage({ type: 'fullshot-scroll-progress', pct });
      } catch (e) {}
      if (current < totalHeight) {
        setTimeout(step_, pauseMs);
      } else {
        window.scrollTo(0, 0);
        setTimeout(resolve, pauseMs);
      }
    }
    step_();
  });
}

function isRestrictedUrl(url) {
  return (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('edge://') ||
    url.startsWith('about:') ||
    url.startsWith('https://chrome.google.com/webstore') ||
    url.startsWith('https://chromewebstore.google.com')
  );
}

function buildFilename(url, title) {
  let host = 'page';
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch (e) {
    console.warn('Full Webpage Screenshot: could not parse URL for filename, using fallback.', e);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `full-webpage-screenshot/${host}-${stamp}.png`;
}

function setBadge(tabId, text, color) {
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setBadgeBackgroundColor({ tabId, color });
}

function clearBadge(tabId) {
  chrome.action.setBadgeText({ tabId, text: '' });
}

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message
  });
}
