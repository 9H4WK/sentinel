const listEl = document.getElementById('list');
const clearBtn = document.getElementById('clear');

let activeTabId = null;
let didAutoScroll = false;

// UI-only state (popup lifetime)
const collapsedTabs = {}; // tabId -> boolean

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
