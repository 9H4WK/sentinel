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

/* ---------------------------
 * Inject page script ASAP
 * --------------------------- */
(function injectImmediately() {
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('injected.js');
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);
})();

/* ---------------------------
 * Receive messages FROM PAGE
 * --------------------------- */
window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  if (!e.data || e.data.source !== 'faultline') return;

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

  try {
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

/* ---------------------------
 * Receive messages FROM BACKGROUND
 * --------------------------- */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'network-error') {
    showToast(
      `HTTP ${msg.statusCode}`,
      `${msg.method} ${msg.url}`
    );
  }

  if (msg.type === 'network-failure') {
    showToast(
      'Network failure',
      `${msg.method} ${msg.url} (${msg.error})`
    );
  }
});
