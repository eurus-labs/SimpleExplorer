// Pane: a list of files for one folder. Shared engine for all 3 directions.
// Variants only differ in chrome around the pane (see directions/*.js).
//
// State per pane:  { id, path, history, historyIdx, selected (Set), entries }

import { iconHTML, kindFor } from './icons.js';
import * as fs from './fs.js';
import { getThumbnail, shouldThumbnail } from './thumbnails.js';

const RECENT_KEY = 'simple-explorer.recent';
const MAX_RECENT = 12;

// HTML5 dataTransfer hides values during dragover (you only get the
// types list). We stash the in-flight payload here on dragstart so
// dragover can decide same-drive vs cross-drive without it.
let activeDrag = null;
const DND_TYPE = 'application/x-simpleexplorer';

function dndOp(e, srcPath, dstPath) {
  if (e.ctrlKey) return 'copy';
  if (e.shiftKey) return 'move';
  return fs.sameDrive(srcPath, dstPath) ? 'move' : 'copy';
}

export const DEFAULT_SORT = { key: 'name', dir: 'asc' };
export const DEFAULT_VIEW = 'details';

export function createTabState(initialPath, init = {}) {
  return {
    path: initialPath,
    history: [initialPath],
    historyIdx: 0,
    selected: new Set(),
    entries: [],
    loading: false,
    filter: '',
    sort: init.sort ? { ...init.sort } : { ...DEFAULT_SORT },
    view: init.view || DEFAULT_VIEW,
    // Phase 8d selection model: anchor is the row a Shift-range expands
    // from (set on plain / Ctrl click + Home / End / Ctrl+A); focus is
    // the cursor row that ArrowUp / ArrowDown moves. Anchor and focus
    // coincide on single-select; they diverge once Shift+click or
    // Shift+Arrow starts extending. Both are entry names (not paths)
    // so they survive a re-sort.
    selectionAnchor: null,
    selectionFocus: null,
  };
}

// A pane owns a list of tabs. Active-tab fields are mirrored on the pane so
// existing nav/render code keeps reading state.path / state.entries directly;
// syncActiveTab() copies them back into pane.tabs[activeTabIdx] after each
// mutation so a tab's history survives a switch-away-and-back.
// `seeds` accepts either an array of paths (legacy shape) or an array of
// { path, sort?, view? } snapshots so persistence can rehydrate sort/view.
export function createPaneState(id, initialPath, seeds, activeTabIdx = 0) {
  const list = (seeds && seeds.length) ? seeds : [initialPath];
  const tabs = list.map((s) => {
    if (typeof s === 'string') return createTabState(s);
    return createTabState(s.path, { sort: s.sort, view: s.view });
  });
  const idx = Math.min(Math.max(0, activeTabIdx), tabs.length - 1);
  const pane = { id, tabs, activeTabIdx: idx };
  hydrateFromTab(pane, tabs[idx]);
  return pane;
}

const TAB_FIELDS = ['path', 'history', 'historyIdx', 'selected', 'entries', 'loading', 'filter', 'sort', 'view', 'selectionAnchor', 'selectionFocus'];

function hydrateFromTab(pane, tab) {
  for (const k of TAB_FIELDS) pane[k] = tab[k];
}

function syncActiveTab(pane) {
  const tab = pane.tabs[pane.activeTabIdx];
  if (!tab) return;
  for (const k of TAB_FIELDS) tab[k] = pane[k];
}

export function tabSnapshot(pane) {
  return pane.tabs.map((t) => ({
    path: t.path,
    sort: t.sort ? { ...t.sort } : { ...DEFAULT_SORT },
    view: t.view || DEFAULT_VIEW,
  }));
}

export async function tabNew(pane, path) {
  syncActiveTab(pane);
  // Inherit the active tab's sort + view so a new tab in the same pane
  // doesn't surprise the user with a different ordering.
  const seed = pane.tabs[pane.activeTabIdx];
  const tab = createTabState(path, { sort: seed?.sort, view: seed?.view });
  pane.tabs.push(tab);
  pane.activeTabIdx = pane.tabs.length - 1;
  hydrateFromTab(pane, tab);
  await loadPath(pane, path);
}

export async function tabSwitch(pane, idx) {
  if (idx === pane.activeTabIdx || idx < 0 || idx >= pane.tabs.length) return;
  syncActiveTab(pane);
  pane.activeTabIdx = idx;
  const tab = pane.tabs[idx];
  hydrateFromTab(pane, tab);
  // Refresh entries — restored / never-listed tabs only carry a path snapshot.
  if (!tab.entries.length) await loadPath(pane, pane.path);
}

export async function tabClose(pane, idx) {
  if (pane.tabs.length <= 1) return false;
  syncActiveTab(pane);
  const wasActive = idx === pane.activeTabIdx;
  pane.tabs.splice(idx, 1);
  if (pane.activeTabIdx >= pane.tabs.length) pane.activeTabIdx = pane.tabs.length - 1;
  else if (idx < pane.activeTabIdx) pane.activeTabIdx -= 1;
  const tab = pane.tabs[pane.activeTabIdx];
  hydrateFromTab(pane, tab);
  if (wasActive && !tab.entries.length) await loadPath(pane, pane.path);
  return true;
}

