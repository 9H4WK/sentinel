// background.js
// MV3 service worker
// Owns persistence (chrome.storage)
// Safely notifies content scripts when available

// Auto-cleanup config
const CLOSED_TAB_RETENTION_MS = 0.2 * 60 * 1000; // 5 minutes
// How many actions to show per error (must match injected.js)
const ACTIONS_PER_ERROR = 5;

// Last user action per tab (for network correlation)
const lastActionByTab = new Map();

/* --------------------------------
 * Allow list (hostnames only)
 * -------------------------------- */
const DEFAULT_ALLOW_LIST = [
  'localhost',
  '127.0.0.1',
  '*.shareforcelegal.com'
]; 

/* --------------------------------
 * Badge helpers
 * -------------------------------- */
function updateBadge(count) {
  const text = count > 0 ? String(count) : '';
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: '#d93025' }); // red
}

function refreshBadgeFromStorage() {
  chrome.storage.local.get({ faultlineEvents: [] }, res => {
    updateBadge(res.faultlineEvents.length);
  });
}

async function updateBadgeForActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });

    if (!tab?.id) {
      chrome.action.setBadgeText({ text: '' });
      return;
    }

    chrome.storage.local.get({ faultlineEvents: [] }, res => {
      const count = res.faultlineEvents.filter(
        e => e.tabId === tab.id
      ).length;

      chrome.action.setBadgeText({
        text: count > 0 ? String(count) : '',
        tabId: tab.id
      });

      chrome.action.setBadgeBackgroundColor({
        color: '#d93025',
        tabId: tab.id
      });
    });
  } catch (_) {
    // ignore
  }
}


const closedTabs = new Map(); // tabId -> closedAt (timestamp)

/* --------------------------------
 * Utilities
 * -------------------------------- */
async function safeSend(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    // Expected if content script is not injected
    // DO NOT throw
  }
}

function storeEvent(event, tabId) {
  const withTab = {
    ...event,
    tabId
  };

  chrome.storage.local.get({ faultlineEvents: [] }, res => {
    const updated = res.faultlineEvents
      .concat(withTab)
      .slice(-200);

    chrome.storage.local.set({ faultlineEvents: updated }, () => {
      updateBadgeForActiveTab();
      if (tabId !== undefined) {
        safeSend(tabId, { __FAULTLINE_EVENT__: true });
      }
    });
  });
}

function cleanupClosedTabEvents() {
  const now = Date.now();

  chrome.storage.local.get({ faultlineEvents: [] }, res => {
    const remaining = res.faultlineEvents.filter(event => {
      if (event.tabId == null) return true;

      const closedAt = closedTabs.get(event.tabId);
      if (!closedAt) return true; // tab still open

      // tab is closed — check age
      return (now - event.time) < CLOSED_TAB_RETENTION_MS;
    });

    if (remaining.length !== res.faultlineEvents.length) {
      chrome.storage.local.set({ faultlineEvents: remaining }, () => {
        updateBadgeForActiveTab();
      });
    }
  });

  // prune old closed-tab markers
  for (const [tabId, closedAt] of closedTabs.entries()) {
    if ((now - closedAt) > CLOSED_TAB_RETENTION_MS) {
      closedTabs.delete(tabId);
    }
  }
}

function getClosedTabInfo() {
  const now = Date.now();
  const info = {};
  for (const [tabId, closedAt] of closedTabs.entries()) {
    const remaining = Math.max(
      0,
      CLOSED_TAB_RETENTION_MS - (now - closedAt)
    );
    info[tabId] = remaining;
  }
  return info;
}

function getEventsForTab(tabId) {
  return new Promise((resolve) => {
    chrome.storage.local.get({ faultlineEvents: [] }, (res) => {
      resolve(res.faultlineEvents.filter(e => e.tabId === tabId));
    });
  });
}

async function getAllowList() {
  const res = await chrome.storage.local.get({
    allowList: DEFAULT_ALLOW_LIST
  });
  return res.allowList;
}

async function isHostAllowed(urlOrHost) {
  try {
    const host = urlOrHost.includes('://')
      ? new URL(urlOrHost).hostname
      : urlOrHost;

    const allowList = await getAllowList();

    return allowList.some(pattern => {
      if (pattern.startsWith('*.')) {
        const base = pattern.slice(2);
        return host === base || host.endsWith('.' + base);
      }
      return host === pattern;
    });
  } catch {
    return false;
  }
}

/* --------------------------------
 * Lifecycle
 * -------------------------------- */
chrome.runtime.onInstalled.addListener(() => {
  console.log('[Faultline] installed');
  updateBadgeForActiveTab();
});

chrome.tabs.onActivated.addListener(() => {
  updateBadgeForActiveTab();
  cleanupClosedTabEvents();
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete') {
    updateBadgeForActiveTab();
    cleanupClosedTabEvents();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  closedTabs.set(tabId, Date.now());
  cleanupClosedTabEvents();
});


/* --------------------------------
 * Network monitoring (HTTP errors)
 * -------------------------------- */
