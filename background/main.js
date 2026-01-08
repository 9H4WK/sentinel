import { registerLifecycleListeners } from './lifecycle.js';
import { registerMessageListeners } from './messages.js';
import { registerNetworkListeners } from './network.js';

registerLifecycleListeners();
registerMessageListeners();
registerNetworkListeners();
