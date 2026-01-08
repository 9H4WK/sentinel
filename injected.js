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

  const MAX_FIELD_COUNT = 20;
  const MAX_VALUE_LENGTH = 200;
  const MAX_BODY_PARSE_CHARS = 5000;
  const SENSITIVE_KEY_RE =
    /pass(word)?|token|secret|auth|authorization|cookie|session|jwt|api[-_]?key|csrf|xsrf|credit|card|cc|ssn|bearer/i;

  function truncateString(value, max) {
    if (typeof value !== 'string') return value;
    if (value.length <= max) return value;
    return value.slice(0, max) + '...';
  }

  function getHeaderValue(headers, name) {
    if (!headers) return null;
    const target = name.toLowerCase();
    try {
      if (headers instanceof Headers) {
        return headers.get(name);
      }
    } catch {}

    if (Array.isArray(headers)) {
      for (const pair of headers) {
        if (!pair || pair.length < 2) continue;
        const key = String(pair[0]).toLowerCase();
        if (key === target) return String(pair[1]);
      }
    }

    if (typeof headers === 'object') {
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === target) {
          return String(headers[key]);
        }
      }
    }

    return null;
  }

  function inferContentType(body) {
    if (!body) return null;
    if (body instanceof URLSearchParams) {
      return 'application/x-www-form-urlencoded';
    }
    if (body instanceof FormData) {
      return 'multipart/form-data';
    }
    if (body instanceof Blob) {
      return body.type || null;
    }
    if (typeof body === 'object' && !(body instanceof Blob)) {
      return 'application/json';
    }
    if (typeof body === 'string') {
      return 'text/plain';
    }
    return null;
  }

  function estimateBodySize(body) {
    try {
      if (body == null) return 0;
      if (typeof body?.getReader === 'function') return null;
      if (typeof body === 'string') return body.length;
      if (body instanceof URLSearchParams) return body.toString().length;
      if (body instanceof Blob) return body.size;
      if (body instanceof ArrayBuffer) return body.byteLength;
      if (ArrayBuffer.isView(body)) return body.byteLength;
      if (body instanceof FormData) {
        let total = 0;
        for (const [, v] of body.entries()) {
          if (typeof v === 'string') total += v.length;
          else if (v instanceof Blob) total += v.size;
        }
        return total;
      }
      if (typeof body === 'object') {
        const json = JSON.stringify(body);
        return json.length;
      }
    } catch {}
    return null;
  }

  function looksSensitiveValue(value) {
    if (typeof value !== 'string') return false;
    if (/^Bearer\s+/i.test(value)) return true;
    if (/^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/.test(value)) {
      return true;
    }
    if (/^[A-Za-z0-9-_]{20,}$/.test(value)) return true;
    if (/^[A-Za-z0-9+/=]{32,}$/.test(value)) return true;
    return false;
  }

  function sanitizeEntries(entries) {
    const result = {};
    let count = 0;
    for (const [rawKey, rawValue] of entries) {
      if (count >= MAX_FIELD_COUNT) break;
      const key = truncateString(String(rawKey), 80);

      let value;
      if (SENSITIVE_KEY_RE.test(key)) {
        value = '[redacted]';
      } else if (rawValue == null) {
        value = String(rawValue);
      } else if (typeof rawValue === 'string') {
        value = looksSensitiveValue(rawValue)
          ? '[redacted]'
          : truncateString(rawValue, MAX_VALUE_LENGTH);
      } else if (
        typeof rawValue === 'number' ||
        typeof rawValue === 'boolean'
      ) {
        value = rawValue;
      } else if (rawValue instanceof File || rawValue instanceof Blob) {
        const typeLabel = rawValue.type ? rawValue.type : 'file';
        value = `[${typeLabel} ${rawValue.size || 0}b]`;
      } else if (Array.isArray(rawValue)) {
        value = `[array:${rawValue.length}]`;
      } else if (typeof rawValue === 'object') {
        value = truncateString(safeStringify(rawValue), MAX_VALUE_LENGTH);
      } else {
        value = truncateString(String(rawValue), MAX_VALUE_LENGTH);
      }

      result[key] = value;
      count += 1;
    }
    return result;
  }

  function extractFieldsFromBody(body, contentType) {
    try {
      if (body == null) return null;
      if (typeof body?.getReader === 'function') return null;

      if (body instanceof URLSearchParams) {
        return sanitizeEntries(body.entries());
      }

      if (body instanceof FormData) {
        return sanitizeEntries(body.entries());
      }

      if (typeof body === 'string') {
        const text = body;
        if (text.length > MAX_BODY_PARSE_CHARS) {
          return null;
        }
        const isJson =
          contentType?.includes('application/json') ||
          text.trim().startsWith('{') ||
          text.trim().startsWith('[');
        if (isJson) {
          const parsed = JSON.parse(text);
          if (Array.isArray(parsed)) {
            return { _arrayLength: parsed.length };
          }
          if (parsed && typeof parsed === 'object') {
            return sanitizeEntries(Object.entries(parsed));
          }
        }
        return null;
      }

      if (typeof body === 'object') {
        if (Array.isArray(body)) {
          return { _arrayLength: body.length };
        }
        return sanitizeEntries(Object.entries(body));
      }
    } catch {}

    return null;
  }

  function buildRequestInfo(method, headers, body) {
    const contentType =
      getHeaderValue(headers, 'content-type') || inferContentType(body);
    return {
      method: method || 'GET',
      contentType: contentType || null,
      size: estimateBodySize(body),
      fields: extractFieldsFromBody(body, contentType)
    };
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
    let requestInfo = null;
    try {
      const input = args[0];
      const init = args[1] || {};
      const method = (init && init.method) ||
        (input && input.method) ||
        'GET';
      const headers = (init && init.headers) ||
        (input && input.headers) ||
        null;
      const body = (init && init.body) || null;
      requestInfo = buildRequestInfo(method, headers, body);
    } catch {}

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
          request: requestInfo,
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
  const setRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__faultline = { method, url };
    return open.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      if (!this.__faultline) this.__faultline = {};
      const key = String(name || '').toLowerCase();
      const headers = this.__faultline.headers || {};
      headers[key] = String(value);
      this.__faultline.headers = headers;
    } catch {}

    return setRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    try {
      const meta = this.__faultline || {};
      const method = meta.method || 'GET';
      const headers = meta.headers || null;
      const body = arguments[0];
      meta.request = buildRequestInfo(method, headers, body);
      this.__faultline = meta;
    } catch {}

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
            request: this.__faultline?.request || null,
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
