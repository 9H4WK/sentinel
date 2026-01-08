export function updateBadge(count) {
  const text = count > 0 ? String(count) : '';
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
}

export function refreshBadgeFromStorage() {
  chrome.storage.local.get({ faultlineEvents: [] }, res => {
    updateBadge(res.faultlineEvents.length);
  });
}

export async function updateBadgeForActiveTab() {
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
