const listEl = document.getElementById('list');
const clearBtn = document.getElementById('clear');

let activeTabId = null;
let didAutoScroll = false;

// UI-only state (popup lifetime)
const collapsedTabs = {}; // tabId -> boolean
const payloadOpenByEvent = {}; // eventKey -> boolean
const responseOpenByEvent = {}; // eventKey -> boolean

/* -------------------------
 * Helpers
 * ------------------------- */
function formatMs(ms) {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function detectActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });
  activeTabId = tab?.id ?? null;
}

async function getTabsMap() {
  const tabs = await chrome.tabs.query({});
  const map = {};
  tabs.forEach(t => {
    map[t.id] = {
      title: t.title || '(no title)',
      favIconUrl: t.favIconUrl
    };
  });
  return map;
}

function groupByTab(events) {
  return events.reduce((acc, e) => {
    if (!acc[e.tabId]) acc[e.tabId] = [];
    acc[e.tabId].push(e);
    return acc;
  }, {});
}

function getClosedTabsInfo() {
  return new Promise(res => {
    chrome.runtime.sendMessage(
      { type: 'get-closed-tabs' },
      res
    );
  });
}

function formatDelta(ms) {
  if (ms < 0) return '';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function getEventKey(item) {
  return `${item.kind}|${item.status}|${item.url}|${item.time}`;
}

function trimObject(value, maxKeys, maxString) {
  if (Array.isArray(value)) {
    return value.slice(0, maxKeys).map((item) =>
      trimObject(item, maxKeys, maxString)
    );
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).slice(0, maxKeys);
    const trimmed = {};
    entries.forEach(([k, v]) => {
      trimmed[k] = trimObject(v, maxKeys, maxString);
    });
    return trimmed;
  }
  if (typeof value === 'string') {
    return value.length > maxString
      ? `${value.slice(0, maxString)}...`
      : value;
  }
  return value;
}

function normalizeFieldValue(value, maxKeys, maxString) {
  if (typeof value === 'string') {
    let current = value.trim();
    for (let i = 0; i < 2; i += 1) {
      if (!(current.startsWith('{') || current.startsWith('['))) {
        break;
      }
      try {
        const parsed = JSON.parse(current);
        if (typeof parsed === 'string') {
          current = parsed.trim();
          continue;
        }
        return trimObject(parsed, maxKeys, maxString);
      } catch {
        break;
      }
    }
  }
  return trimObject(value, maxKeys, maxString);
}

function buildPrettyPayload(fields, maxKeys, maxString) {
  const trimmed = {};
  fields.slice(0, maxKeys).forEach(([key, value]) => {
    trimmed[key] = normalizeFieldValue(value, maxKeys, maxString);
  });
  return JSON.stringify(trimmed, null, 2);
}

function formatRequestInfo(request) {
  if (!request || typeof request !== 'object') return null;

  const parts = [];
  if (request.method) parts.push(request.method);
  if (request.contentType) parts.push(request.contentType);
  if (Number.isFinite(request.size)) {
    parts.push(`${request.size} bytes`);
  }

  return parts.join(' • ');
}

function formatResponseInfo(response) {
  if (!response || typeof response !== 'object') return null;

  const parts = [];
  if (response.contentType) parts.push(response.contentType);
  if (Number.isFinite(response.size)) {
    parts.push(`${response.size} bytes`);
  }

  return parts.join(' ƒ?› ');
}

function renderDetailsSection(options) {
  const {
    title,
    fields,
    eventKey,
    openState,
    maxKeys,
    maxString,
    parent
  } = options;

  if (!fields || typeof fields !== 'object') return;
  const entries = Object.entries(fields);
  if (!entries.length) return;

  const details = document.createElement('details');
  details.style.marginTop = '6px';
  details.open = Boolean(openState[eventKey]);
  details.addEventListener('toggle', () => {
    openState[eventKey] = details.open;
  });

  const summary = document.createElement('summary');
  summary.textContent =
    entries.length > maxKeys
      ? `${title} (${maxKeys} of ${entries.length} keys)`
      : title;
  summary.style.cursor = 'pointer';
  summary.style.color = '#9cdcfe';
  summary.style.fontSize = '12px';
  details.appendChild(summary);

  const body = document.createElement('pre');
  body.className = 'meta';
  body.style.color = '#9cdcfe';
  body.style.marginTop = '4px';
  body.style.whiteSpace = 'pre-wrap';
  body.textContent = buildPrettyPayload(entries, maxKeys, maxString);

  details.appendChild(body);
  parent.appendChild(details);
}

