import {
  CLOSED_TAB_RETENTION_MS,
  DEDUPE_WINDOW_MS,
  MAX_EVENTS
} from './config.js';
import { closedTabs } from './state.js';
import { updateBadgeForActiveTab } from './badge.js';

async function safeSend(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    // Expected if content script is not injected
  }
}

// Hard schema gate to prevent corrupted writes.
function isValidEvent(event) {
  if (!event || typeof event !== 'object') return false;
  if (event.kind !== 'network' && event.kind !== 'console') return false;
  if (!Number.isFinite(event.time)) return false;

  if (event.kind === 'network') {
    const statusOk =
      Number.isFinite(event.status) || event.status === 'FAIL';
    if (!statusOk) return false;
    if (typeof event.url !== 'string' || event.url.length === 0) return false;
  }

  if (event.kind === 'console') {
    if (typeof event.level !== 'string') return false;
    if (typeof event.message !== 'string') return false;
  }

  if (event.actions != null && !Array.isArray(event.actions)) return false;

  return true;
}

// Collapse retry spam within a short window.
export function isDuplicateEvent(event, events) {
  if (
    !event ||
    !event.url ||
    event.status == null ||
    event.kind !== 'network'
  ) {
    return false;
  }

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const existing = events[i];
    if (
      existing.kind === 'network' &&
      existing.tabId === event.tabId &&
      existing.url === event.url &&
      existing.status === event.status &&
      Number.isFinite(existing.time)
    ) {
      const delta = Math.abs(event.time - existing.time);
      return delta <= DEDUPE_WINDOW_MS;
    }
  }

  return false;
}

export function storeEvent(event, tabId) {
  if (!isValidEvent(event)) {
    console.warn('[Faultline] Dropped invalid event', event);
    return;
  }

  const withTab = {
    ...event,
    tabId
  };

  chrome.storage.local.get({ faultlineEvents: [] }, res => {
    if (isDuplicateEvent(withTab, res.faultlineEvents)) {
      return;
    }

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

export function isValidStoredEvent(event) {
  return isValidEvent(event);
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
