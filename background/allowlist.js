import { DEFAULT_ALLOW_LIST } from './config.js';

export async function getAllowList() {
  const res = await chrome.storage.local.get({
    allowList: DEFAULT_ALLOW_LIST
  });
  return res.allowList;
}

export async function isHostAllowed(urlOrHost) {
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
