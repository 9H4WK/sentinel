import { CLOSED_TAB_RETENTION_MS, MAX_EVENTS } from './config.js';
import { closedTabs } from './state.js';
import { updateBadgeForActiveTab } from './badge.js';

async function safeSend(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    // Expected if content script is not injected
  }
}

export function storeEvent(event, tabId) {
  const withTab = {
    ...event,
    tabId
  };

  chrome.storage.local.get({ faultlineEvents: [] }, res => {
    const updated = res.faultlineEvents
      .concat(withTab)
      .slice(-MAX_EVENTS);

    chrome.storage.local.set({ faultlineEvents: updated }, () => {
      updateBadgeForActiveTab();
      if (tabId !== undefined) {
        safeSend(tabId, { __FAULTLINE_EVENT__: true });
      }
    });
  });
}

export function getEventsForTab(tabId) {
  return new Promise((resolve) => {
    chrome.storage.local.get({ faultlineEvents: [] }, (res) => {
      resolve(res.faultlineEvents.filter(e => e.tabId === tabId));
    });
  });
}

export function cleanupClosedTabEvents() {
  const now = Date.now();

  chrome.storage.local.get({ faultlineEvents: [] }, res => {
    const remaining = res.faultlineEvents.filter(event => {
      if (event.tabId == null) return true;

      const closedAt = closedTabs.get(event.tabId);
      if (!closedAt) return true;

      return (now - event.time) < CLOSED_TAB_RETENTION_MS;
    });

    if (remaining.length !== res.faultlineEvents.length) {
      chrome.storage.local.set({ faultlineEvents: remaining }, () => {
        updateBadgeForActiveTab();
      });
    }
  });

  for (const [tabId, closedAt] of closedTabs.entries()) {
    if ((now - closedAt) > CLOSED_TAB_RETENTION_MS) {
      closedTabs.delete(tabId);
    }
  }
}

export function getClosedTabInfo() {
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
