# Architecture

This document describes the high-level architecture, data flow, and key design
decisions for the Sentinel SF (Faultline) extension.

## Components

1) injected.js (page context)
- Runs inside the page, not the extension world.
- Intercepts:
  - `console.error` / `console.warn`
  - `window.onerror`
  - `unhandledrejection`
  - `fetch` and `XMLHttpRequest`
- Creates error payloads with:
  - error detail (best-effort)
  - request metadata (safe fields only)
  - response metadata (safe fields only)
  - recent user actions (metadata only)
- Posts events via `window.postMessage`.

2) content.js (content script)
- Runs in the extension isolated world.
- Injects `injected.js` into the page.
- Shows toast notifications immediately.
- Forwards events to the background using `chrome.runtime.sendMessage`.
- Maintains a small action buffer as a fallback.
- Can be globally paused by the popup toggle.

3) background (service worker, MV3)
- Single source of truth for persistence.
- Owns:
  - storage writes
  - badge updates
  - tab lifecycle cleanup
  - allowlist checks
  - webRequest fallback for status-only network errors
- Watches the global enable/disable toggle.

4) popup (UI)
- Reads from `chrome.storage.local`.
- Groups events by tab.
- Shows error detail, request/response summaries, and repro steps.
- Provides a global enable/disable toggle.

## Data Flow

### Page-Level Network Error

1. `injected.js` intercepts `fetch`/XHR.
2. Builds:
   - `detail` from response body (best effort)
   - `request` summary (method, content-type, size, fields)
   - `response` summary (content-type, size, fields)
3. Posts to `window`.
4. `content.js`:
   - shows toast
   - forwards to background as `type: "network-page"`.
5. `background/messages.js`:
   - validates the event schema
   - dedupes by url/status/time
   - removes any webRequest fallback duplicates
   - persists to storage
6. `popup.js` reads storage and renders.

### Page-Level Console Error

1. `injected.js` wraps `console.error` / `console.warn`.
2. Posts a `type: "console"` payload.
3. `content.js` shows a toast and forwards.
4. `background/messages.js` validates and persists.
5. `popup.js` renders by tab.

### webRequest Fallback Error

1. `background/network.js` listens to `onCompleted`.
2. If page capture is active for the tab, it is skipped.
3. If allowed and status >= 400, a minimal event is stored.

## Event Model

Stored events are a flat array in `chrome.storage.local.faultlineEvents`.
Each event includes:
- `kind` (network|console)
- `tabId` and `time`
- `actions` (recent user actions)
- optional `detail`, `request`, `response`

## Action Tracking

Actions are metadata-only and do not include input values.
Captured events:
- Clicks
- Form submits
- Enter/Escape key presses
- SPA navigation (history push/replace)

To prevent MV3 worker restarts from losing actions, the most recent action
buffer is persisted in `chrome.storage.local.faultlineLastActions`.

## Schema Validation and Deduplication

All writes pass a schema gate:
- required fields exist
- types are correct
- values are bounded

Network events are deduped by:
- kind
- url
- status
- time window (configurable)

## Enable/Disable Toggle

`chrome.storage.local.faultlineEnabled` controls all processing.
- content script ignores page events when disabled
- background ignores messages and webRequest when disabled
- popup lets users toggle the value

## Key Constraints

- MV3 service worker lifecycle: state is transient.
- webRequest cannot read response bodies; only status data is available.
- All payload data must be safe (no secrets, limited size).

## Extensibility Notes

Areas for future work:
- per-host allowlist editing in the popup
- export errors to a file or clipboard
- add client-side filters in the popup
- add rate-limits by host or endpoint

