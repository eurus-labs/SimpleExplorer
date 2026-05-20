// Top-level app. Owns the active direction, theme/layout per direction, and
// the array of pane states. Each direction module exports a render(root, ctx)
// that paints the chrome around the panes.

import * as fs from './fs.js';
import { createPaneState, navigate, goBack, goForward, goUp, loadPath, tabNew, tabClose, tabSwitch, tabSnapshot, sortedEntries, selectAll, moveSelectionByDelta, moveSelectionToBoundary } from './pane.js';
import { renderFluent, statusBar as fluentStatusBar } from './directions/fluent.js';
import { renderCmd } from './directions/cmd.js';
import { LAYOUT_DEFS, DEFAULT_SPLITS } from './layout.js';
import { openPalette, isPaletteOpen } from './palette.js';
import { recursiveSearch } from './search.js';
import { ensurePreviewPanel, bindPreviewClose, showPreviewFor } from './preview.js';
import { runTransfer } from './transfer.js';
import * as modal from './modal.js';

// Boot the Neutralino client. Safe to call before DOM ready; APIs queue until
// the runtime handshake completes. No-op when running directly in a browser
// (mock mode), where window.Neutralino is undefined.
if (window.Neutralino) {
  try {
    window.Neutralino.init();
    window.Neutralino.events.on('windowClose', () => window.Neutralino.app.exit());
  } catch (e) {
    console.warn('Neutralino.init failed:', e);
  }
}

// Mica needs Win11 22H2+ (build 22621). On older builds we fall back to a
// flat acrylic backdrop. The detection result toggles a [data-mica] on the
// root element which CSS reads.
async function readInitialMaximizedState() {
  const N = window.Neutralino;
  if (!N || !N.window || !N.window.isMaximized) return;
  try { windowMaximized = await N.window.isMaximized(); }
  catch { /* leave default */ }
}

async function detectBackdropCapability() {
  const N = window.Neutralino;
  if (!N || !N.computer || !N.computer.getOSInfo) {
    document.documentElement.dataset.mica = 'fallback';
    return;
  }
  try {
    const info = await N.computer.getOSInfo();
    // Neutralino exposes `name`, `description`, `version` (e.g. "10.0.22621").
    const m = (info.version || '').match(/(\d+)\.(\d+)\.(\d+)/);
    const build = m ? parseInt(m[3], 10) : 0;
    const isMicaCapable = /windows/i.test(info.name || '') && build >= 22621;
    document.documentElement.dataset.mica = isMicaCapable ? 'on' : 'fallback';
  } catch {
    document.documentElement.dataset.mica = 'fallback';
  }
}

const STATE_KEY = 'simple-explorer.state';
const TABS_KEY = 'simple-explorer.tabs';
const DEFAULT = {
  direction: 'fluent',
  themeA: 'light', layoutA: '2v',
  themeB: 'light', layoutB: '2v',
  splits: { ...DEFAULT_SPLITS },
  cmdRailOpen: 'recent',
  previewOpen: false,
  sidebarMode: 'quick',
};

const RENDERERS = {
  fluent: { fn: renderFluent, themeKey: 'themeA', layoutKey: 'layoutA' },
  cmd:    { fn: renderCmd,    themeKey: 'themeB', layoutKey: 'layoutB' },
};

const settings = loadSettings();
let panes = [];
let activePane = 0;
let homePath = '~';
let drives = [];
let windowMaximized = false;

// Stable adapter for the palette so the global Ctrl+K handler doesn't
// have to chase the per-render ctx. Getters resolve at call time so
// `panes` / `activePane` reassignment doesn't strand the palette.
const paletteCtx = {
  get activePane() { return activePane; },
  get panes() { return panes; },
  onPaneNav: async (i, path) => { clearSearch(panes[i]); await navigate(panes[i], path); saveTabs(); render(); },
  onActivateEntry: (i, entry) => handleActivate(i, entry),
  onRecursiveSearch: (i, query) => runRecursiveSearch(i, query),
};

