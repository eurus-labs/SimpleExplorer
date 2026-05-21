// Direction A — Fluent Refined
// Win11 evolution: Mica-style chrome, single command bar, breadcrumb path,
// drag-resizable panes in a 1/2/3/4 grid. Each pane has tabs.
// Visuals trace explorer-fluent.jsx in the design bundle.

import { iconHTML } from '../icons.js';
import { renderRows, renderColumnHeader, renderBreadcrumb, getRecent, selectionSizeLabel, renderSearchBanner, showShellPickerMenu } from '../pane.js';
import { SIDEBAR_FULL } from '../sidebar-data.js';
import { applyLayout } from '../layout.js';
import { openPalette, isPaletteOpen } from '../palette.js';
import { ensurePreviewPanel, bindPreviewClose, showPreviewFor } from '../preview.js';
import { renderTree } from '../tree.js';

const LAYOUT_OPTS = [
  { id: '1',  icn: 'one',       title: 'Single' },
  { id: '2v', icn: 'split-h',   title: 'Side by side' },
  { id: '2h', icn: 'split-v',   title: 'Top / bottom' },
  { id: '3',  icn: 'workspace', title: 'Three' },
  { id: '4',  icn: 'grid4',     title: 'Four' },
];

export function renderFluent(root, ctx) {
  root.innerHTML = '';
  const app = el('div', 'a-app');

  app.appendChild(titleBar(ctx));
  app.appendChild(commandBar(ctx));

  const body = el('div', 'a-body');
  body.appendChild(sidebar(ctx));

  const grid = el('div', 'a-grid');
  const cards = ctx.panes.slice(0, ctx.layoutDef.panes).map((pane, i) => paneCard(ctx, pane, i));
  applyLayout(grid, ctx.layout, ctx.splits, cards, ctx.onSplitChange);

  body.appendChild(grid);
  if (ctx.previewOpen) {
    const previewWrap = el('div', 'a-preview-wrap');
    ensurePreviewPanel(previewWrap);
    bindPreviewClose(() => ctx.onPreviewToggle());
    body.appendChild(previewWrap);
    queueMicrotask(() => ctx.pushPreview?.(ctx.activePane));
  }
  app.appendChild(body);

  app.appendChild(statusBar(ctx));
  root.appendChild(app);
}

function titleBar(ctx) {
  const bar = el('div', 'a-titlebar');
  bar.dataset.dragRegion = '';
  const maxIcon = ctx.maximized ? '❐' : '☐';
  const maxTitle = ctx.maximized ? 'Restore' : 'Maximize';
  bar.innerHTML = `
    <div class="a-brand">
      <div class="a-brand__logo"></div>
      SimpleExplorer
    </div>
    <div class="spacer"></div>
    ${directionSwitcher(ctx)}
    <button class="iconbtn" data-act="theme" title="Toggle theme">
      ${iconHTML(ctx.theme === 'dark' ? 'sun' : 'moon')}
    </button>
    <div class="a-wincontrols">
      <span class="a-winctl" data-winctl="min" title="Minimize">─</span>
      <span class="a-winctl" data-winctl="max" title="${maxTitle}">${maxIcon}</span>
      <span class="a-winctl a-winctl--close" data-winctl="close" title="Close">✕</span>
    </div>
  `;
  bindClicks(bar, ctx);
  bindWinCtl(bar, ctx);
  // Double-click toggles max (Win11 convention). Skip if a button was the
  // target so the click doesn't double-fire with single-click maximize.
  bar.addEventListener('dblclick', (e) => {
    if (e.target.closest('.a-winctl, .iconbtn, .dir-switch')) return;
    ctx.onWinCtl('max');
  });
  return bar;
}