export async function loadPath(state, path) {
  // Cancel any in-flight lazy stat-fill from the previous navigation
  // so its onProgress callbacks don't leak past this load and stomp
  // the new pane's entries with a stale re-render.
  state._listAbort?.abort();
  const ac = new AbortController();
  state._listAbort = ac;

  const norm = fs.normalizePath(path);
  state.loading = true;
  state.path = norm;
  state.entries = [];
  state.selected.clear();
  state.selectionAnchor = null;
  state.selectionFocus = null;
  try {
    state.entries = await fs.listDir(norm, {
      signal: ac.signal,
      onProgress: () => {
        if (ac.signal.aborted) return;
        // Coalesced re-render lives in app.js; we just signal.
        document.dispatchEvent(new CustomEvent('explorer:entries-updated'));
      },
    });
  } catch (e) {
    state.entries = [];
    console.warn('listDir failed', norm, e);
  }
  state.loading = false;
  pushRecent(norm);
  if (state.tabs) syncActiveTab(state);
}

export async function navigate(state, path) {
  const norm = fs.normalizePath(path);
  state.history = state.history.slice(0, state.historyIdx + 1);
  state.history.push(norm);
  state.historyIdx = state.history.length - 1;
  await loadPath(state, norm);
}

export async function goBack(state) {
  if (state.historyIdx <= 0) return;
  state.historyIdx -= 1;
  await loadPath(state, state.history[state.historyIdx]);
}

export async function goForward(state) {
  if (state.historyIdx >= state.history.length - 1) return;
  state.historyIdx += 1;
  await loadPath(state, state.history[state.historyIdx]);
}

export async function goUp(state) {
  await navigate(state, fs.parentPath(state.path));
}

export function pushRecent(path) {
  try {
    const norm = fs.normalizePath(path);
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
      .map((p) => fs.normalizePath(p));
    const next = [norm, ...list.filter((p) => p !== norm)].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {}
}

// Reads recents, normalizing each entry and dropping duplicates that arose
// before the path normalization was added (e.g. /C: and C:\ collapse to one).
export function getRecent() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    const seen = new Set();
    const out = [];
    for (const p of raw) {
      const n = fs.normalizePath(p);
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
    return out;
  } catch {
    return [];
  }
}

// ── Renderers ──────────────────────────────────────────────────────────

