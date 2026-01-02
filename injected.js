// injected.js
// Runs in PAGE context
// Intercepts console errors + JS errors
// Tracks last user action
// Sends structured events to content.js via window.postMessage

(function () {
  const SOURCE = 'faultline';

  /* --------------------------------
   * Utilities
   * -------------------------------- */
  function safeStringify(val) {
    try {
      if (typeof val === 'string') return val;
      return JSON.stringify(val);
    } catch {
      return String(val);
    }
  }

  function send(payload) {
    try {
      window.postMessage(
        {
          source: SOURCE,
          payload
        },
        '*'
      );
    } catch {
      // swallow
    }
  }

  /* --------------------------------
   * User action tracking
   * -------------------------------- */
  const __faultlineActions = [];
  const MAX_ACTIONS = 10;

  function recordAction(action) {
    __faultlineActions.push(action);
    if (__faultlineActions.length > MAX_ACTIONS) {
      __faultlineActions.shift();
    }
    notifyAction(action);
  }

  function notifyAction(action) {
    try {
      window.postMessage(
        {
          source: 'faultline-action',
          action
        },
        '*'
      );
    } catch {}
  }

  function getLabel(el) {
    if (!el) return 'unknown element';

    const actionable = el.closest?.(
      'button, a, input, textarea, select, [role="button"]'
    );

    const target = actionable || el;

    return (
      target.getAttribute?.('aria-label') ||
      target.getAttribute?.('data-testid') ||
      target.textContent?.trim()?.slice(0, 50) ||
      target.id ||
      target.name ||
      `<${target.tagName.toLowerCase()}>`
    );
  }

  document.addEventListener(
    'click',
    (e) => {
      recordAction({
        type: 'click',
        label: getLabel(e.target),
        selector: e.target?.tagName,
        time: Date.now()
      });
    },
    true
  );

  document.addEventListener(
    'submit',
    (e) => {
      recordAction({
        type: 'submit',
        label: getLabel(e.target),
        selector: e.target?.tagName,
        time: Date.now()
      });
    },
    true
  );

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      recordAction({
        type: 'key',
        label: e.key,
        selector: document.activeElement?.tagName,
        time: Date.now()
      });
    }
  });

  function lastAction() {
    return __faultlineActions.at(-1) || null;
  }

  /* --------------------------------
   * Console interception
   * -------------------------------- */
  ['error', 'warn'].forEach((level) => {
    const original = console[level];

    console[level] = function (...args) {
      const message = args.map(safeStringify).join(' ');
      const stack = new Error().stack;

      send({
        type: 'console',
        level,
        message,
        stack,
        actions: __faultlineActions.slice(-3) // ⬅️ last 3
      });

      return original.apply(console, args);
    };
  });

  /* --------------------------------
   * Uncaught JS errors
   * -------------------------------- */
  window.addEventListener('error', (e) => {
    send({
      type: 'console',
      level: 'error',
      message: e.message,
      stack: e.error?.stack || null,
      actions: __faultlineActions.slice(-3) // ⬅️ last 3
    });
  });

  /* --------------------------------
   * Unhandled promise rejections
   * -------------------------------- */
  window.addEventListener('unhandledrejection', (e) => {
    send({
      type: 'console',
      level: 'error',
      message: `UnhandledPromiseRejection: ${safeStringify(e.reason)}`,
      stack: e.reason?.stack || null,
      actions: __faultlineActions.slice(-3) // ⬅️ last 3
    });
  });
})();