function commandBar(ctx) {
  const bar = el('div', 'a-cmdbar');
  bar.innerHTML = `
    <button class="iconbtn" data-nav="back" title="Back">${iconHTML('back')}</button>
    <button class="iconbtn" data-nav="fwd" title="Forward">${iconHTML('fwd')}</button>
    <button class="iconbtn" data-nav="up" title="Up">${iconHTML('up')}</button>
    <span class="a-sep"></span>
    <button class="cmdbtn" data-action="newfolder">${iconHTML('newfolder', 15)}<span>New</span></button>
    <button class="cmdbtn" data-action="copy">${iconHTML('copy', 15)}<span>Copy</span></button>
    <button class="cmdbtn" data-action="rename">${iconHTML('rename', 15)}<span>Rename</span></button>
    <button class="cmdbtn" data-action="delete">${iconHTML('trash', 15)}<span>Delete</span></button>
    <span class="a-sep"></span>
    <button class="cmdbtn" data-action="compare">${iconHTML('compare', 15)}<span>Compare</span></button>
    <div class="a-palette">
      ${iconHTML('search', 14)}
      <input data-palette class="palette-input" placeholder="Go to folder, search, or run a command" />
      <kbd>Ctrl K</kbd>
    </div>
    <div class="spacer"></div>
    <button class="iconbtn" data-shellpicker title="Open a terminal here">${iconHTML('terminal', 14)}</button>
    <button class="iconbtn ${ctx.previewOpen ? 'on' : ''}" data-act="previewToggle" title="Toggle preview pane (Ctrl+P)">${iconHTML('eye', 14)}</button>
    ${layoutPicker(ctx)}
    <span class="a-sep"></span>
    ${viewPicker(ctx)}
  `;
  bindClicks(bar, ctx);
  bindNav(bar, ctx);
  bindLayout(bar, ctx);
  bindView(bar, ctx);
  bindPalette(bar, ctx);
  return bar;
}

function sidebar(ctx) {
  const side = el('div', 'a-sidebar');
  // Mode tabs at the top: Quick access (existing) / Tree (Phase 7f).
  const tabBar = el('div', 'a-sidebar__tabs');
  const mode = ctx.sidebarMode || 'quick';
  ['quick', 'tree'].forEach((m) => {
    const b = el('button', 'a-sidebar__tab' + (mode === m ? ' a-sidebar__tab--on' : ''));
    b.textContent = m === 'quick' ? 'Quick access' : 'Tree';
    b.addEventListener('click', () => ctx.onSidebarModeChange(m));
    tabBar.appendChild(b);
  });
  side.appendChild(tabBar);

  if (mode === 'tree') {
    const treeWrap = el('div', 'a-sidebar__tree');
    const roots = (ctx.drives.length
      ? ctx.drives.map((d) => ({ label: d.name, path: d.path }))
      : [{ label: 'Home', path: ctx.home }]);
    renderTree(treeWrap, {
      roots,
      activePath: ctx.panes[ctx.activePane]?.path,
      onNavigate: (p) => ctx.onPaneNav(ctx.activePane, p),
    });
    side.appendChild(treeWrap);
    return side;
  }

  const body = el('div', 'a-sidebar__body');
  SIDEBAR_FULL.forEach((sec) => {
    const block = el('div', 'a-sidebar__block');
    const title = el('div', 'a-sidebar__title');
    title.textContent = sec.section;
    block.appendChild(title);
    sec.items.forEach((it) => {
      const row = el('div', 'a-sidebar__item');
      row.innerHTML = `${iconHTML(it.icon, 15)}<span>${it.name}</span>${it.meta ? `<small>${it.meta}</small>` : ''}`;
      const target = it.path || (it.key ? ctx.railTarget(it.key) : null);
      if (target) row.addEventListener('click', () => ctx.onPaneNav(ctx.activePane, target));
      block.appendChild(row);
    });
    body.appendChild(block);
  });

  if (ctx.drives.length) {
    const block = el('div', 'a-sidebar__block');
    block.innerHTML = `<div class="a-sidebar__title">Drives</div>`;
    ctx.drives.forEach((d) => {
      const row = el('div', 'a-sidebar__item');
      const meta = d.free_bytes ? `${freeLabelGB(d.free_bytes)} free` : '';
      row.innerHTML = `${iconHTML('drive', 15)}<span>${d.name}</span>${meta ? `<small>${meta}</small>` : ''}`;
      row.addEventListener('click', () => ctx.onPaneNav(ctx.activePane, d.path));
      block.appendChild(row);
    });
    body.appendChild(block);
  }

  const recent = getRecent();
  if (recent.length) {
    const block = el('div', 'a-sidebar__block');
    block.innerHTML = `<div class="a-sidebar__title">Recent</div>`;
    recent.slice(0, 5).forEach((p) => {
      const row = el('div', 'a-sidebar__item');
      row.innerHTML = `${iconHTML('clock', 15)}<span title="${p}">${shortPath(p)}</span>`;
      row.addEventListener('click', () => ctx.onPaneNav(ctx.activePane, p));
      block.appendChild(row);
    });
    body.appendChild(block);
  }
  side.appendChild(body);
  return side;
}

