import { ACTIONS_PER_ERROR, MAX_EVENTS } from './config.js';
import { lastActionByTab, pageCaptureReadyByTab } from './state.js';
import { getAllowList, isHostAllowed } from './allowlist.js';
import {
  getClosedTabInfo,
  isDuplicateEvent,
  isValidStoredEvent,
  storeEvent
} from './storage.js';
import { updateBadgeForActiveTab } from './badge.js';

export function registerMessageListeners() {
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

    if (msg.type === 'page-capture-ready') {
      const tabId = sender.tab?.id;
      if (!tabId) return;
      pageCaptureReadyByTab.set(tabId, Date.now());
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

      return true;
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
      sendResponse(getClosedTabInfo());
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

        const fallbackActions =
          lastActionByTab.get(tabId)?.slice(-ACTIONS_PER_ERROR) || [];
        const nextEvent = {
          kind: 'network',
          status: msg.status,
          url: msg.url,
          detail: msg.detail,
          request: msg.request || null,
          actions:
            Array.isArray(msg.actions) && msg.actions.length
              ? msg.actions
              : fallbackActions,
          tabId,
          time: msg.time || Date.now()
        };

        if (!isValidStoredEvent(nextEvent)) {
          console.warn('[Faultline] Dropped invalid network event', nextEvent);
          return;
        }

        if (isDuplicateEvent(nextEvent, cleaned)) {
          if (cleaned.length !== all.length) {
            chrome.storage.local.set(
              { faultlineEvents: cleaned.slice(-MAX_EVENTS) },
              () => {
                updateBadgeForActiveTab();
              }
            );
          }
          return;
        }

        cleaned.push(nextEvent);

        chrome.storage.local.set(
          { faultlineEvents: cleaned.slice(-MAX_EVENTS) },
          () => {
            updateBadgeForActiveTab();
          }
        );
      });

      return;
    }
  });
}
