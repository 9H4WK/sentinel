export const lastActionByTab = new Map();
export const closedTabs = new Map(); // tabId -> closedAt (timestamp)
export const pageCaptureReadyByTab = new Map(); // tabId -> timestamp
export let faultlineEnabled = true;

export function setFaultlineEnabled(enabled) {
  faultlineEnabled = enabled !== false;
}