export function renderRows(state, opts = {}) {
  const { onActivate, onPaneActivate, onRename, onDrop, onForeignDrop, paneIdx = 0, density = 'normal', accent } = opts;
  const items = filtered(state);
  const list = document.createElement('div');
  list.className = 'rows';
  if (density === 'cmd') list.classList.add('rows--cmd');
  if (density === 'ws') list.classList.add('rows--ws');
  // View-mode class drives row layout (default details / compact / tiles).
  // `details` is the default — no class needed; the others tweak grid + padding.
  const view = state.view || DEFAULT_VIEW;
  if (view === 'compact') list.classList.add('rows--compact');
  else if (view === 'tiles') list.classList.add('rows--tiles');
  const inSearch = !!(state.search && state.search.results);
  if (inSearch) list.classList.add('rows--search');

  items.forEach((it) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.name = it.name;
    // Drag + rename are disabled in search-result rows because they would
    // operate on `pane.path/name` rather than the entry's actual parent
    // directory, silently doing the wrong thing.
    row.draggable = !inSearch;
    if (state.selected.has(it.name)) row.classList.add('row--sel');
    if (state.selectionFocus === it.name) row.classList.add('row--focus');
    if (accent) row.style.setProperty('--row-accent', accent);

    const nameCell = document.createElement('span');
    nameCell.className = 'row__name';
    if (state.renaming === it.name) {
      const label = document.createElement('input');
      label.className = 'row__rename';
      label.value = it.name;
      // Pre-select the basename so the user can replace it without
      // touching the extension.
      const dot = it.is_dir ? -1 : it.name.lastIndexOf('.');
      label.addEventListener('focus', () => {
        const end = dot > 0 ? dot : it.name.length;
        label.setSelectionRange(0, end);
      });
      const commit = () => {
        const next = label.value.trim();
        if (!next || next === it.name) onRename?.(it.name, null);
        else onRename?.(it.name, next);
      };
      label.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); onRename?.(it.name, null); }
      });
      label.addEventListener('click', (e) => e.stopPropagation());
      label.addEventListener('blur', commit);
      // Auto-focus once the row is in the DOM. Using requestAnimationFrame
      // to avoid the focus being eaten by the parent click that triggered F2.
      requestAnimationFrame(() => label.focus());
      nameCell.innerHTML = iconHTML(kindFor(it));
      nameCell.appendChild(label);
    } else if (inSearch) {
      // Search results live in different folders; show the parent path
      // beneath the name so the user can disambiguate same-named files.
      const sub = fs.parentPath(it.path) || '';
      nameCell.innerHTML = `${iconHTML(kindFor(it))}<span class="row__label">${escapeHtml(it.name)}<small class="row__sub">${escapeHtml(sub)}</small></span>`;
    } else {
      nameCell.innerHTML = `${iconHTML(kindFor(it))}<span class="row__label">${escapeHtml(it.name)}</span>`;
    }

    const sizeCell = document.createElement('span');
    sizeCell.className = 'row__size';
    sizeCell.textContent = it.is_dir ? '' : fs.formatSize(it.size);

    const modCell = document.createElement('span');
    modCell.className = 'row__mod';
    modCell.textContent = fs.formatModified(it.modified_ms);

    const kindCell = document.createElement('span');
    kindCell.className = 'row__kind';
    kindCell.textContent = it.is_dir ? 'Folder' : (it.extension || 'File').toUpperCase();

    row.append(nameCell, sizeCell, modCell, kindCell);

    // Tiles view: swap the kind glyph for a real thumbnail when the
    // helper is available and the entry is image/video. Async fill -
    // the kind icon stays visible while the helper runs, so the grid
    // never blanks during scroll.
    if (view === 'tiles' && shouldThumbnail(it)) {
      getThumbnail(it, 96).then((url) => {
        if (!url) return;
        const iconEl = nameCell.querySelector('svg.icn');
        if (!iconEl) return;
        const img = document.createElement('img');
        img.className = 'row__thumb';
        img.src = url;
        img.alt = '';
        iconEl.replaceWith(img);
      }).catch(() => {});
    }

    row.addEventListener('click', (e) => {
      if (e.shiftKey) {
        // Range-extend from the anchor (last non-shift click / arrow
        // landing). If there's no anchor yet — first click on the
        // pane — fall back to anchoring on this row, which collapses
        // Shift+click to a normal single-select.
        const anchor = state.selectionAnchor || it.name;
        selectRange(state, anchor, it.name);
        state.selectionAnchor = anchor;
        state.selectionFocus = it.name;
      } else if (e.metaKey || e.ctrlKey) {
        if (state.selected.has(it.name)) state.selected.delete(it.name);
        else state.selected.add(it.name);
        state.selectionAnchor = it.name;
        state.selectionFocus = it.name;
      } else {
        state.selected.clear();
        state.selected.add(it.name);
        state.selectionAnchor = it.name;
        state.selectionFocus = it.name;
      }
      list.querySelectorAll('.row').forEach((r) => {
        r.classList.toggle('row--sel', state.selected.has(r.dataset.name));
        r.classList.toggle('row--focus', state.selectionFocus === r.dataset.name);
      });
      // Notify the preview pane (and anything else listening for
      // selection changes) so it can refresh without a full re-render.
      document.dispatchEvent(new CustomEvent('explorer:select-change', {
        detail: { paneIdx },
      }));
    });

    row.addEventListener('dblclick', () => {
      onActivate?.(it);
    });

    row.addEventListener('dragstart', (e) => {
      // Stock-Explorer behavior: dragging an unselected row replaces the
      // selection with just it. Restoring on cancel surprises users more
      // than it helps, so we don't.
      if (!state.selected.has(it.name)) {
        state.selected.clear();
        state.selected.add(it.name);
        list.querySelectorAll('.row').forEach((r) => {
          r.classList.toggle('row--sel', state.selected.has(r.dataset.name));
        });
      }
      const names = [...state.selected];
      activeDrag = { srcIdx: paneIdx, srcPath: state.path, names };
      const payload = JSON.stringify(activeDrag);
      e.dataTransfer.setData(DND_TYPE, payload);
      // Cheap groundwork for Phase 7 OS-DnD: target apps that read URI
      // lists already have everything they need.
      const uris = names.map((n) => 'file:///' + fs.joinPath(state.path, n).replace(/\\/g, '/').replace(/^\/?/, ''));
      e.dataTransfer.setData('text/uri-list', uris.join('\r\n'));
      e.dataTransfer.effectAllowed = 'copyMove';
    });

    row.addEventListener('dragend', () => { activeDrag = null; });

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      onPaneActivate?.();
      if (!state.selected.has(it.name)) {
        state.selected.clear();
        state.selected.add(it.name);
        list.querySelectorAll('.row').forEach((r) => {
          r.classList.toggle('row--sel', state.selected.has(r.dataset.name));
        });
      }
      const paths = [...state.selected].map((n) => fs.joinPath(state.path, n));
      showContextMenu(e.clientX, e.clientY, it, paths);
    });

    list.appendChild(row);
  });

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'rows__empty';
    if (inSearch) {
      empty.textContent = state.search.progress?.done
        ? `No matches for "${state.search.query}"`
        : 'Searching…';
    } else {
      empty.textContent = state.filter ? 'No matches' : (state.loading ? 'Loading…' : 'Empty');
    }
    list.appendChild(empty);
  }

  // Folder-scope contextmenu — fires only when the user clicks the rows
  // container itself or the empty placeholder, never when bubbling up
  // from a row (rows have their own handler that prevents default).
  list.addEventListener('contextmenu', (e) => {
    if (e.target !== list && !(e.target instanceof Element && e.target.classList.contains('rows__empty'))) return;
    e.preventDefault();
    onPaneActivate?.();
    state.selected.clear();
    list.querySelectorAll('.row').forEach((r) => r.classList.remove('row--sel'));
    showFolderContextMenu(e.clientX, e.clientY, state);
  });

  // Counter avoids flicker as dragover crosses child elements.
  // Two drop sources are accepted: another SimpleExplorer pane (DND_TYPE
  // payload) and stock Windows Explorer (text/uri-list, the OS standard).
  // Foreign in-app drops (e.g. from a browser) without a uri-list aren't
  // wired in v1.
  let dragDepth = 0;
  const isInternal = (e) => activeDrag && activeDrag.srcIdx !== paneIdx && e.dataTransfer.types.includes(DND_TYPE);
  const isForeign = (e) => !activeDrag && e.dataTransfer.types.includes('text/uri-list');
  list.addEventListener('dragenter', (e) => {
    if (!isInternal(e) && !isForeign(e)) return;
    dragDepth += 1;
    list.classList.add('rows--drop');
  });
  list.addEventListener('dragover', (e) => {
    if (isInternal(e)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = dndOp(e, activeDrag.srcPath, state.path);
      return;
    }
    if (isForeign(e)) {
      e.preventDefault();
      // Source path is unknown until drop — bias toward copy (the safe
      // default) and let Shift force move. dndOp's same-drive check
      // can't run here because dataTransfer values are hidden during
      // dragover.
      e.dataTransfer.dropEffect = e.shiftKey ? 'move' : 'copy';
    }
  });
  list.addEventListener('dragleave', () => {
    if (!activeDrag && dragDepth === 0) return;
    dragDepth -= 1;
    if (dragDepth <= 0) { dragDepth = 0; list.classList.remove('rows--drop'); }
  });
  list.addEventListener('drop', (e) => {
    if (isInternal(e)) {
      const raw = e.dataTransfer.getData(DND_TYPE);
      if (!raw) return;
      e.preventDefault();
      dragDepth = 0;
      list.classList.remove('rows--drop');
      let payload;
      try { payload = JSON.parse(raw); } catch { return; }
      const op = dndOp(e, payload.srcPath, state.path);
      onDrop?.(payload.srcIdx, payload.names, op);
      activeDrag = null;
      return;
    }
    if (isForeign(e)) {
      e.preventDefault();
      dragDepth = 0;
      list.classList.remove('rows--drop');
      const uriList = e.dataTransfer.getData('text/uri-list');
      const paths = fs.parseUriList(uriList);
      if (!paths.length) return;
      // Same-drive check on first source — assumes a uniform drag (Explorer
      // doesn't mix drives in a single drag).
      const op = e.ctrlKey ? 'copy'
        : e.shiftKey ? 'move'
        : fs.sameDrive(paths[0], state.path) ? 'move'
        : 'copy';
      onForeignDrop?.(paths, op);
    }
  });

  return list;
}