async function init() {
  await detectBackdropCapability();
  await readInitialMaximizedState();
  homePath = (await fs.homeDir()) || '~';
  const seedPaths = [
    homePath,
    homePath,
    quickAccessPath('Downloads'),
    quickAccessPath('Documents'),
  ];
  const saved = loadTabs();
  panes = seedPaths.map((p, i) => {
    const persisted = saved && saved[i];
    return createPaneState(
      i, p,
      persisted ? persisted.tabs : null,
      persisted ? persisted.activeTabIdx : 0,
    );
  });
  await Promise.all(panes.map((p) => safeLoad(p)));
  render();
  bindGlobalKeys();
  bindEntriesUpdates();
  // Drives populate after first paint so list/render isn't blocked on a
  // helper / PowerShell shell-out at startup.
  fs.listDrives().then((d) => { drives = d; render(); }).catch(() => {});
}

function quickAccessPath(name) {
  const sep = homePath.includes('\\') ? '\\' : '/';
  return homePath + sep + name;
}

// `New folder`, `New folder (2)`, `New folder (3)`, … — first free
// candidate against the case-insensitive existing-names set. Matches
// stock Explorer's behavior when creating a folder via the
// command-bar button.
function suggestNewFolderName(existing) {
  const base = 'New folder';
  if (!existing.has(base.toLowerCase())) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} (${n})`;
    if (!existing.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}

function railTarget(key) {
  switch (key) {
    case 'home':      return homePath;
    case 'downloads': return quickAccessPath('Downloads');
    case 'documents': return quickAccessPath('Documents');
    case 'pictures':  return quickAccessPath('Pictures');
    case 'desktop':   return quickAccessPath('Desktop');
    default: return null; // pinned/recent/drives → popovers (out of scope)
  }
}

async function safeLoad(state) {
  try {
    await loadPath(state, state.path);
  } catch {
    state.entries = [];
  }
}

// Cheap active-pane swap: toggles classes on existing pane cards and
// rebuilds Fluent's global status bar in place. No full render() — keeps
// row DOM stable so cross-pane click + dblclick work in one gesture.
function applyActivePane(i) {
  if (i < 0 || i >= panes.length) return;
  activePane = i;
  let activeCard = null;
  document.querySelectorAll('[data-pane-idx]').forEach((card) => {
    const isActive = Number(card.dataset.paneIdx) === i;
    if (card.classList.contains('a-pane')) card.classList.toggle('a-pane--active', isActive);
    if (card.classList.contains('b-pane')) card.classList.toggle('b-pane--active', isActive);
    if (isActive) activeCard = card;
  });
  // Hand keyboard focus to the active pane card so explorer keys
  // (F2 / Del / type-to-jump) start working without the user having
  // to click first. Skip when a rename input is mid-edit -- we don't
  // want to abort it.
  const ae = document.activeElement;
  const isRename = ae && ae.classList && ae.classList.contains('row__rename');
  if (activeCard && !isRename && (ae === document.body || ae === null)) {
    activeCard.focus?.({ preventScroll: true });
  }
  const oldBar = document.querySelector('.a-statusbar');
  if (oldBar) oldBar.replaceWith(fluentStatusBar({ panes, activePane }));
}

function render() {
  const root = document.getElementById('root');
  root.innerHTML = '';
  const dir = RENDERERS[settings.direction];
  const layoutId = settings[dir.layoutKey];
  const ctx = {
    direction: settings.direction,
    theme: settings[dir.themeKey],
    layout: layoutId,
    layoutDef: LAYOUT_DEFS[layoutId] || LAYOUT_DEFS['2v'],
    splits: settings.splits[layoutId] || { ...(DEFAULT_SPLITS[layoutId] || {}) },
    panes,
    get activePane() { return activePane; },
    home: homePath,
    drives,
    quickAccessPath,
    railTarget,
    onSplitChange(next) {
      settings.splits[layoutId] = next;
      saveSettings();
      render();
    },
    maximized: windowMaximized,
    async onWinCtl(kind) {
      const N = window.Neutralino; if (!N) return;
      if (kind === 'min') {
        try { await N.window.minimize(); }
        catch (e) { console.warn('window.minimize failed:', e); }
      } else if (kind === 'max') {
        // Frameless mode owns the title bar — toggle is mandatory because
        // there is no OS chrome to fall back on. Wrap each call so a failed
        // isMaximized() check doesn't strand the window in a half state.
        try {
          const isMax = await N.window.isMaximized();
          if (isMax) await N.window.unmaximize();
          else await N.window.maximize();
          windowMaximized = !isMax;
          render();
        } catch (e) { console.warn('window.max toggle failed:', e); }
      } else if (kind === 'close') {
        try { await N.app.exit(); }
        catch (e) { console.warn('app.exit failed:', e); }
      }
    },
    setActivePane(i) { applyActivePane(i); },
    setDirection(d) { settings.direction = d; saveSettings(); render(); },
    setTheme(t) { settings[dir.themeKey] = t; saveSettings(); render(); },
    setLayout(l) { settings[dir.layoutKey] = l; saveSettings(); render(); },
    onActivateEntry: handleActivate,
    onPaneNav: async (i, path) => { clearSearch(panes[i]); await navigate(panes[i], path); saveTabs(); render(); },
    onPaneBack: async (i) => { clearSearch(panes[i]); await goBack(panes[i]); saveTabs(); render(); },
    onPaneForward: async (i) => { clearSearch(panes[i]); await goForward(panes[i]); saveTabs(); render(); },
    onPaneUp: async (i) => { clearSearch(panes[i]); await goUp(panes[i]); saveTabs(); render(); },
    onRecursiveSearch: (i, query) => runRecursiveSearch(i, query),
    onCancelSearch: (i) => cancelSearch(panes[i]),
    onClearSearch: (i) => { clearSearch(panes[i]); render(); },
    onFilter: (i, q) => { panes[i].filter = q; render(); },
    onTabNew: async (i) => { await tabNew(panes[i], panes[i].path); saveTabs(); render(); },
    onTabClose: async (i, tabIdx) => { if (await tabClose(panes[i], tabIdx)) { saveTabs(); render(); } },
    onTabSwitch: async (i, tabIdx) => { await tabSwitch(panes[i], tabIdx); saveTabs(); render(); },
    onSortChange: (i, sort) => { panes[i].sort = sort; saveTabs(); render(); },
    onViewChange: (i, view) => { panes[i].view = view; saveTabs(); render(); },
    cmdRailOpen: settings.cmdRailOpen ?? null,
    onCmdRailToggle: (id) => { settings.cmdRailOpen = id; saveSettings(); render(); },
    previewOpen: !!settings.previewOpen,
    onPreviewToggle: () => { settings.previewOpen = !settings.previewOpen; saveSettings(); render(); },
    pushPreview: (paneIdx) => pushPreviewForPane(paneIdx),
    sidebarMode: settings.sidebarMode || 'quick',
    onSidebarModeChange: (m) => { settings.sidebarMode = m; saveSettings(); render(); },
    onRename: async (i, oldName, newName) => {
      const p = panes[i];
      p.renaming = null;
      if (newName && newName !== oldName) {
        try {
          await fs.rename(fs.joinPath(p.path, oldName), fs.joinPath(p.path, newName));
        } catch (e) { console.warn('rename failed:', e); }
        await safeLoad(p);
      }
      render();
    },
    onAction: (action) => doAction(action),
    onDrop: async (srcIdx, dstIdx, names, op) => {
      if (srcIdx === dstIdx || !names?.length) return;
      const src = panes[srcIdx];
      const dst = panes[dstIdx];
      const items = names.map((name) => ({
        src: fs.joinPath(src.path, name),
        dst: fs.joinPath(dst.path, name),
      }));
      await runTransfer({
        op,
        items,
        onDone: async () => {
          await Promise.all([safeLoad(src), safeLoad(dst)]);
          activePane = dstIdx;
          saveTabs();
          render();
        },
      });
    },
    // Drops from stock Explorer (or any source that exposes text/uri-list).
    // Each source path is copied/moved into the destination pane keeping
    // its basename. Same source can't be confused with our internal
    // drag because pane.js routes only when activeDrag is null.
    onForeignDrop: async (dstIdx, paths, op) => {
      if (!paths?.length) return;
      const dst = panes[dstIdx];
      const items = paths.map((p) => ({ src: p, dst: fs.joinPath(dst.path, fs.basename(p)) }));
      await runTransfer({
        op,
        items,
        onDone: async () => {
          await safeLoad(dst);
          activePane = dstIdx;
          saveTabs();
          render();
        },
      });
    },
    rerender: render,
  };
  document.documentElement.dataset.theme = ctx.theme;
  document.documentElement.dataset.direction = ctx.direction;
  document.documentElement.dataset.maximized = ctx.maximized ? '1' : '0';
  dir.fn(root, ctx);
  applyDraggableRegions();
}

// Wire every [data-drag-region] in the freshly rendered DOM up to
// Neutralino's window-drag handler. Re-rendering creates new elements
// each pass, so old handlers are GC'd with their nodes -- no manual
// teardown needed. No-op in mock mode (browser preview).
function applyDraggableRegions() {
  const N = window.Neutralino;
  if (!N || !N.window || !N.window.setDraggableRegion) return;
  document.querySelectorAll('[data-drag-region]').forEach((el) => {
    try { N.window.setDraggableRegion(el); }
    catch (e) { console.warn('setDraggableRegion failed:', e); }
  });
}

function pushPreviewForPane(paneIdx) {
  const pane = panes[paneIdx];
  if (!pane) return;
  const name = [...pane.selected][0];
  if (!name) { showPreviewFor(null); return; }
  // In search mode, results carry their own paths; otherwise reconstruct
  // from the pane's current directory.
  let entry = null;
  if (pane.search?.results) entry = pane.search.results.find((e) => e.name === name) || null;
  if (!entry) entry = pane.entries.find((e) => e.name === name) || null;
  showPreviewFor(entry);
}

async function handleActivate(paneIdx, entry) {
  if (entry.is_dir) {
    clearSearch(panes[paneIdx]);
    await navigate(panes[paneIdx], entry.path);
    render();
  } else {
    await fs.openInOS(entry.path);
  }
}

// Recursive search: streams matches into pane.search.results and re-renders
// every 80 ms while the walker runs. Cancellable; navigation auto-clears.
function runRecursiveSearch(paneIdx, query) {
  const pane = panes[paneIdx];
  if (!pane || !query) return;
  cancelSearch(pane);
  const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  pane.search = {
    query,
    root: pane.path,
    results: [],
    progress: { matched: 0, scanned: 0, done: false },
    abort: controller,
  };
  render();
  let pendingRender = false;
  // Don't render while the palette is open. render() wipes #root and
  // rebuilds the topbar; that destroys the palette-input the user is
  // typing into, leaving the overlay's listeners bound to a detached
  // DOM node. Defer the redraw until the palette closes — the search
  // keeps streaming results into pane.search.results in the meantime,
  // so the final render still shows everything found.
  const safeRender = () => {
    if (panes[paneIdx]?.search !== pane.search) return;
    if (isPaletteOpen()) {
      setTimeout(safeRender, 200);
      return;
    }
    render();
  };
  const scheduleRender = () => {
    if (pendingRender) return;
    pendingRender = true;
    setTimeout(() => {
      pendingRender = false;
      safeRender();
    }, 80);
  };
  recursiveSearch({
    root: pane.path,
    query,
    signal: controller?.signal,
    onMatch: (entry) => {
      if (panes[paneIdx]?.search !== pane.search) return;
      pane.search.results.push(entry);
      scheduleRender();
    },
    onProgress: (p) => {
      if (panes[paneIdx]?.search !== pane.search) return;
      pane.search.progress = p;
      if (p.done) safeRender();
      else scheduleRender();
    },
  }).catch((e) => console.warn('recursiveSearch failed:', e));
}

// Big-folder lazy stat fill (fs.listDir on > 200-entry directories
// returns immediately with size/modified placeholders, then back-fills
// in chunks). Each chunk fires `explorer:entries-updated`; we coalesce
// per-frame redraws so 100 chunks don't trigger 100 render() calls.
// Skipped while the palette is open — render() wipes #root and would
// detach the palette input the user is typing into (same hazard the
// recursive-search scheduler guards against).
function bindEntriesUpdates() {
  let queued = false;
  const flush = () => {
    queued = false;
    if (isPaletteOpen()) { schedule(); return; }
    render();
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    if (isPaletteOpen()) setTimeout(flush, 200);
    else requestAnimationFrame(flush);
  };
  document.addEventListener('explorer:entries-updated', schedule);
}

function cancelSearch(pane) {
  if (!pane?.search) return;
  try { pane.search.abort?.abort(); } catch {}
}

function clearSearch(pane) {
  if (!pane?.search) return;
  cancelSearch(pane);
  pane.search = null;
}

async function doAction(action) {
  const pane = panes[activePane];
  switch (action) {
    case 'newfolder': {
      const existing = new Set(pane.entries.map((e) => e.name.toLowerCase()));
      const name = await modal.prompt({
        title: 'New folder',
        label: 'Name',
        value: suggestNewFolderName(existing),
        okText: 'Create',
        validate: (v) => {
          const trimmed = (v || '').trim();
          if (!trimmed) return 'Name is required.';
          if (/[<>:"/\\|?*]/.test(trimmed)) return 'Name contains invalid characters.';
          if (trimmed === '.' || trimmed === '..') return 'Reserved name.';
          if (existing.has(trimmed.toLowerCase())) return 'A file or folder with this name already exists.';
          return null;
        },
      });
      if (!name) return;
      await fs.makeDir(fs.joinPath(pane.path, name.trim()));
      await safeLoad(pane);
      render();
      break;
    }
    case 'rename': {
      const sel = [...pane.selected][0];
      if (!sel) return;
      // Trigger inline edit on the row; the actual fs.rename happens via
      // ctx.onRename callback wired into renderRows below.
      pane.renaming = sel;
      render();
      break;
    }
    case 'delete': {
      if (!pane.selected.size) return;
      const items = [...pane.selected];
      const ok = await modal.confirm({
        title: items.length === 1 ? 'Move to Recycle Bin' : `Move ${items.length} items to Recycle Bin`,
        body: 'These items will be sent to the Recycle Bin. You can restore them from there.',
        items,
        okText: 'Move to Recycle Bin',
      });
      if (!ok) return;
      for (const name of items) {
        await fs.deleteToTrash(fs.joinPath(pane.path, name));
      }
      await safeLoad(pane);
      render();
      break;
    }
    case 'copy':
    case 'move': {
      if (panes.length < 2 || !pane.selected.size) return;
      const dest = panes[(activePane + 1) % panes.length];
      const items = [...pane.selected].map((name) => ({
        src: fs.joinPath(pane.path, name),
        dst: fs.joinPath(dest.path, name),
      }));
      await runTransfer({
        op: action,
        items,
        onDone: async () => {
          await safeLoad(pane);
          await safeLoad(dest);
          render();
        },
      });
      break;
    }
    case 'reveal': {
      const sel = [...pane.selected][0];
      if (sel) await fs.revealInOS(fs.joinPath(pane.path, sel));
      else await fs.openInOS(pane.path);
      break;
    }
    case 'refresh': {
      await safeLoad(pane);
      render();
      break;
    }
    case 'openSelected': {
      const sel = [...pane.selected][0];
      if (!sel) return;
      const entry = pane.entries.find((e) => e.name === sel);
      if (!entry) return;
      await handleActivate(activePane, entry);
      break;
    }
    case 'properties': {
      const sel = [...pane.selected][0];
      const target = sel ? fs.joinPath(pane.path, sel) : pane.path;
      await fs.showProperties(target);
      break;
    }
    case 'vscode': {
      const sel = [...pane.selected][0];
      const target = sel ? fs.joinPath(pane.path, sel) : pane.path;
      await fs.openInVSCode(target);
      break;
    }
    case 'terminal': {
      await fs.openInTerminal(pane.path);
      break;
    }
    case 'powershell': {
      await fs.openInPowerShell(pane.path);
      break;
    }
    case 'cmd': {
      await fs.openInCmd(pane.path);
      break;
    }
    case 'bash': {
      await fs.openInBash(pane.path);
      break;
    }
    case 'copyPath': {
      const sel = [...pane.selected][0];
      const target = sel ? fs.joinPath(pane.path, sel) : pane.path;
      await fs.copyPath(target);
      break;
    }
    case 'dragOut': {
      // OS drag egress via the helper's DoDragDrop verb. The helper
      // blocks while the user holds the drag; on release we refresh
      // the source pane in case the drop was a Move.
      if (!pane.selected.size) return;
      const paths = [...pane.selected].map((n) => fs.joinPath(pane.path, n));
      const effect = await fs.dragOut(paths);
      if (effect === 2 /* DROPEFFECT_MOVE */) {
        await safeLoad(pane);
        render();
      }
      break;
    }
    case 'deletePerm': {
      if (!pane.selected.size) return;
      const items = [...pane.selected];
      const ok = await modal.confirm({
        title: items.length === 1 ? 'Permanently delete' : `Permanently delete ${items.length} items`,
        body: 'This cannot be undone. The Recycle Bin is bypassed.',
        items,
        danger: true,
        okText: 'Delete',
      });
      if (!ok) return;
      for (const name of items) {
        await fs.deletePermanent(fs.joinPath(pane.path, name));
      }
      await safeLoad(pane);
      render();
      break;
    }
    case 'compare': {
      // Simple compare: highlight rows in active pane that aren't in next pane
      // by name (purely visual; no rename/move suggestions in v1).
      if (panes.length < 2) return;
      const dest = panes[(activePane + 1) % panes.length];
      const otherNames = new Set(dest.entries.map((e) => e.name));
      const compareTag = '__compare_unique';
      pane.entries.forEach((e) => { e[compareTag] = !otherNames.has(e.name); });
      pane.selected.clear();
      pane.entries.filter((e) => e[compareTag]).forEach((e) => pane.selected.add(e.name));
      render();
      break;
    }
    case 'theme': {
      const dir = RENDERERS[settings.direction];
      settings[dir.themeKey] = settings[dir.themeKey] === 'dark' ? 'light' : 'dark';
      saveSettings();
      render();
      break;
    }
    case 'previewToggle': {
      settings.previewOpen = !settings.previewOpen;
      saveSettings();
      render();
      break;
    }
    case 'tabNew': {
      await tabNew(pane, pane.path);
      saveTabs();
      render();
      break;
    }
    case 'tabClose': {
      if (await tabClose(pane, pane.activeTabIdx)) {
        saveTabs();
        render();
      }
      break;
    }
  }
}

function bindGlobalKeys() {
  document.addEventListener('explorer:action', (e) => doAction(e.detail));
  document.addEventListener('explorer:select-change', (e) => {
    if (!settings.previewOpen) return;
    // Mirror the active pane's first selection into the preview pane.
    // Cross-pane clicks change activePane via the existing flow; this
    // listener just reads whichever pane is current at event time.
    const idx = e.detail?.paneIdx ?? activePane;
    pushPreviewForPane(idx);
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      const input = document.querySelector('input.palette-input');
      if (input) {
        e.preventDefault();
        input.focus();
        input.select();
      } else if (!isPaletteOpen()) {
        e.preventDefault();
        openPalette({ ctx: paletteCtx, getPane: () => panes[activePane] });
      }
      return;
    }

    if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'P')) {
      // Ctrl+P toggles the right-side preview pane.
      e.preventDefault();
      settings.previewOpen = !settings.previewOpen;
      saveSettings();
      render();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'l' || e.key === 'L')) {
      const pane = panes[activePane];
      if (!pane) return;
      e.preventDefault();
      const input = document.querySelector('input.palette-input');
      if (input) {
        input.focus();
        input.value = pane.path;
        input.setSelectionRange(pane.path.length, pane.path.length);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        openPalette({
          ctx: paletteCtx,
          getPane: () => panes[activePane],
          initialQuery: pane.path,
        });
      }
      return;
    }
    const tgt = e.target;
    if (tgt instanceof HTMLInputElement || tgt instanceof HTMLTextAreaElement) return;
    if (e.key === 'F2') doAction('rename');
    else if (e.key === 'F5') doAction('copy');
    else if (e.key === 'F6') doAction('move');
    else if (e.key === 'Delete') doAction(e.shiftKey ? 'deletePerm' : 'delete');
    else if (e.key === 'Backspace') { goUp(panes[activePane]).then(render); }
    else if (e.altKey && e.key === 'ArrowLeft') { goBack(panes[activePane]).then(render); }
    else if (e.altKey && e.key === 'ArrowRight') { goForward(panes[activePane]).then(render); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
      const pane = panes[activePane];
      if (!pane) return;
      e.preventDefault();
      selectAll(pane);
      render();
      scrollFocusedRowIntoView(pane);
    }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const pane = panes[activePane];
      if (!pane) return;
      e.preventDefault();
      const next = moveSelectionByDelta(pane, e.key === 'ArrowDown' ? 1 : -1, e.shiftKey);
      if (next) { render(); scrollFocusedRowIntoView(pane); }
    }
    else if (e.key === 'Home' || e.key === 'End') {
      const pane = panes[activePane];
      if (!pane) return;
      e.preventDefault();
      const next = moveSelectionToBoundary(pane, e.key === 'End' ? 'end' : 'home', e.shiftKey);
      if (next) { render(); scrollFocusedRowIntoView(pane); }
    }
    else if (e.key === 'Escape') {
      typeBuf = '';
      clearTimeout(typeBufTimer);
      const pane = panes[activePane];
      if (pane?.selected.size) {
        pane.selected.clear();
        pane.selectionAnchor = null;
        pane.selectionFocus = null;
        render();
      }
    }
    else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // Type-to-jump (Windows Explorer style):
      //   - single-letter press always cycles to the *next* row whose
      //     name starts with that letter, walking the matches relative
      //     to the current selection. Repeating the same letter walks
      //     forward through the match list and wraps.
      //   - different letters in quick succession (within the 1.2 s
      //     window) accumulate into a prefix and jump to the first
      //     match of the prefix (so v, i jumps to "Videos").
      //
      // The previous version relied on typeBuf still containing the
      // letter on the second press; if the timer fired or render took
      // a tick too long, typeBuf reset to '' and the second press
      // looked like a fresh first press, staying on "Videos". The
      // current logic treats "buffer empty OR buffer is all the same
      // char as ch" as cycle mode -- so cycling works regardless of
      // timing, and only a different letter pressed before the
      // timeout extends the prefix.
      const ch = e.key.toLowerCase();
      if (!/[a-z0-9._\-+ ]/.test(ch)) return;
      const cycle = !typeBuf || [...typeBuf].every((c) => c === ch);
      if (cycle) {
        typeBuf = ch;
        typeJump(ch, /* cycle */ true);
      } else {
        typeBuf += ch;
        typeJump(typeBuf, /* cycle */ false);
      }
      clearTimeout(typeBufTimer);
      typeBufTimer = setTimeout(() => { typeBuf = ''; }, 1200);
    }
  });
}

let typeBuf = '';
let typeBufTimer = null;

function typeJump(prefix, cycle) {
  const pane = panes[activePane];
  if (!pane || !pane.entries.length) return;
  // Walk in the visible order (folders-first, current sort key) so the
  // match the user sees on screen is the match we land on.
  const items = sortedEntries(pane);
  const matches = items.filter((it) => it.name.toLowerCase().startsWith(prefix));
  if (!matches.length) return;
  let found;
  if (cycle) {
    // Continue from after the currently selected row, wrapping around
    // so the last v-match -> first v-match feels continuous.
    const current = [...pane.selected][0];
    const idx = matches.findIndex((m) => m.name === current);
    found = matches[(idx + 1) % matches.length];
  } else {
    found = matches[0];
  }
  pane.selected.clear();
  pane.selected.add(found.name);
  // Keep anchor / focus in sync so a subsequent Shift+Arrow extends
  // from the row the user just jumped to, not from a stale earlier
  // click. Matches stock Explorer's type-to-jump behavior.
  pane.selectionAnchor = found.name;
  pane.selectionFocus = found.name;
  render();
  scrollFocusedRowIntoView(pane);
}

// Scroll the row marked as pane.selectionFocus into view in the active
// pane. Falls back to the first selected name when focus isn't set
// (e.g. early in the session). No-op when neither exists.
function scrollFocusedRowIntoView(pane) {
  const name = pane?.selectionFocus || [...(pane?.selected || [])][0];
  if (!name) return;
  const sel = `.row[data-name="${CSS.escape(name)}"]`;
  const row = document.querySelector(`.a-pane--active ${sel}, .b-pane--active ${sel}`);
  row?.scrollIntoView({ block: 'nearest' });
}

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(STATE_KEY) || '{}');
    const merged = { ...DEFAULT, ...raw, splits: { ...DEFAULT_SPLITS, ...(raw.splits || {}) } };
    // Migrate users who had the now-removed Workspace direction selected.
    if (!RENDERERS[merged.direction]) merged.direction = 'fluent';
    return merged;
  } catch {
    return { ...DEFAULT, splits: { ...DEFAULT_SPLITS } };
  }
}

function saveSettings() {
  localStorage.setItem(STATE_KEY, JSON.stringify(settings));
}

function loadTabs() {
  try {
    const raw = JSON.parse(localStorage.getItem(TABS_KEY) || 'null');
    if (!Array.isArray(raw)) return null;
    return raw;
  } catch {
    return null;
  }
}

function saveTabs() {
  try {
    const payload = panes.map((p) => ({
      tabs: tabSnapshot(p),
      activeTabIdx: p.activeTabIdx,
    }));
    localStorage.setItem(TABS_KEY, JSON.stringify(payload));
  } catch {}
}

init();
