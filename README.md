# Sentinel SF (Faultline)

Sentinel SF is a Manifest V3 Chrome extension that captures frontend errors
(console + network), stores them locally, and renders a per-tab error history
in a popup. It is designed to help reproduce issues by collecting recent user
actions, minimal request/response context, and error details.

This repository contains:
- A page-context injector that hooks `console`, `fetch`, and XHR.
- A content script that forwards events to the background and shows toasts.
- A background service worker that persists events and updates the badge.
- A popup UI that renders the event history with repro steps.

## Quick Start

1. Open Chrome and go to `chrome://extensions/`.
2. Enable "Developer mode".
3. Click "Load unpacked" and select this folder.
4. Reload any target page to inject the page script.

## Runtime Toggle

The popup has an "Enabled" checkbox that pauses all capture and storage.
When disabled:
- No toasts are shown.
- Content script ignores page events.
- Background ignores webRequest and message events.

The toggle is stored in `chrome.storage.local.faultlineEnabled`.

## What Is Captured

### Console errors (page context)
- `console.error` and `console.warn`
- `window.onerror`
- `unhandledrejection`

### Network errors (page context)
- `fetch` responses with `status >= 400`
- XHR responses with `status >= 400`

Network event payloads include:
- `status`, `url`, `detail` (best-effort)
- `request` summary (method, content-type, size, fields)
- `response` summary (content-type, size, fields)

### Network fallback (background)
`chrome.webRequest.onCompleted` captures HTTP errors if page capture is not
available. Fallback does not include response body.

### User actions (page context)
Recent actions are captured to help reproduce errors:
- `click`, `submit`
- `Enter` / `Escape` keydown
- Simple SPA navigation (history APIs)

Only metadata is captured (no input values). A rolling buffer is kept.

## Storage Shape

`chrome.storage.local.faultlineEvents` is a flat array:
```
[
  {
    kind: "network" | "console",
    status?,        // number or "FAIL"
    url?,
    detail?,
    message?,
    level?,
    request?: {
      method,
      contentType,
      size,
      fields
    },
    response?: {
      contentType,
      size,
      fields
    },
    actions: [],
    tabId,
    time
  }
]
```

## Files

Core files:
- `injected.js`     Page-context hooks and payload shaping
- `content.js`      Toasts + forwarding to background
- `background/`     Service worker modules
- `popup.html`      Popup markup
- `popup.js`        Popup rendering logic

Background modules:
- `background/main.js`       Module entrypoint
- `background/config.js`     Constants and limits
- `background/state.js`      In-memory state
- `background/messages.js`   Runtime message handlers
- `background/network.js`    webRequest fallback listeners
- `background/storage.js`    Persistence and cleanup
- `background/allowlist.js`  Host allowlist logic
- `background/badge.js`      Badge updates
- `background/lifecycle.js`  Tab lifecycle wiring

## Flow (Text)

```
Page (injected.js)
  |  console/fetch/xhr
  v
window.postMessage
  |
  v
Content Script (content.js)
  |  toast + forward
  v
Background (service worker)
  |  validate + dedupe + persist
  v
chrome.storage.local
  |
  v
Popup (popup.js)
  |  render + toggle
```

## Security & Privacy

- Sensitive keys and values are redacted (tokens, auth, cookies, etc).
- Payloads are trimmed (limited keys, limited value length).
- Response parsing is best-effort and size-limited.
- No input values are captured from user events.

## Troubleshooting

If you do not see events:
- Ensure the extension is enabled in the popup.
- Reload the page after installing or updating.
- Check the allow list for the target host.
- Open the popup and watch for new errors.

If you see missing details:
- webRequest fallback cannot read response bodies.
- Page capture must be active; reload the page.

## Development Notes

- MV3 service worker can unload; action tracking is persisted to storage to
  avoid losing repro steps between restarts.
- Deduplication collapses identical network events within a short window.
