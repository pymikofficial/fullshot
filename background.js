// Tracks tabs currently mid-capture, so a second click while one is running
// doesn't attach the debugger twice and crash.
const capturingTabs = new Set();

const MAX_HEIGHT = 20000; // safety cap for pathological infinite-scroll pages
const SCROLL_STEP = 600;
const SCROLL_PAUSE_MS = 120;

chrome.action.onClicked.addListener((tab) => {
  runCapture(tab).catch((err) => {
    console.error('Fullshot error:', err);
    notify('Fullshot failed', err.message || 'Something went wrong.');
    setBadge(tab.id, '!', '#ff6b6b');
    setTimeout(() => clearBadge(tab.id), 2500);
    capturingTabs.delete(tab.id);
  });
});

async function runCapture(tab) {
  if (!tab.id || !tab.url) {
    throw new Error('No active tab found.');
  }
  if (isRestrictedUrl(tab.url)) {
    throw new Error("Can't capture this page (browser-internal or restricted pages aren't allowed).");
  }
  if (capturingTabs.has(tab.id)) {
    return; // already running, ignore the extra click
  }

  capturingTabs.add(tab.id);
  setBadge(tab.id, '...', '#a78bfa');

  try {
    // Pre-scroll pass: trigger any lazy-loaded images/content before we capture,
    // then return to the top so sticky headers render in their natural state.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrollThroughPage,
      args: [SCROLL_STEP, SCROLL_PAUSE_MS]
    });

    await attachDebugger(tab.id);

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
    url.startsWith('https://chrome.google.com/webstore')
  );
}

function buildFilename(url, title) {
  let host = 'page';
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch (e) {}
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
