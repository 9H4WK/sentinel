import { ACTIONS_PER_ERROR } from './config.js';
import { faultlineEnabled, pageCaptureReadyByTab } from './state.js';
import { isHostAllowed } from './allowlist.js';
import { getEventsForTab, getRecentActions, storeEvent } from './storage.js';
import { updateBadgeForActiveTab } from './badge.js';

export function registerNetworkListeners() {
  chrome.webRequest.onCompleted.addListener(
    (details) => {
    (async () => {
      if (!faultlineEnabled) return;
      const { statusCode, url, method, tabId } = details;
      if (tabId === -1) return;
      if (statusCode < 400) return;
      if (!(await isHostAllowed(url))) return;
      // Prefer page-level network capture when available.
      if (pageCaptureReadyByTab.has(tabId)) return;

        const existing = await getEventsForTab(tabId);
        if (
          existing.some(
            e => e.kind === 'network' && e.url === url && e.detail
          )
        ) {
          return;
        }

      const actions = await getRecentActions(
        tabId,
        ACTIONS_PER_ERROR
      );

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
      if (!faultlineEnabled) return;
      const { error, url, method, tabId } = details;
        const actions = await getRecentActions(
          tabId,
          ACTIONS_PER_ERROR
        );

        if (tabId === -1) return;
        if (!(await isHostAllowed(url))) return;
        // Ignore HTTP FAIL events from webRequest fallback
        return;

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
}