function renderPayloadDetails(request, parent, eventKey) {
  if (!request || typeof request !== 'object') return;
  if (!request.fields || typeof request.fields !== 'object') return;
  if (!request.method || request.method.toUpperCase() === 'GET') return;

  renderDetailsSection({
    title: 'Payload details',
    fields: request.fields,
    eventKey,
    openState: payloadOpenByEvent,
    maxKeys: 6,
    maxString: 160,
    parent
  });
}

function renderResponseDetails(response, parent, eventKey) {
  if (!response || typeof response !== 'object') return;
  if (!response.fields || typeof response.fields !== 'object') return;

  renderDetailsSection({
    title: 'Response details',
    fields: response.fields,
    eventKey,
    openState: responseOpenByEvent,
    maxKeys: 6,
    maxString: 160,
    parent
  });
}

/* -------------------------
 * Render
 * ------------------------- */
function render(groups, tabsMap, closedInfo) {
  listEl.innerHTML = '';

  const tabIds = Object.keys(groups);
  if (tabIds.length === 0) {
    listEl.innerHTML =
      '<div style="color:#777;font-size:12px">No errors yet</div>';
    return;
  }

  tabIds.forEach(tabId => {
    if (!(tabId in collapsedTabs)) {
      // collapsed by default, but auto-expand active tab
      collapsedTabs[tabId] = Number(tabId) !== activeTabId;
    }

    const isCollapsed = collapsedTabs[tabId];
    const tabInfo = tabsMap[tabId];
    const isClosed = !tabInfo;
    const remainingMs = closedInfo?.[tabId];
    const isActive = Number(tabId) === activeTabId;

    /* ---------- Header ---------- */
    const header = document.createElement('div');
    header.dataset.tabId = tabId;

    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.justifyContent = 'space-between';
    header.style.cursor = 'pointer';
    header.style.margin = '10px 0 4px';
    header.style.padding = '4px 6px';
    header.style.fontWeight = 'bold';
    header.style.fontSize = '12px';
    header.style.borderRadius = '4px';

    if (isActive) {
      header.style.color = '#ffffff';
      header.style.background = 'rgba(88,166,255,0.12)';
      header.style.borderLeft = '3px solid #58a6ff';
    } else {
      header.style.color = isClosed ? '#c586c0' : '#9cdcfe';
    }

    const left = document.createElement('div');
    left.style.display = 'flex';
    left.style.alignItems = 'center';

    const caret = document.createElement('span');
    caret.textContent = isCollapsed ? '▶' : '▼';
    caret.style.marginRight = '6px';
    left.appendChild(caret);

    if (!isClosed && tabInfo.favIconUrl) {
      const icon = document.createElement('img');
      icon.src = tabInfo.favIconUrl;
      icon.style.width = '14px';
      icon.style.height = '14px';
      icon.style.marginRight = '6px';
      left.appendChild(icon);
    }

    let title = isClosed ? 'Closed tab' : tabInfo.title;
    if (isClosed && remainingMs > 0) {
      title += ` (auto-clean in ${formatMs(remainingMs)})`;
    }

    left.appendChild(document.createTextNode(title));

    const clearBtnTab = document.createElement('button');
    clearBtnTab.textContent = '✕';
    clearBtnTab.title = 'Clear this tab';
    clearBtnTab.style.background = 'transparent';
    clearBtnTab.style.border = 'none';
    clearBtnTab.style.color = '#aaa';
    clearBtnTab.style.cursor = 'pointer';
    clearBtnTab.style.fontSize = '14px';
    clearBtnTab.style.padding = '0 4px';

    clearBtnTab.onclick = (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({
        type: 'clear-tab-events',
        tabId: Number(tabId)
      });
      delete collapsedTabs[tabId];
      loadAndRender();
    };

    header.onclick = () => {
      collapsedTabs[tabId] = !collapsedTabs[tabId];
      loadAndRender();
    };

    header.appendChild(left);
    header.appendChild(clearBtnTab);
    listEl.appendChild(header);

    // Auto-scroll active tab into view ONCE
    if (isActive && !didAutoScroll) {
      requestAnimationFrame(() => {
        header.scrollIntoView({ block: 'nearest' });
      });
      didAutoScroll = true;
    }

    if (isCollapsed) return;
    const hasNetworkErrors = groups[tabId].some(
      (e) => e.kind === 'network'
    );
    /* ---------- Events ---------- */
    groups[tabId].slice().reverse().forEach(item => {
      // 🚫 Skip console errors if network errors exist
      if (hasNetworkErrors && item.kind === 'console') {
        return;
      }
      // continue rendering
      const div = document.createElement('div');
      div.className = 'item';

      const type = document.createElement('div');
      type.className =
        'type ' + (item.kind === 'console' ? 'error' : 'network');
      type.textContent =
        item.kind === 'console'
          ? `Console ${item.level}`
          : `HTTP ${item.status}`;

      const msg = document.createElement('div');
      msg.textContent =
        item.detail
          ? `${item.url} (${item.status}) — ${item.detail}`
          : item.url;

      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = new Date(item.time).toLocaleTimeString();

      div.appendChild(type);
      div.appendChild(msg);
      div.appendChild(meta);

      const requestInfo = formatRequestInfo(item.request);
      if (requestInfo) {
        const requestMeta = document.createElement('div');
        requestMeta.className = 'meta';
        requestMeta.style.color = '#9cdcfe';
        requestMeta.textContent = requestInfo;
        div.appendChild(requestMeta);
      }

      const responseInfo = formatResponseInfo(item.response);
      if (responseInfo) {
        const responseMeta = document.createElement('div');
        responseMeta.className = 'meta';
        responseMeta.style.color = '#9cdcfe';
        responseMeta.textContent = responseInfo;
        div.appendChild(responseMeta);
      }

      const eventKey = getEventKey(item);
      renderPayloadDetails(item.request, div, eventKey);
      renderResponseDetails(item.response, div, eventKey);

      if (item.actions && item.actions.length) {
        const wrapper = document.createElement('div');
        wrapper.className = 'meta';
        wrapper.style.color = '#6a9955';
        wrapper.style.marginTop = '6px';

        const title = document.createElement('div');
        title.textContent = 'Reproduction steps:';
        title.style.marginBottom = '2px';
        wrapper.appendChild(title);

        item.actions.forEach((a, i) => {
          const prev = item.actions[i - 1];
          const delta = prev
            ? a.time - prev.time
            : item.time - a.time;

          const label = prev
            ? `+${formatDelta(delta)}`
            : `error in ${formatDelta(delta)}`;

          const step = document.createElement('div');
          step.textContent =
            `${i + 1}. ${a.type}: ${a.label}  (${label})`;

          wrapper.appendChild(step);
        });

        div.appendChild(wrapper);
      }

      listEl.appendChild(div);
    });
  });
}

/* -------------------------
 * Load & Live updates
 * ------------------------- */
async function loadAndRender() {
  const [tabsMap, data, closedInfo] = await Promise.all([
    getTabsMap(),
    new Promise(res =>
      chrome.storage.local.get({ faultlineEvents: [] }, res)
    ),
    getClosedTabsInfo()
  ]);

  const groups = groupByTab(data.faultlineEvents || []);
  render(groups, tabsMap, closedInfo || {});
}

// Init
(async function init() {
  await detectActiveTab();
  loadAndRender();
})();

// Refresh countdown while popup open
const interval = setInterval(loadAndRender, 1000);
window.addEventListener('unload', () => clearInterval(interval));

// Clear current tab only (top button, if present)
if (clearBtn) {
  clearBtn.onclick = () => {
    chrome.runtime.sendMessage({ type: 'clear-events' });
    loadAndRender();
  };
}

// Live updates from background
chrome.runtime.onMessage.addListener(msg => {
  if (msg.__FAULTLINE_EVENT__) {
    loadAndRender();
  }
});