function paneCard(ctx, pane, i) {
  const card = el('div', 'a-pane' + (i === ctx.activePane ? ' a-pane--active' : ''));
  card.dataset.paneIdx = i;
  // Programmatic focus target. tabindex -1 keeps the card out of the
  // Tab order but lets us call card.focus() on click so explorer
  // shortcuts (F2 / Del / type-to-jump) start working immediately.
  card.tabIndex = -1;
  card.addEventListener('mousedown', () => {
    // Take focus on mousedown (before click) so any selection logic
    // runs after the focus change. preventScroll stops the WebView
    // from jump-scrolling on focus change.
    card.focus({ preventScroll: true });
  });
  card.addEventListener('click', () => ctx.setActivePane(i));

  card.appendChild(tabBar(ctx, pane, i));

  const crumbBar = el('div', 'a-crumbbar');
  crumbBar.appendChild(renderBreadcrumb(pane.path, (p) => ctx.onPaneNav(i, p)));
  card.appendChild(crumbBar);

  // Hide column header in tiles view — there are no columns to label.
  if (pane.view !== 'tiles') {
    const head = renderColumnHeader('a', {
      sort: pane.sort,
      onSort: (next) => ctx.onSortChange(i, next),
    });
    card.appendChild(head);
  }

  const banner = renderSearchBanner(pane, {
    onCancel: () => ctx.onCancelSearch(i),
    onClear: () => ctx.onClearSearch(i),
  });
  if (banner) card.appendChild(banner);

  const rows = renderRows(pane, {
    paneIdx: i,
    onActivate: (entry) => ctx.onActivateEntry(i, entry),
    onPaneActivate: () => ctx.setActivePane(i),
    onRename: (oldName, newName) => ctx.onRename(i, oldName, newName),
    onDrop: (srcIdx, names, op) => ctx.onDrop(srcIdx, i, names, op),
    onForeignDrop: (paths, op) => ctx.onForeignDrop(i, paths, op),
  });
  card.appendChild(rows);
  return card;
}

// Custom MIME type for cross-pane tab drags. Lets dragover ignore
// foreign payloads (Explorer files, internal row drags from pane.js)
// without inspecting their dataTransfer.types contents. Same idea as
// the DND_TYPE in pane.js but separate so a tab drag never collides
// with a row drag mid-flight.
const TAB_DND_TYPE = 'application/x-simpleexplorer-tab';

