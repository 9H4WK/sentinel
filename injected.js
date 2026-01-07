// injected.js
// Runs in PAGE context
// Intercepts console errors + JS errors
// Tracks last user action
// Sends structured events to content.js via window.postMessage

// How many user actions we keep in memory
const MAX_ACTION_BUFFER = 10;
// How many actions to attach to each error
const ACTIONS_PER_ERROR = 5;

(function () {
  const SOURCE = 'faultline';

  /* --------------------------------
   * Utilities
   * -------------------------------- */
  function safeStringify(val) {
    try {
      // Real Error object
      if (val instanceof Error) {
        return `${val.name}: ${val.message}`;
      }

      // Error-like object (Angular / Zone / Axios, etc.)
      if (
        val &&
        typeof val === 'object' &&
        ('message' in val || 'stack' in val)
      ) {
        const name = val.name || 'Error';
        const msg = val.message || '';
        return `${name}: ${msg}`;
      }

      // String
      if (typeof val === 'string') {
        return val;
      }

      // Primitive
      if (typeof val !== 'object') {
        return String(val);
      }

      // Plain object (limit size)
      const json = JSON.stringify(val);
      return json === '{}' ? '[object]' : json;
    } catch {
      return '[unserializable]';
    }
  }

  /* --------------------------------
   * User action tracking
   * -------------------------------- */
  const __faultlineActions = [];
  const MAX_ACTIONS = MAX_ACTION_BUFFER;

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
    if (!el) return 'unknown';

    // 1️⃣ Climb to the nearest actionable element
    const target =
      el.closest?.(
        'button, a, [role="button"], input, select, textarea'
      ) || el;

    // 2️⃣ aria-label (best)
    const ariaLabel = target.getAttribute?.('aria-label');
    if (ariaLabel) return ariaLabel.trim();

    // 3️⃣ aria-labelledby
    const labelledBy = target.getAttribute?.('aria-labelledby');
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl?.textContent) {
        return labelEl.textContent.trim();
      }
    }

    // 4️⃣ Visible text (handles normal buttons)
    const text = target.textContent?.trim();
    if (text && text.length > 0) {
      return text.slice(0, 50);
    }

    // 5️⃣ Title attribute
    const title = target.getAttribute?.('title');
    if (title) return title.trim();

    // 6️⃣ data-testid / data-test
    const testId =
      target.getAttribute?.('data-testid') ||
      target.getAttribute?.('data-test');
    if (testId) return testId;

    // 7️⃣ Intelligent class-name inference (VERY IMPORTANT)
    if (target.classList?.length) {
      const meaningful = [...target.classList].filter(
        c =>
          !/^ng-/.test(c) &&
          !/^_ngcontent/.test(c) &&
          !/^(btn|button|active|disabled|show|open|dropdown|toggle)$/.test(c)
      );

      if (meaningful.length) {
        return meaningful.slice(0, 2).join('.');
      }
    }

    // 8️⃣ Icon-only button inference (ellipsis, kebab, etc.)
    const icon = target.querySelector?.('i, svg');
    if (icon) {
      const iconClass = icon.className || '';
      if (/ellipsis|kebab|dots|menu/i.test(iconClass)) {
        return 'Settings (ellipsis)';
      }
      if (/cog|gear/i.test(iconClass)) {
        return 'Settings';
      }
    }

    // 9️⃣ Final fallback
    return `<${target.tagName.toLowerCase()}>`;
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

  function send(payload) {
    try {
      window.postMessage(
        {
          source: 'faultline',
          payload
        },
        '*'
      );
    } catch {
      // swallow – never break the page
    }
  }

  /* --------------------------------
   * Console interception
   * -------------------------------- */
['error', 'warn'].forEach((level) => {
  const original = console[level];

  console[level] = function (...args) {
    try {
      const message = args
        .map((a) => {
          try {
            return safeStringify(a);
          } catch {
            return '';
          }
        })
        .join(' ');

      // 🚫 IGNORE Angular / HttpClient network spam
      if (
        /Http failure response for .*:\s*\d+/i.test(message) ||
        /HttpErrorResponse/i.test(message)
      ) {
        return original.apply(console, args);
      }

      const stack = new Error().stack;

      const actions =
        Array.isArray(__faultlineActions)
          ? __faultlineActions.slice(-ACTIONS_PER_ERROR)
          : [];

      if (typeof send === 'function') {
        send({
          type: 'console',
          level,
          message,
          stack,
          actions
        });
      }
    } catch {
      // never break console
    }

    return original.apply(console, args);
  };
});

  
(function interceptFetch() {
  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const res = await originalFetch.apply(this, args);

    try {
      if (!res.ok) {
        const clone = res.clone();
        const text = await clone.text();

        let detail = text;
        try {
          const json = JSON.parse(text);
          if (json?.detail) detail = json.detail;
          else if (json?.title) detail = json.title;
        } catch {}

        send({
          type: 'network',
          status: res.status,
          url: res.url,
          detail: String(detail).slice(0, 500),
          actions: __faultlineActions.slice(-ACTIONS_PER_ERROR),
          time: Date.now()
        });
      }
    } catch {
      // never break fetch
    }

    return res;
  };
})();

(function interceptXHR() {
  const open = XMLHttpRequest.prototype.open;
  const sendXHR = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__faultline = { method, url };
    return open.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', () => {
      try {
        if (this.status >= 400) {
          let detail = this.responseText || '';

          // Try to extract meaningful error message
          try {
            const json = JSON.parse(this.responseText);
            if (json?.detail) {
              detail = json.detail;
            } else if (json?.title) {
              detail = json.title;
            }
          } catch {
            // non-JSON response, keep raw text
          }

          send({
            type: 'network',
            status: this.status,
            url: this.responseURL,
            detail: detail,
            message: `${this.responseURL} (${this.status})`,
            actions: __faultlineActions.slice(-ACTIONS_PER_ERROR),
            time: Date.now()
          });
        }
      } catch {
        // never break XHR
      }
    });

    return sendXHR.apply(this, arguments);
  };
})();


  /* --------------------------------
   * Uncaught JS errors
   * -------------------------------- */
  window.addEventListener('error', (e) => {
    send({
      type: 'console',
      level: 'error',
      message: e.message,
      stack: e.error?.stack || null,
      actions: __faultlineActions.slice(-ACTIONS_PER_ERROR)
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
      actions: __faultlineActions.slice(-ACTIONS_PER_ERROR)
    });
  });
})();
