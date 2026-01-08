import { updateBadgeForActiveTab } from './badge.js';
import { cleanupClosedTabEvents, clearStoredActions } from './storage.js';
import { closedTabs, pageCaptureReadyByTab } from './state.js';

export function registerLifecycleListeners() {
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
    pageCaptureReadyByTab.delete(tabId);
    clearStoredActions(tabId);
    cleanupClosedTabEvents();
  });
}