// Sums byte counts for selected files in a pane. Returns '' for empty
// selection or when only folders are selected; suffixes "(files only)"
// when a folder is selected alongside files (folder size needs a
// recursive walk we don't do).
// Banner shown above the rows list when a recursive search is active.
// Renders inline status (matches / scanned / done|aborted|capped) plus
// Cancel + Clear actions. Returns null when there's no active search,
// so callers can `if (banner) card.appendChild(banner)`.
export function renderSearchBanner(state, { onCancel, onClear }) {
  if (!state.search) return null;
  const banner = document.createElement('div');
  banner.className = 'search-banner';
  const p = state.search.progress || { matched: 0, scanned: 0, done: false };
  const status = p.aborted
    ? 'cancelled'
    : p.capped
      ? 'first 5000 results'
      : p.done
        ? 'done'
        : 'searching…';
  banner.innerHTML = `
    <span class="search-banner__icon">${iconHTML('search', 13)}</span>
    <span class="search-banner__text">
      <strong>${escapeHtml(state.search.query)}</strong>
      <small>in ${escapeHtml(state.search.root)}</small>
    </span>
    <span class="search-banner__count">${p.matched} match${p.matched === 1 ? '' : 'es'} · ${status}</span>
    <button class="search-banner__btn" data-act="cancel" ${p.done ? 'disabled' : ''}>Cancel</button>
    <button class="search-banner__btn" data-act="clear">Clear</button>
  `;
  banner.querySelector('[data-act="cancel"]').addEventListener('click', (e) => {
    e.stopPropagation();
    onCancel?.();
  });
  banner.querySelector('[data-act="clear"]').addEventListener('click', (e) => {
    e.stopPropagation();
    onClear?.();
  });
  return banner;
}

