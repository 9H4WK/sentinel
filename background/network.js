import { ACTIONS_PER_ERROR } from './config.js';
import { lastActionByTab } from './state.js';
import { isHostAllowed } from './allowlist.js';
import { getEventsForTab, storeEvent } from './storage.js';
import { updateBadgeForActiveTab } from './badge.js';

export function registerNetworkListeners() {
  chrome.webRequest.onCompleted.addListener(
    (details) => {
      (async () => {
        const { statusCode, url, method, tabId } = details;
        if (tabId === -1) return;
        if (statusCode < 400) return;
        if (!(await isHostAllowed(url))) return;

        const existing = await getEventsForTab(tabId);
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
        const actions =
          lastActionByTab.get(tabId)?.slice(-ACTIONS_PER_ERROR) || [];

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
}