function tabBar(ctx, pane, paneIdx) {
  const bar = el('div', 'a-tabs');
  pane.tabs.forEach((tab, tabIdx) => {
    const tabEl = el('div', 'a-tab' + (tabIdx === pane.activeTabIdx ? ' a-tab--active' : ''));
    const label = tab.path.split(/[\\/]/).filter(Boolean).pop() || 'home';
    tabEl.innerHTML = `${iconHTML('folder', 13)}<span class="a-tab__label" title="${tab.path}">${label}</span>`;
    tabEl.addEventListener('click', (e) => {
      e.stopPropagation();
      ctx.setActivePane(paneIdx);
      if (tabIdx !== pane.activeTabIdx) ctx.onTabSwitch(paneIdx, tabIdx);
    });
    // Middle-click closes (Chrome / VS Code convention). preventDefault
    // suppresses WebView's auto-scroll cursor on middle button.
    tabEl.addEventListener('mousedown', (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      ctx.onTabClose(paneIdx, tabIdx);
    });
    // Cross-pane tab drag. Only enabled when this pane has more than
    // one tab — moving the only tab would leave the source empty,
    // which the close-last-tab policy already forbids.
    if (pane.tabs.length > 1) {
      tabEl.draggable = true;
      tabEl.addEventListener('dragstart', (e) => {
        e.stopPropagation();
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(TAB_DND_TYPE, JSON.stringify({ paneIdx, tabIdx }));
        tabEl.classList.add('a-tab--dragging');
      });
      tabEl.addEventListener('dragend', () => {
        tabEl.classList.remove('a-tab--dragging');
      });
      const close = el('span', 'a-tab__close');
      close.innerHTML = iconHTML('close', 11);
      close.title = 'Close tab';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        ctx.onTabClose(paneIdx, tabIdx);
      });
      tabEl.appendChild(close);
    }
    bar.appendChild(tabEl);
  });
  const plus = el('button', 'a-tab__plus');
  plus.innerHTML = iconHTML('plus', 12);
  plus.title = 'New tab';
  plus.addEventListener('click', (e) => {
    e.stopPropagation();
    ctx.setActivePane(paneIdx);
    ctx.onTabNew(paneIdx);
  });
  bar.appendChild(plus);

  // Drop target: another pane's tab bar receives a tab drag. dragenter
  // and dragover must both call preventDefault so the drop actually
  // fires; that's the standard HTML5-DnD gotcha. We use a depth counter
  // because entering a child element fires `dragleave` on the bar even
  // though the cursor is still inside, which would flicker the accent
  // ring otherwise.
  let dragDepth = 0;
  bar.addEventListener('dragenter', (e) => {
    if (!hasTabType(e.dataTransfer)) return;
    e.preventDefault();
    dragDepth += 1;
    bar.classList.add('a-tabs--drop');
  });
  bar.addEventListener('dragover', (e) => {
    if (!hasTabType(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });
  bar.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) bar.classList.remove('a-tabs--drop');
  });
  bar.addEventListener('drop', (e) => {
    dragDepth = 0;
    bar.classList.remove('a-tabs--drop');
    const raw = e.dataTransfer.getData(TAB_DND_TYPE);
    if (!raw) return;
    e.preventDefault();
    let payload;
    try { payload = JSON.parse(raw); } catch { return; }
    if (payload.paneIdx === paneIdx) return; // same-pane drop is a no-op (no reorder in v1)
    // Compute insertion index from cursor position relative to existing
    // tab elements. Drop before the tab whose horizontal midpoint is
    // right of the pointer; falls through to end-of-list when no tab
    // matches (cursor is past the rightmost tab).
    const tabEls = Array.from(bar.querySelectorAll('.a-tab'));
    let insertAt = tabEls.length;
    for (let i = 0; i < tabEls.length; i++) {
      const r = tabEls[i].getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) { insertAt = i; break; }
    }
    ctx.onTabMove(payload.paneIdx, payload.tabIdx, paneIdx, insertAt);
  });
  return bar;
}

function hasTabType(dt) {
  // dataTransfer.types is a DOMStringList during dragenter / dragover;
  // .includes() works on Array.from + Firefox's older list shape alike.
  return Array.from(dt?.types || []).includes(TAB_DND_TYPE);
}

export function statusBar(ctx) {
  const pane = ctx.panes[ctx.activePane];
  const bar = el('div', 'a-statusbar');
  const sizeLabel = selectionSizeLabel(pane);
  bar.innerHTML = `
    <span>Pane ${ctx.activePane + 1} · ${pane.entries.length} items · ${pane.selected.size} selected${sizeLabel ? ` · ${sizeLabel}` : ''}</span>
    <div class="spacer"></div>
    <span>${pane.path}</span>
  `;
  return bar;
}