export function selectionSizeLabel(pane) {
  if (!pane.selected.size) return '';
  let bytes = 0;
  let hasFolder = false;
  let hasFile = false;
  for (const name of pane.selected) {
    const e = pane.entries.find((x) => x.name === name);
    if (!e) continue;
    if (e.is_dir) hasFolder = true;
    else { hasFile = true; bytes += e.size || 0; }
  }
  if (!hasFile) return '';
  return hasFolder ? `${fs.formatSize(bytes)} (files only)` : fs.formatSize(bytes);
}

export function filtered(state) {
  // Recursive-search mode short-circuits the normal entries list.
  // Results stream in from search.js; we render whatever has arrived.
  if (state.search && state.search.results) {
    return state.search.results;
  }
  const sorted = sortedEntries(state);
  if (!state.filter) return sorted;
  const q = state.filter.toLowerCase();
  return sorted.filter((e) => e.name.toLowerCase().includes(q));
}

// ── Phase 8d: keyboard selection ──────────────────────────────────────
// `selectRange` replaces state.selected with [anchor..target] (inclusive)
// in the currently-visible order (`filtered`). Used by Shift+click,
// Shift+ArrowUp/Down, and Shift+Home/End. No-op when either endpoint
// isn't in the visible list (e.g. anchor was filtered out).
export function selectRange(state, anchor, target) {
  const items = filtered(state);
  const ai = items.findIndex((it) => it.name === anchor);
  const ti = items.findIndex((it) => it.name === target);
  if (ai === -1 || ti === -1) return;
  const lo = Math.min(ai, ti);
  const hi = Math.max(ai, ti);
  state.selected.clear();
  for (let i = lo; i <= hi; i++) state.selected.add(items[i].name);
}

// Select every visible entry. Anchors on the first row and focuses the
// last so a subsequent Shift+Arrow extends from a sensible spot.
export function selectAll(state) {
  const items = filtered(state);
  state.selected.clear();
  items.forEach((it) => state.selected.add(it.name));
  if (items.length) {
    state.selectionAnchor = items[0].name;
    state.selectionFocus = items[items.length - 1].name;
  }
}

// Move the keyboard cursor by `delta` rows (+1 = down, -1 = up). When
// `extending` is true the range stays anchored and grows / shrinks; on
// a plain move the anchor follows the focus (single-select).
// Returns the new focus name so callers can scroll it into view, or
// null when nothing changed.
export function moveSelectionByDelta(state, delta, extending) {
  const items = filtered(state);
  if (!items.length) return null;
  let cur = state.selectionFocus;
  if (!cur || !items.some((it) => it.name === cur)) {
    cur = [...state.selected][0] || items[0].name;
    if (!extending) state.selectionAnchor = cur;
  }
  const idx = items.findIndex((it) => it.name === cur);
  const nextIdx = Math.max(0, Math.min(items.length - 1, idx + delta));
  const next = items[nextIdx].name;
  if (extending) {
    const anchor = state.selectionAnchor || cur;
    selectRange(state, anchor, next);
    state.selectionAnchor = anchor;
  } else {
    state.selected.clear();
    state.selected.add(next);
    state.selectionAnchor = next;
  }
  state.selectionFocus = next;
  return next;
}

// Jump the cursor to the first / last visible row. `boundary` is
// 'home' or 'end'; `extending` selects [anchor..boundary] instead of
// replacing the selection. Returns the landing name for scroll-into-view.
export function moveSelectionToBoundary(state, boundary, extending) {
  const items = filtered(state);
  if (!items.length) return null;
  const target = boundary === 'end' ? items[items.length - 1].name : items[0].name;
  if (extending) {
    const anchor = state.selectionAnchor || state.selectionFocus || items[0].name;
    selectRange(state, anchor, target);
    state.selectionAnchor = anchor;
  } else {
    state.selected.clear();
    state.selected.add(target);
    state.selectionAnchor = target;
  }
  state.selectionFocus = target;
  return target;
}

// Folders cluster first; within each group entries sort by the active key.
// `name` is case-insensitive locale-aware; `size` and `modified` are
// numeric; `type` falls back to the same name comparator within a type.
export function sortedEntries(state) {
  const sort = state.sort || DEFAULT_SORT;
  const dirSign = sort.dir === 'desc' ? -1 : 1;
  const cmp = COMPARATORS[sort.key] || COMPARATORS.name;
  return [...state.entries].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return dirSign * cmp(a, b);
  });
}

const NAME_CMP = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
const COMPARATORS = {
  name:     NAME_CMP,
  size:     (a, b) => (a.size || 0) - (b.size || 0) || NAME_CMP(a, b),
  modified: (a, b) => (a.modified_ms || 0) - (b.modified_ms || 0) || NAME_CMP(a, b),
  type:     (a, b) => {
    const ta = a.is_dir ? '' : (a.extension || '').toLowerCase();
    const tb = b.is_dir ? '' : (b.extension || '').toLowerCase();
    if (ta !== tb) return ta < tb ? -1 : 1;
    return NAME_CMP(a, b);
  },
};

