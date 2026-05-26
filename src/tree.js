// Folder tree for the Fluent sidebar.
//
// Single-level lazy fetch: each expanded folder calls fs.listDir on demand
// and caches the result on the node. Children are kept across collapse so
// re-expanding is instant.
//
// Persistence: the set of expanded paths is serialized to localStorage
// under TREE_KEY so the tree opens to the same shape across launches.
// Drives are seeded from ctx.drives on each render.
//
// Windowed renderer: we walk the open tree once to produce a flat
// visibleNodes array, then only the rows currently inside the scroll
// viewport (± BUFFER) live in the DOM. Row height is fixed (24 px) so
// position math stays trivial. Keeps re-renders cheap on 10 k+ visible
// nodes (e.g. expanding a big OneDrive root).

import { iconHTML } from './icons.js';
import * as fs from './fs.js';

const TREE_KEY = 'simple-explorer.tree.expanded';
const ROW_HEIGHT = 24;
const BUFFER = 8;

// path -> { children: [{name, path, is_dir}] | null, loading: bool, loaded: bool }
const nodeCache = new Map();
const expanded = loadExpanded();

// Latest mounted tree instance. Async fetches that resolve after a
// re-render still call `rebuild()` here so the new instance picks up
// the freshly-loaded children. Scroll position rides on the instance
// so we can restore it after the parent direction wipes the sidebar.
let instance = null;
let lastScrollTop = 0;

function loadExpanded() {
  try {
    const raw = localStorage.getItem(TREE_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw));
  } catch { return new Set(); }
}

function saveExpanded() {
  try { localStorage.setItem(TREE_KEY, JSON.stringify([...expanded])); }
  catch {}
}

export function isExpanded(path) {
  return expanded.has(normalize(path));
}

export function setExpanded(path, isOpen) {
  const norm = normalize(path);
  if (isOpen) expanded.add(norm);
  else expanded.delete(norm);
  saveExpanded();
}

function normalize(p) {
  return (p || '').replace(/[\\/]+$/, '');
}

// Roots are typically the drive list. Each root is { label, path }.
export function renderTree(container, { roots, onNavigate, activePath }) {
  container.innerHTML = '';
  container.classList.add('tree-scroll');
  const inner = document.createElement('div');
  inner.className = 'tree-inner';
  container.appendChild(inner);

  instance = {
    container, inner, roots, onNavigate, activePath,
    visible: [],
  };

  container.addEventListener('scroll', () => {
    if (!instance || instance.container !== container) return;
    lastScrollTop = container.scrollTop;
    renderWindow();
  }, { passive: true });

  // The container hasn't been mounted yet when renderTree runs (the
  // parent sidebar appends it after this returns), so clientHeight is
  // 0 and renderWindow falls back to the 400 px placeholder. Observe
  // size so the window re-paints with the real viewport once the
  // sidebar lays out.
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => {
      if (!instance || instance.container !== container) { ro.disconnect(); return; }
      renderWindow();
    });
    ro.observe(container);
  }

  rebuild();
  container.scrollTop = lastScrollTop;
  renderWindow();
}

// Flatten the currently-open tree into a single array and re-layout
// the spacer. Called on expand/collapse + when async child fetches
// resolve. Cheap (O(visible)); the cost lives in renderWindow.
function rebuild() {
  if (!instance) return;
  const out = [];
  instance.roots.forEach((r) => walk({
    name: r.label, path: r.path, is_dir: true,
  }, 0, out));
  instance.visible = out;
  instance.inner.style.height = (out.length * ROW_HEIGHT) + 'px';
  renderWindow();
}

function walk(entry, depth, out) {
  out.push({ kind: 'node', entry, depth });
  if (!isExpanded(entry.path)) return;
  const cached = nodeCache.get(normalize(entry.path));
  if (!cached || cached.loading) {
    out.push({ kind: 'loading', depth: depth + 1 });
    return;
  }
  if (!cached.children || cached.children.length === 0) {
    out.push({ kind: 'empty', depth: depth + 1 });
    return;
  }
  cached.children.forEach((c) => walk(c, depth + 1, out));
}

