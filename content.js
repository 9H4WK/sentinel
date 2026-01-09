// content.js
// Runs in isolated world
// Receives messages from injected.js and background.js
// Shows toasts AND forwards events to background

/* ---------------------------
 * Toast UI (created immediately)
 * --------------------------- */
(function initToastContainer() {
  if (document.getElementById('faultline-toast-container')) return;

  const c = document.createElement('div');
  c.id = 'faultline-toast-container';
  Object.assign(c.style, {
    position: 'fixed',
    top: '12px',
    right: '12px',
    width: '360px',
    zIndex: 2147483647,
    fontFamily: 'Arial, sans-serif',
    pointerEvents: 'none'
  });

  document.documentElement.appendChild(c);
})();

function showToast(title, body) {
  const container = document.getElementById('faultline-toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  Object.assign(toast.style, {
    background: 'rgba(20,20,20,0.95)',
    color: '#fff',
    border: '1px solid #333',
    borderRadius: '6px',
    padding: '8px 10px',
    marginBottom: '8px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
    fontSize: '12px',
    pointerEvents: 'auto'
  });

  const t = document.createElement('div');
  t.textContent = title;
  t.style.fontWeight = '700';

  const b = document.createElement('div');
  b.textContent = body;
  b.style.marginTop = '4px';
  b.style.wordBreak = 'break-word';

  toast.appendChild(t);
  toast.appendChild(b);
  container.appendChild(toast);

  setTimeout(() => toast.remove(), 10000);
}

function formatNetworkToastBody(detail, url) {
  try {
    const path = new URL(url).pathname || '';
    const label = path ? path : url;
    return detail ? `${label} — ${detail}` : label;
  } catch {
    return detail ? `${url} — ${detail}` : url;
  }
}

let faultlineEnabled = true;
chrome.storage.local.get({ faultlineEnabled: true }, res => {
  faultlineEnabled = res.faultlineEnabled !== false;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.faultlineEnabled) {
    faultlineEnabled = changes.faultlineEnabled.newValue !== false;
  }
});

/* ---------------------------
 * Inject page script ASAP
 * --------------------------- */
(function injectImmediately() {
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('injected.js');
  s.onload = () => {
    s.remove();
    try {
      if (chrome?.runtime?.id) {
        // Tell background that page-level capture is active for this tab.
        chrome.runtime.sendMessage({ type: 'page-capture-ready' });
      }
    } catch {}
  };
  (document.head || document.documentElement).appendChild(s);
})();

// Keep a small action buffer in the content script as a fallback.
const ACTIONS_PER_ERROR = 5;
const MAX_ACTION_BUFFER = 10;
const recentActions = [];

function recordAction(action) {
  recentActions.push(action);
  if (recentActions.length > MAX_ACTION_BUFFER) {
    recentActions.shift();
  }
}

function getRecentActions() {
  return recentActions.slice(-ACTIONS_PER_ERROR);
}

/* ---------------------------
 * Receive messages FROM PAGE
 * --------------------------- */
window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  if (!e.data || e.data.source !== 'faultline') return;
  if (!faultlineEnabled) return;

  const p = e.data.payload;

  if (p.type === 'console') {
    // 🔴 TOAST (this was missing / broken before)
    showToast(`Console ${p.level}`, p.message);

    // Persist via background
    chrome.runtime.sendMessage({
      type: 'console',
      level: p.level,
      message: p.message,
      stack: p.stack,
      actions: Array.isArray(p.actions) ? p.actions : []
    });
  }
});

window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  if (e.data?.source !== 'faultline-action') return;
  if (!faultlineEnabled) return;

  try {
    recordAction(e.data.action);
    if (chrome?.runtime?.id) {
      chrome.runtime.sendMessage({
        type: 'user-action',
        action: e.data.action
      });
    }
  } catch (err) {
    // Extension context invalidated – safe to ignore
  }
});

// ================================
// 1. Listen to PAGE messages (faultline)
// ================================
window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  if (e.data?.source !== 'faultline') return;
  if (!faultlineEnabled) return;

  const p = e.data.payload;

  // 🔹 NETWORK (toast + store)
  if (p.type === 'network') {
    showToast(
      `HTTP ${p.status}`,
      formatNetworkToastBody(p.detail, p.url)
    );

    try {
      if (chrome?.runtime?.id) {
        chrome.runtime.sendMessage({
          ...p,
          actions:
            Array.isArray(p.actions) && p.actions.length
              ? p.actions
              : getRecentActions(),
          type: 'network-page'
        });
      }
    } catch {}
  }

  // 🔹 CONSOLE
  if (p.type === 'console') {
    showToast(
      `Console ${p.level}`,
      p.message
    );

    try {
      if (chrome?.runtime?.id) {
        chrome.runtime.sendMessage({
          type: 'console',
          ...p
        });
      }
    } catch {}
  }
});