export function renderColumnHeader(direction, opts = {}) {
  const { sort = DEFAULT_SORT, onSort } = opts;
  const head = document.createElement('div');
  head.className = 'cols';
  if (direction === 'ws') head.classList.add('cols--ws');
  const cells = [
    { key: 'name', label: 'Name' },
    { key: 'size', label: 'Size' },
    { key: 'modified', label: 'Modified' },
    { key: 'type', label: 'Type' },
  ];
  cells.forEach((c) => {
    const span = document.createElement('span');
    span.className = 'cols__seg';
    span.dataset.sortKey = c.key;
    if (c.key === sort.key) span.classList.add('cols__seg--active');
    const arrow = c.key === sort.key
      ? `<span class="cols__arrow">${sort.dir === 'desc' ? '↓' : '↑'}</span>`
      : '';
    span.innerHTML = `${c.label}${arrow}`;
    if (onSort) {
      span.style.cursor = 'pointer';
      span.addEventListener('click', () => {
        if (sort.key === c.key) onSort({ key: c.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' });
        else onSort({ key: c.key, dir: 'asc' });
      });
    }
    head.appendChild(span);
  });
  return head;
}

export function renderBreadcrumb(path, onSegmentClick) {
  const wrap = document.createElement('div');
  wrap.className = 'crumbs';
  wrap.innerHTML = iconHTML('home', 13);
  const segs = fs.pathSegments(path);
  const win = path.includes('\\');
  segs.forEach((seg, i) => {
    const sep = document.createElement('span');
    sep.className = 'crumbs__sep';
    sep.textContent = '›';
    wrap.appendChild(sep);
    const isLast = i === segs.length - 1;
    const part = document.createElement('span');
    part.className = 'crumbs__seg' + (isLast ? ' crumbs__seg--last' : '');
    part.textContent = seg;
    if (!isLast && onSegmentClick) {
      const target = buildSegPath(segs, i, win);
      part.style.cursor = 'pointer';
      part.addEventListener('click', (e) => { e.stopPropagation(); onSegmentClick(target); });
    }
    wrap.appendChild(part);
  });
  return wrap;
}

export function buildSegPath(segs, idx, win) {
  const parts = segs.slice(0, idx + 1);
  if (win) {
    // First segment is the drive ("C:") — always keep its trailing slash.
    if (parts.length === 1) return parts[0] + '\\';
    return parts.join('\\');
  }
  return '/' + parts.join('/');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// SimpleExplorer-specific items (Open in active pane, Compare, Copy path,
// Rename, Delete) that don't appear in IContextMenu. Rendered first; the
// shell extensions fill in below an "Other actions" separator.
const CURATED_ITEMS = [
  { label: 'Open',              act: 'openSelected' },
  { label: 'Open in VS Code',   act: 'vscode' },
  { label: 'Open in Terminal',  act: 'terminal', dirOnly: true },
  null,
  { label: 'Copy path',         act: 'copyPath' },
  { label: 'Drag out to OS…',   act: 'dragOut' },
  { label: 'Rename',            act: 'rename', kbd: 'F2' },
  { label: 'Delete',            act: 'delete', kbd: 'Del' },
  null,
  { label: 'Show in Explorer',  act: 'reveal' },
  { label: 'Properties',        act: 'properties' },
];

// Folder-scope items (right-click on the empty area of a pane). All
// target the folder itself via doAction with selection cleared.
const FOLDER_ITEMS = [
  { label: 'Open in VS Code',   act: 'vscode' },
  { label: 'Open in Terminal',  act: 'terminal' },
  { label: 'New folder',        act: 'newfolder' },
  { label: 'Refresh',           act: 'refresh' },
  null,
  { label: 'Show in Explorer',  act: 'reveal' },
  { label: 'Properties',        act: 'properties' },
];

// 3-second TTL cache so repeat right-clicks of the same selection don't
// re-walk COM. Keyed by paths.join('\\0').
const SHELL_MENU_CACHE = new Map();
const SHELL_MENU_TTL_MS = 3000;

let openMenus = [];

function dismissAllMenus() {
  openMenus.forEach((m) => m.remove());
  openMenus = [];
}

// Shell-picker dropdown, anchored under a toolbar/rail button. Lists
// the three external launchers wired in `src/fs.js` and dispatches via
// the same `explorer:action` channel as the right-click menu. The
// caller passes the button's bounding rect (or any DOMRect-shaped
// object); we position the menu just below it, with the existing
// outside-click / Escape dismiss handlers picked up via attachDismiss.
export function showShellPickerMenu(anchorRect) {
  dismissAllMenus();
  const menu = createMenuEl();
  const items = [
    { label: 'PowerShell',          act: 'powershell' },
    { label: 'Command Prompt',      act: 'cmd' },
    { label: 'Git Bash',            act: 'bash' },
    null,
    { label: 'Open in Terminal',    act: 'terminal' },
  ];
  items.forEach((it) => {
    if (!it) {
      const sep = document.createElement('div');
      sep.className = 'ctx-menu__sep';
      menu.appendChild(sep);
      return;
    }
    const row = document.createElement('div');
    row.className = 'ctx-menu__item';
    row.innerHTML = `<span>${escapeHtml(it.label)}</span>`;
    row.addEventListener('click', () => {
      dismissAllMenus();
      document.dispatchEvent(new CustomEvent('explorer:action', { detail: it.act }));
    });
    menu.appendChild(row);
  });
  document.body.appendChild(menu);
  // positionAt expects (x, y); anchor the menu's top-left below the
  // button's bottom-left so it visually drops down from the icon.
  positionAt(menu, anchorRect.left, anchorRect.bottom + 4);
  openMenus.push(menu);
  attachDismiss();
}

// Right-click menu. Items dispatch an 'explorer:action' CustomEvent that
// app.js routes through doAction(); shell-extension items invoke the
// helper exe directly. Closes on outside click or Escape.
function showContextMenu(x, y, entry, paths) {
  dismissAllMenus();

  const menu = createMenuEl();
  buildCurated(menu, entry);

  // Placeholder that the async helper fill replaces.
  const sep = document.createElement('div');
  sep.className = 'ctx-menu__sep';
  menu.appendChild(sep);
  const loading = document.createElement('div');
  loading.className = 'ctx-menu__item ctx-menu__item--loading';
  loading.innerHTML = '<span>Loading shell extensions…</span>';
  menu.appendChild(loading);

  document.body.appendChild(menu);
  positionAt(menu, x, y);
  openMenus.push(menu);
  attachDismiss();

  // Try the cache first; otherwise fetch from the helper.
  const key = paths.join('\0');
  const cached = SHELL_MENU_CACHE.get(key);
  if (cached && Date.now() - cached.ts < SHELL_MENU_TTL_MS) {
    fillShellSection(menu, sep, loading, cached.json, paths);
    return;
  }
  fs.helperMenu(paths).then((json) => {
    if (!menu.isConnected) return;
    if (json) SHELL_MENU_CACHE.set(key, { ts: Date.now(), json });
    fillShellSection(menu, sep, loading, json, paths);
  }).catch(() => {
    fillShellSection(menu, sep, loading, null, paths);
  });
}

// Folder-scope right-click menu. Curated folder items (which all act on
// the active pane's path) followed by the OS shell extensions resolved
// against [pane.path] — that's where Git Bash / 7-Zip / Send to / etc.
// land for the folder itself.
function showFolderContextMenu(x, y, pane) {
  dismissAllMenus();

  const menu = createMenuEl();
  buildFolderCurated(menu);

  const sep = document.createElement('div');
  sep.className = 'ctx-menu__sep';
  menu.appendChild(sep);
  const loading = document.createElement('div');
  loading.className = 'ctx-menu__item ctx-menu__item--loading';
  loading.innerHTML = '<span>Loading shell extensions…</span>';
  menu.appendChild(loading);

  document.body.appendChild(menu);
  positionAt(menu, x, y);
  openMenus.push(menu);
  attachDismiss();

  const paths = [pane.path];
  const key = paths.join('\0');
  const cached = SHELL_MENU_CACHE.get(key);
  if (cached && Date.now() - cached.ts < SHELL_MENU_TTL_MS) {
    fillShellSection(menu, sep, loading, cached.json, paths);
    return;
  }
  fs.helperMenu(paths).then((json) => {
    if (!menu.isConnected) return;
    if (json) SHELL_MENU_CACHE.set(key, { ts: Date.now(), json });
    fillShellSection(menu, sep, loading, json, paths);
  }).catch(() => {
    fillShellSection(menu, sep, loading, null, paths);
  });
}

function buildFolderCurated(menu) {
  FOLDER_ITEMS.forEach((it) => {
    if (!it) {
      const sep = document.createElement('div');
      sep.className = 'ctx-menu__sep';
      menu.appendChild(sep);
      return;
    }
    const row = document.createElement('div');
    row.className = 'ctx-menu__item';
    row.innerHTML = `<span>${escapeHtml(it.label)}</span>`;
    row.addEventListener('click', () => {
      dismissAllMenus();
      document.dispatchEvent(new CustomEvent('explorer:action', { detail: it.act }));
    });
    menu.appendChild(row);
  });
}

function createMenuEl() {
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  return menu;
}

function buildCurated(menu, entry) {
  CURATED_ITEMS.forEach((it) => {
    if (!it) {
      const sep = document.createElement('div');
      sep.className = 'ctx-menu__sep';
      menu.appendChild(sep);
      return;
    }
    if (it.dirOnly && !entry.is_dir) return;
    const row = document.createElement('div');
    row.className = 'ctx-menu__item';
    row.innerHTML = `<span>${escapeHtml(it.label)}</span>${it.kbd ? `<span class="ctx-menu__kbd">${it.kbd}</span>` : ''}`;
    row.addEventListener('click', () => {
      dismissAllMenus();
      document.dispatchEvent(new CustomEvent('explorer:action', { detail: it.act }));
    });
    menu.appendChild(row);
  });
}

// Replaces the loading placeholder with shell-extension entries. When the
// helper isn't available (mock mode, exe not yet compiled), the curated
// items above are the whole menu — drop the loading placeholder + leading
// separator silently.
function fillShellSection(menu, sep, loading, json, paths) {
  loading.remove();
  // Distinguish "helper deadline blew" from "no extensions installed":
  // surface the timeout case so the user knows entries are missing and
  // isn't surprised that 7-Zip / Send to / TortoiseSVN didn't show up.
  if (json === fs.HELPER_MENU_TIMEOUT) {
    const note = document.createElement('div');
    note.className = 'ctx-menu__item ctx-menu__item--loading';
    note.textContent = 'Shell extensions timed out';
    note.title = 'A registered shell extension took too long to respond.';
    menu.appendChild(note);
    return;
  }
  if (!json || !json.length) {
    sep.remove();
    return;
  }
  appendMenuEntries(menu, json, paths);
}

function appendMenuEntries(parentEl, entries, paths) {
  entries.forEach((entry) => {
    if (entry.separator) {
      const sep = document.createElement('div');
      sep.className = 'ctx-menu__sep';
      parentEl.appendChild(sep);
      return;
    }
    if (!entry.label) return;
    const row = document.createElement('div');
    row.className = 'ctx-menu__item';
    if (entry.disabled) row.classList.add('ctx-menu__item--disabled');
    if (entry.submenu) row.classList.add('ctx-menu__item--submenu');

    const label = document.createElement('span');
    label.textContent = entry.label.replace(/&/g, ''); // strip Win mnemonic accelerators
    row.appendChild(label);

    if (entry.submenu) {
      const arrow = document.createElement('span');
      arrow.className = 'ctx-menu__arrow';
      arrow.textContent = '›';
      row.appendChild(arrow);
      bindSubmenuHover(row, entry.submenu, paths);
    } else if (!entry.disabled) {
      row.addEventListener('click', () => {
        dismissAllMenus();
        fs.helperInvoke(entry.id, paths);
      });
    }

    parentEl.appendChild(row);
  });
}

function bindSubmenuHover(parentRow, submenuEntries, paths) {
  let openTimer = null;
  let childMenu = null;

  const openChild = () => {
    if (childMenu) return;
    // Close sibling submenus opened from this parent's menu.
    const myMenu = parentRow.parentElement;
    const idx = openMenus.indexOf(myMenu);
    if (idx !== -1) {
      // Close any submenus deeper than this one.
      openMenus.slice(idx + 1).forEach((m) => m.remove());
      openMenus = openMenus.slice(0, idx + 1);
    }
    childMenu = createMenuEl();
    appendMenuEntries(childMenu, submenuEntries, paths);
    document.body.appendChild(childMenu);
    const r = parentRow.getBoundingClientRect();
    positionSubmenu(childMenu, r);
    openMenus.push(childMenu);
  };

  parentRow.addEventListener('mouseenter', () => {
    clearTimeout(openTimer);
    openTimer = setTimeout(openChild, 200);
  });
  parentRow.addEventListener('mouseleave', () => {
    clearTimeout(openTimer);
  });
  parentRow.addEventListener('click', () => {
    clearTimeout(openTimer);
    openChild();
  });
}

function positionAt(menu, x, y) {
  const w = menu.offsetWidth, h = menu.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  // Clamp on both axes so neither edge can spill past the viewport.
  // When the menu is taller than the viewport the CSS max-height
  // clamps offsetHeight; we still pin top to 8 so the header sits
  // just below the chrome and the scroll bar reaches both edges.
  const left = Math.max(4, Math.min(x, vw - w - 4));
  const top  = Math.max(8, Math.min(y, vh - h - 8));
  menu.style.left = left + 'px';
  menu.style.top  = top + 'px';
}

function positionSubmenu(menu, parentRect) {
  const w = menu.offsetWidth, h = menu.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = parentRect.right - 2;
  if (left + w > vw - 4) left = parentRect.left - w + 2;
  if (left < 4) left = 4;
  let top = parentRect.top - 4;
  if (top + h > vh - 8) top = vh - h - 8;
  if (top < 8) top = 8;
  menu.style.left = left + 'px';
  menu.style.top  = top + 'px';
}

let dismissAttached = false;
function attachDismiss() {
  if (dismissAttached) return;
  dismissAttached = true;
  const onMouseDown = (e) => {
    if (openMenus.some((m) => m.contains(e.target))) return;
    dismissAllMenus();
    detach();
  };
  const onKey = (e) => { if (e.key === 'Escape') { dismissAllMenus(); detach(); } };
  const detach = () => {
    document.removeEventListener('mousedown', onMouseDown, true);
    document.removeEventListener('keydown', onKey, true);
    dismissAttached = false;
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
}