chrome.webRequest.onCompleted.addListener(
  (details) => {
    (async () => {
      const { statusCode, url, method, tabId } = details;
      if (tabId === -1) return;
      if (statusCode < 400) return;
      if (!(await isHostAllowed(url))) return;
      
      const existing = await new Promise((resolve) => {
    chrome.storage.local.get({ faultlineEvents: [] }, (res) => {
          resolve(res.faultlineEvents.filter(e => e.tabId === tabId));
        });
      });

      if (
        existing.some(
          e => e.kind === 'network' && e.url === url && e.detail
        )
      ) {
        return;
      }


      const actions =
        lastActionByTab.get(tabId)?.slice(-ACTIONS_PER_ERROR) || [];

      const event = {
        kind: 'network',
        status: statusCode,
        url,
        method,
        actions,
        time: Date.now()
      };

      storeEvent(event, tabId);
      updateBadgeForActiveTab();
    })();
  },
  { urls: ['<all_urls>'] }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    (async () => {
      const { error, url, method, tabId } = details;
      const actions = lastActionByTab.get(tabId)?.slice(-ACTIONS_PER_ERROR) || [];

      if (tabId === -1) return;
      if (!(await isHostAllowed(url))) return;
      // Ignore generic HTTP FAIL errors from webRequest fallback
      if (error === 'net::ERR_FAILED') return;

      const event = {
        kind: 'network',
        status: 'FAIL',
        url,
        method,
        error,
        actions,
        time: Date.now()
      };

      storeEvent(event, tabId);
    })();
  },
  { urls: ['<all_urls>'] }
);

/* --------------------------------
 * Console errors from content.js
 * -------------------------------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'user-action') {
    const tabId = sender.tab?.id;
    if (!tabId) return;

    const existing = lastActionByTab.get(tabId) || [];
    existing.push(msg.action);
    if (existing.length > 10) existing.shift();
    lastActionByTab.set(tabId, existing);
    return;
  }

  /* ===============================
   * CONSOLE EVENTS
   * =============================== */
  if (msg.type === 'console') {
    (async () => {
      const tab = sender.tab;
      if (!tab?.id || !tab.url) return;

      // TEMP: disable allow-list while debugging
      // if (!(await isHostAllowed(tab.url))) return;

      const event = {
        kind: 'console',
        level: msg.level,
        message: msg.message,
        stack: msg.stack,
        actions: Array.isArray(msg.actions) ? msg.actions : [],
        time: Date.now()
      };

      storeEvent(event, tab.id);
      updateBadgeForActiveTab();
    })();

    return true; // 🔴 REQUIRED
  }

  /* ===============================
   * CLEAR TAB EVENTS
   * =============================== */
  if (msg.type === 'clear-tab-events') {
    chrome.storage.local.get({ faultlineEvents: [] }, res => {
      const remaining = res.faultlineEvents.filter(
        e => e.tabId !== msg.tabId
      );

      chrome.storage.local.set({ faultlineEvents: remaining }, () => {
        updateBadgeForActiveTab();
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  /* ===============================
   * CLEAR ACTIVE TAB
   * =============================== */
  if (msg.type === 'clear-events') {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab?.id) return;

      chrome.storage.local.get({ faultlineEvents: [] }, res => {
        const remaining = res.faultlineEvents.filter(
          e => e.tabId !== tab.id
        );

        chrome.storage.local.set({ faultlineEvents: remaining }, () => {
          updateBadgeForActiveTab();
          sendResponse({ ok: true });
        });
      });
    });
    return true;
  }

  /* ===============================
   * CLOSED TAB TTL INFO
   * =============================== */
  if (msg.type === 'get-closed-tabs') {
    const now = Date.now();
    const info = {};

    for (const [tabId, closedAt] of closedTabs.entries()) {
      info[tabId] = Math.max(
        0,
        CLOSED_TAB_RETENTION_MS - (now - closedAt)
      );
    }

    sendResponse(info);
    return true;
  }

  /* ===============================
   * ALLOW-LIST
   * =============================== */
  if (msg.type === 'get-allow-list') {
    getAllowList().then(list => sendResponse(list));
    return true;
  }

  if (msg.type === 'set-allow-list') {
    chrome.storage.local.set(
      { allowList: msg.allowList },
      () => sendResponse({ ok: true })
    );
    return true;
  }

  if (msg.type === 'is-allowed-host') {
    isHostAllowed(msg.host).then(allowed => sendResponse(allowed));
    return true;
  }
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'network-page') {
    const tabId = sender.tab?.id;
    if (!tabId) return;

        chrome.storage.local.get({ faultlineEvents: [] }, (res) => {
      const all = res.faultlineEvents;

      // Remove ANY existing network event for same tab + URL (webRequest fallback)
      const cleaned = all.filter(
        e => !(e.tabId === tabId && e.kind === 'network' && e.url === msg.url)
      );

      cleaned.push({
        kind: 'network',
        status: msg.status,
        url: msg.url,
        detail: msg.detail, // page-level detail
        actions: msg.actions || [],
        tabId,
        time: msg.time || Date.now()
      });

      chrome.storage.local.set(
        { faultlineEvents: cleaned.slice(-200) },
        () => {
          updateBadgeForActiveTab();
        }
      );
    });

    return;
  }
});