function layoutPicker(ctx) {
  return `<div class="a-layout">${LAYOUT_OPTS.map((o) => `
    <button data-layout="${o.id}" title="${o.title}" class="${ctx.layout === o.id ? 'on' : ''}">${iconHTML(o.icn, 14)}</button>
  `).join('')}</div>`;
}

function directionSwitcher(ctx) {
  const opts = [
    { id: 'fluent', label: 'Fluent' },
    { id: 'cmd',    label: 'Cmd' },
  ];
  return `<div class="dir-switch">${opts.map((o) => `
    <button data-dir="${o.id}" class="${ctx.direction === o.id ? 'on' : ''}">${o.label}</button>
  `).join('')}</div>`;
}

function bindClicks(scope, ctx) {
  scope.querySelectorAll('[data-act]').forEach((el) =>
    el.addEventListener('click', () => ctx.onAction(el.dataset.act)));
  scope.querySelectorAll('[data-action]').forEach((el) =>
    el.addEventListener('click', () => ctx.onAction(el.dataset.action)));
  scope.querySelectorAll('[data-dir]').forEach((el) =>
    el.addEventListener('click', () => ctx.setDirection(el.dataset.dir)));
  scope.querySelectorAll('[data-shellpicker]').forEach((el) =>
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      showShellPickerMenu(el.getBoundingClientRect());
    }));
}

function bindWinCtl(scope, ctx) {
  scope.querySelectorAll('[data-winctl]').forEach((el) =>
    el.addEventListener('click', (e) => { e.stopPropagation(); ctx.onWinCtl(el.dataset.winctl); }));
}

function bindNav(scope, ctx) {
  scope.querySelectorAll('[data-nav]').forEach((el) => el.addEventListener('click', () => {
    if (el.dataset.nav === 'back') ctx.onPaneBack(ctx.activePane);
    else if (el.dataset.nav === 'fwd') ctx.onPaneForward(ctx.activePane);
    else if (el.dataset.nav === 'up') ctx.onPaneUp(ctx.activePane);
  }));
}

const VIEW_OPTS = [
  { id: 'details', icn: 'view-details', title: 'Details' },
  { id: 'compact', icn: 'view-compact', title: 'Compact' },
  { id: 'tiles',   icn: 'view-tiles',   title: 'Tiles' },
];

function viewPicker(ctx) {
  const view = ctx.panes[ctx.activePane].view || 'details';
  return `<div class="a-view">${VIEW_OPTS.map((o) => `
    <button data-view="${o.id}" title="${o.title}" class="${view === o.id ? 'on' : ''}">${iconHTML(o.icn, 14)}</button>
  `).join('')}</div>`;
}

function bindView(scope, ctx) {
  scope.querySelectorAll('[data-view]').forEach((el) =>
    el.addEventListener('click', () => ctx.onViewChange(ctx.activePane, el.dataset.view)));
}

function bindLayout(scope, ctx) {
  scope.querySelectorAll('[data-layout]').forEach((el) =>
    el.addEventListener('click', () => ctx.setLayout(el.dataset.layout)));
}

// Palette anchor — focus opens the overlay below this input. Same shape
// as Cmd's bindPalette; the global Ctrl+K / Ctrl+L handler in app.js
// finds the input via the shared `.palette-input` class.
function bindPalette(scope, ctx) {
  const input = scope.querySelector('[data-palette]');
  if (!input) return;
  const open = () => openPalette({
    anchor: input,
    input,
    ctx,
    getPane: () => ctx.panes[ctx.activePane],
    onClose: () => { input.value = ''; },
  });
  input.addEventListener('focus', () => { if (!isPaletteOpen()) open(); });
  input.addEventListener('input', () => { if (input.value && !isPaletteOpen()) open(); });
}

function freeLabelGB(bytes) {
  const gb = bytes / 1073741824;
  return gb >= 100 ? Math.round(gb) + ' GB' : gb.toFixed(1) + ' GB';
}

function shortPath(p) {
  if (!p) return '';
  if (p.length < 32) return p;
  return '…' + p.slice(-30);
}

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
