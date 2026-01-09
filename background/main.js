import { registerLifecycleListeners } from './lifecycle.js';
import { registerMessageListeners } from './messages.js';
import { registerNetworkListeners } from './network.js';
import { setFaultlineEnabled } from './state.js';

registerLifecycleListeners();
registerMessageListeners();
registerNetworkListeners();

chrome.storage.local.get({ faultlineEnabled: true }, res => {
  setFaultlineEnabled(res.faultlineEnabled);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.faultlineEnabled) {
    setFaultlineEnabled(changes.faultlineEnabled.newValue);
  }
});