function renderWindow() {
  if (!instance) return;
  const { container, inner, visible } = instance;
  const viewportH = container.clientHeight || 400;
  const top = lastScrollTop;
  const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - BUFFER);
  const last = Math.min(visible.length, Math.ceil((top + viewportH) / ROW_HEIGHT) + BUFFER);
  inner.innerHTML = '';
  for (let i = first; i < last; i++) {
    const node = visible[i];
    inner.appendChild(makeRow(node, i));
  }
}

function makeRow(node, idx) {
  if (node.kind === 'loading') {
    const el = document.createElement('div');
    el.className = 'tree__loading';
    el.style.position = 'absolute';
    el.style.top = (idx * ROW_HEIGHT) + 'px';
    el.style.left = '0';
    el.style.right = '0';
    el.style.paddingLeft = (node.depth * 14 + 8) + 'px';
    el.textContent = 'Loading…';
    return el;
  }
  if (node.kind === 'empty') {
    const el = document.createElement('div');
    el.className = 'tree__empty';
    el.style.position = 'absolute';
    el.style.top = (idx * ROW_HEIGHT) + 'px';
    el.style.left = '0';
    el.style.right = '0';
    el.style.paddingLeft = (node.depth * 14 + 8) + 'px';
    el.textContent = 'Empty';
    return el;
  }
  const { entry, depth } = node;
  const row = document.createElement('div');
  row.className = 'tree__row';
  if (normalize(entry.path) === normalize(instance.activePath)) row.classList.add('tree__row--active');
  row.style.position = 'absolute';
  row.style.top = (idx * ROW_HEIGHT) + 'px';
  row.style.left = '0';
  row.style.right = '0';
  row.style.paddingLeft = (depth * 14 + 8) + 'px';

  const isOpen = isExpanded(entry.path);
  const chev = document.createElement('span');
  chev.className = 'tree__chev' + (isOpen ? ' tree__chev--open' : '');
  chev.textContent = '›';
  row.appendChild(chev);

  const ico = document.createElement('span');
  ico.className = 'tree__ico';
  ico.innerHTML = iconHTML(depth === 0 ? 'drive' : 'folder', 13);
  row.appendChild(ico);

  const label = document.createElement('span');
  label.className = 'tree__label';
  label.textContent = entry.name;
  label.title = entry.path;
  row.appendChild(label);

  chev.addEventListener('click', (e) => {
    e.stopPropagation();
    toggle(entry);
  });
  row.addEventListener('click', () => {
    instance?.onNavigate?.(entry.path);
  });
  row.addEventListener('dblclick', () => toggle(entry));

  return row;
}

function toggle(entry) {
  const open = isExpanded(entry.path);
  setExpanded(entry.path, !open);
  if (!open) fetchChildren(entry);
  rebuild();
}

async function fetchChildren(entry) {
  const norm = normalize(entry.path);
  const cached = nodeCache.get(norm);
  if (cached?.loaded || cached?.loading) return;
  nodeCache.set(norm, { children: null, loading: true, loaded: false });
  let listed = [];
  // Tree doesn't render size / modified, so the async stat fill that
  // fs.listDir kicks off for big directories is wasted work for us —
  // but the entries we read here are already correctly typed (is_dir
  // comes from readDirectory). The stat fill mutates an array we
  // immediately re-shape into name+path-only dir objects, so the
  // wasted writes vanish into an unreferenced array on the next GC.
  try { listed = await fs.listDir(entry.path); }
  catch { listed = []; }
  const dirs = listed.filter((e) => e.is_dir).map((e) => ({
    name: e.name, path: e.path, is_dir: true,
  }));
  nodeCache.set(norm, { children: dirs, loading: false, loaded: true });
  // Re-check expanded — user may have collapsed during the async fetch.
  if (!isExpanded(entry.path)) {
    rebuild();
    return;
  }
  rebuild();
}

// Drop any cached children for `path` so the next expand re-fetches.
// Called after FS-mutating actions (rename / delete / move) so the tree
// stays honest with disk contents.
export function invalidateTreePath(path) {
  nodeCache.delete(normalize(path));
}
