// Tracks tabs currently mid-capture, so a second click while one is running
// doesn't attach the debugger twice and crash.
const capturingTabs = new Set();

// Safety cap for pathological infinite-scroll pages. Kept conservative because the
// captured PNG is held as a base64 data URL in the MV3 service worker's memory,
// which is more constrained than a normal page context.
const MAX_HEIGHT = 12000;
const SCROLL_STEP = 600;
const SCROLL_PAUSE_MS = 120;

chrome.action.onClicked.addListener((tab) => {
  runCapture(tab).catch((err) => {
    console.error('Fullshot error:', err);
    const message = err.userFacing ? err.message : 'Something went wrong capturing this page. Try again in a moment.';
    notify('Fullshot failed', message);
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

    const width = Math.ceil(contentSize.width);
    const height = Math.min(Math.ceil(contentSize.height), MAX_HEIGHT);

    // Force the page's actual viewport to the full content height, rather than
    // relying on captureBeyondViewport's internal tiling, which can duplicate
    // paint layers on pages with sticky headers or vh-based sections.
    await sendCommand(tab.id, 'Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false
    });

    // Let the page settle at its new size before capturing, layout/reflow
    // and any scroll-position resets need a beat to finish.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const result = await sendCommand(tab.id, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false
    });

    await sendCommand(tab.id, 'Emulation.clearDeviceMetricsOverride', {});
    await detachDebugger(tab.id);
    debuggerAttached = false;

    const filename = buildFilename(tab.url, tab.title);
    await chrome.downloads.download({
      url: 'data:image/png;base64,' + result.data,
      filename,
      saveAs: false
    });

    setBadge(tab.id, '✓', '#5cd6a3');
    notify('Screenshot saved', filename.split('/').pop());
    setTimeout(() => clearBadge(tab.id), 1800);
  } finally {
    if (debuggerAttached) {
      await detachDebugger(tab.id);
    }
    capturingTabs.delete(tab.id);
  }
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
    console.warn('Fullshot: could not parse URL for filename, using fallback.', e);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `fullshot/${host}-${stamp}.png`;
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
