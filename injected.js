// injected.js
// Runs in PAGE context (not content-script context)
// Captures console errors, uncaught errors, unhandled promise rejections
// Sends them to content.js via window.postMessage

(function () {
  const SOURCE = 'faultline';

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
    } catch (_) {
      // swallow
    }
  }

  /* ---------------------------
   * Console interception
   * --------------------------- */
  ['error', 'warn'].forEach(level => {
    const original = console[level];
    console[level] = function (...args) {
      send({
        type: 'console',
        level,
        message: args.map(safeStringify).join(' ')
      });
      return original.apply(console, args);
    };
  });

  /* ---------------------------
   * Uncaught JS errors
   * --------------------------- */
  window.addEventListener('error', (e) => {
    send({
      type: 'console',
      level: 'error',
      message: `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`
    });
  });

  /* ---------------------------
   * Unhandled promise rejections
   * --------------------------- */
  window.addEventListener('unhandledrejection', (e) => {
    send({
      type: 'console',
      level: 'error',
      message: `UnhandledPromiseRejection: ${safeStringify(e.reason)}`
    });
  });

})();
