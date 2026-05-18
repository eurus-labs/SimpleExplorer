// FS adapter. Talks to Neutralinojs APIs when available, falls back to mock
// data for visual iteration when src/index.html is opened directly in a
// browser (no Neutralino runtime).
//
// All higher-level code (app.js, pane.js, directions/*.js) imports from this
// module only — keeping the Neutralino surface area in one file.

// `window` is undefined under node:test (tests import the pure path
// helpers directly). Guarding the lookup keeps the module
// importable so e.g. tests/fs.path.test.js can exercise normalizePath
// without spinning up a DOM.
const N = (typeof window !== 'undefined') ? window.Neutralino : null;
export const isNative = !!N;

// ── Mock data ───────────────────────────────────────────────────────────────
const SAMPLE = {
  '~/Projects': [
    { name: 'qt5.14.2',         is_dir: true,  size: 0,       modified_ms: Date.now() - 2 * 86400e3, extension: '' },
    { name: 'simple-explorer',  is_dir: true,  size: 0,       modified_ms: Date.now(),                extension: '' },
    { name: 'archive',          is_dir: true,  size: 0,       modified_ms: Date.now() - 7 * 86400e3, extension: '' },
    { name: 'sandbox',          is_dir: true,  size: 0,       modified_ms: Date.now(),                extension: '' },
    { name: 'README.md',        is_dir: false, size: 4300,    modified_ms: Date.now() - 720e3,        extension: 'md' },
    { name: 'package.json',     is_dir: false, size: 1100,    modified_ms: Date.now() - 86400e3,      extension: 'json' },
    { name: 'design-notes.pdf', is_dir: false, size: 2.4e6,   modified_ms: Date.now() - 3 * 86400e3,  extension: 'pdf' },
  ],
  '~/Projects/qt5.14.2': [
    { name: 'bin',          is_dir: true,  size: 0,        modified_ms: Date.now(), extension: '' },
    { name: 'doc',          is_dir: true,  size: 0,        modified_ms: Date.now(), extension: '' },
    { name: 'examples',     is_dir: true,  size: 0,        modified_ms: Date.now(), extension: '' },
    { name: 'include',      is_dir: true,  size: 0,        modified_ms: Date.now(), extension: '' },
    { name: 'lib',          is_dir: true,  size: 0,        modified_ms: Date.now(), extension: '' },
    { name: 'plugins',      is_dir: true,  size: 0,        modified_ms: Date.now(), extension: '' },
    { name: 'translations', is_dir: true,  size: 0,        modified_ms: Date.now(), extension: '' },
    { name: 'configure.bat',     is_dir: false, size: 12000, modified_ms: Date.now(), extension: 'bat' },
    { name: 'LICENSE.LGPLv3',    is_dir: false, size: 7600,  modified_ms: Date.now(), extension: 'txt' },
  ],
  '~/Downloads': [
    { name: 'Screenshot 2025-09-08.png', is_dir: false, size: 1.8e6,  modified_ms: Date.now(),               extension: 'png' },
    { name: 'invoice-october.pdf',       is_dir: false, size: 186000, modified_ms: Date.now(),               extension: 'pdf' },
    { name: 'qt-installer.exe',          is_dir: false, size: 48.2e6, modified_ms: Date.now() - 86400e3,     extension: 'exe' },
    { name: 'tmp',                       is_dir: true,  size: 0,      modified_ms: Date.now(),               extension: '' },
    { name: 'design-handoff.zip',        is_dir: false, size: 14.6e6, modified_ms: Date.now() - 2 * 86400e3, extension: 'zip' },
  ],
  '~/Documents': [
    { name: 'Contracts',              is_dir: true,  size: 0,    modified_ms: Date.now() - 7 * 86400e3,  extension: '' },
    { name: 'Notes',                  is_dir: true,  size: 0,    modified_ms: Date.now(),                extension: '' },
    { name: 'Resume.pdf',             is_dir: false, size: 92000, modified_ms: Date.now() - 30 * 86400e3, extension: 'pdf' },
    { name: 'meeting-2025-10-23.md',  is_dir: false, size: 6000, modified_ms: Date.now(),                extension: 'md' },
  ],
};

// ── Path helpers (sync, no native) ──────────────────────────────────────────

// Coerce a path string into a canonical form for the platform. Catches
// stray forward-slashes mid-Windows-path (e.g. C:/Users) and leading
// slashes on Windows roots (e.g. /C:) before they end up in navigation
// state, history, or localStorage. Idempotent.
export function normalizePath(path) {
  if (!path) return path;
  let p = String(path);
  // /C: or /C:/foo  ->  C: or C:/foo
  p = p.replace(/^\/+([A-Za-z]:)/, '$1');
  if (/^[A-Za-z]:/.test(p)) {
    p = p.replace(/\//g, '\\');
    p = p.replace(/\\+/g, '\\');
    if (/^[A-Za-z]:$/.test(p)) p += '\\';
  }
  return p;
}

export function sameDrive(a, b) {
  const da = String(normalizePath(a) || '').match(/^([A-Za-z]):/);
  const db = String(normalizePath(b) || '').match(/^([A-Za-z]):/);
  if (!da || !db) return true;
  return da[1].toLowerCase() === db[1].toLowerCase();
}

export function joinPath(parent, name) {
  if (!parent) return name;
  const norm = normalizePath(parent);
  const sep = /^[A-Za-z]:/.test(norm) || norm.includes('\\') ? '\\' : '/';
  if (norm.endsWith(sep)) return norm + name;
  return norm + sep + name;
}

export function parentPath(path) {
  const norm = normalizePath(path);
  const sep = /^[A-Za-z]:/.test(norm) || norm.includes('\\') ? '\\' : '/';
  const idx = norm.lastIndexOf(sep);
  if (idx <= 0) return norm;
  if (norm.match(/^[A-Za-z]:\\?$/)) return norm;
  const up = norm.slice(0, idx);
  if (/^[A-Za-z]:$/.test(up)) return up + '\\';
  return up || sep;
}

export function basename(path) {
  const norm = normalizePath(path);
  const sep = /^[A-Za-z]:/.test(norm) || norm.includes('\\') ? '\\' : '/';
  const idx = norm.lastIndexOf(sep);
  return idx === -1 ? norm : norm.slice(idx + 1);
}

// Parse a `text/uri-list` payload (RFC 2483: line-delimited URIs, lines
// starting with `#` are comments) into local FS paths. Anything that
// isn't `file://...` is dropped because OS drag sources from outside
// the filesystem are not actionable for our copy/move flow.
export function parseUriList(text) {
  if (!text) return [];
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map(uriToLocalPath)
    .filter(Boolean);
}

function uriToLocalPath(uri) {
  if (!uri.startsWith('file:')) return null;
  // Standard URL-decode and strip the `file://` scheme. UNC paths come
  // through as `file://server/share/...`; we leave the leading `\\` in
  // place. Drive paths come through as `file:///C:/...` -- drop the
  // single leading slash before the drive letter.
  let p;
  try { p = decodeURIComponent(uri.replace(/^file:\/\//, '')); }
  catch { return null; }
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  // Normalize to backslashes when the path is a Windows drive form
  // (Neutralino's filesystem APIs accept either, but our other helpers
  // expect backslash on Windows).
  if (/^[A-Za-z]:/.test(p)) return p.replace(/\//g, '\\');
  return p;
}

export function pathSegments(path) {
  const norm = normalizePath(path);
  if (/^[A-Za-z]:/.test(norm)) {
    return norm.replace(/[\\/]+$/, '').split(/[\\/]+/);
  }
  return norm.replace(/^\//, '').replace(/\/+$/, '').split('/').filter(Boolean);
}

export function formatSize(bytes) {
  if (!bytes) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i += 1; }
  return (n < 10 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
}

export function formatModified(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const diffDays = Math.floor((today - d) / 86400e3);
  if (diffDays < 7) return diffDays + 'd ago';
  return d.toLocaleDateString();
}

// ── Native bridge ───────────────────────────────────────────────────────────
function fakePath(parent, name) {
  return joinPath(parent, name);
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

// PowerShell escapes a literal `'` as `''` inside a single-quoted string.
function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

// Native helper detection. The MSVC-compiled exe at extras/shellhelp.exe
// replaces three PowerShell shell-outs (properties, trash, drives) and shaves
// ~200 ms cold-start cost off each. If it isn't there yet — typical right
// after `git pull` before someone has compiled it — we fall back to the
// PowerShell paths so the app keeps working.
const HELPER_PATH = 'extras\\shellhelp.exe';
let helperReady = null;
export async function helperAvailable() {
  if (!N) return false;
  // Cache only success: once the helper is found, subsequent calls
  // return immediately without a getStats round-trip. A missing
  // helper is *not* cached so that building the binary mid-session
  // (then clicking "Start a new terminal" again) picks it up
  // without requiring an app restart.
  if (helperReady === true) return true;
  try {
    await N.filesystem.getStats(HELPER_PATH);
    helperReady = true;
    return true;
  } catch {
    return false;
  }
}

async function runHelper(...args) {
  const argstr = args.map((a) => `"${a}"`).join(' ');
  return await exec(`"${HELPER_PATH}" ${argstr}`);
}

// Walks the Windows shell context menu via the helper exe's `menu` verb.
// Returns null when the helper isn't built yet (mock mode or pre-compile),
// so the caller can fall back to a curated static menu.
export async function helperMenu(paths) {
  if (!N || !(await helperAvailable())) return null;
  const r = await runHelper('menu', ...paths);
  if (r.exitCode !== 0) return null;
  try { return JSON.parse(r.stdOut.trim() || '[]'); }
  catch { return null; }
}

export async function helperInvoke(id, paths) {
  if (!N || !(await helperAvailable())) return false;
  const argstr = [id, ...paths].map((a) => `"${a}"`).join(' ');
  await N.os.execCommand(`"${HELPER_PATH}" invoke ${argstr}`, { background: true });
  return true;
}

// Generate a thumbnail via IShellItemImageFactory and return a blob URL
// that the caller can stick in an <img src=...>. The helper writes a
// short-lived PNG to %TEMP% and prints its path; we read the bytes back
// and wrap them in a Blob. Returns null when the helper isn't built or
// the thumbnail can't be produced (e.g. disk error). Caller is responsible
// for revoking the URL when done — thumbnails.js's LRU does that.
export async function thumbnail(path, size = 96) {
  if (!N || !(await helperAvailable())) return null;
  let r;
  try { r = await runHelper('thumb', String(size), path); }
  catch { return null; }
  if (r.exitCode !== 0) return null;
  const tempPath = (r.stdOut || '').trim();
  if (!tempPath) return null;
  let buf;
  try { buf = await N.filesystem.readBinaryFile(tempPath); }
  catch { return null; }
  // Cleanup the temp PNG; the Blob keeps an in-memory copy.
  N.filesystem.remove(tempPath).catch(() => {});
  return URL.createObjectURL(new Blob([buf], { type: 'image/png' }));
}

// Drag selected paths out to the OS via the helper's DoDragDrop wrapper.
// Blocks while the user holds the drag; resolves with the chosen
// DROPEFFECT (1=copy, 2=move, 4=link, 0=cancelled). Returns 0 when the
// helper is missing.
export async function dragOut(paths) {
  if (!N || !(await helperAvailable()) || !paths?.length) return 0;
  let r;
  try { r = await runHelper('dragout', ...paths); }
  catch { return 0; }
  return parseInt((r.stdOut || '').trim(), 10) || 0;
}

async function exec(cmd) {
  if (!N) { console.warn('[mock] exec', cmd); return { stdOut: '', stdErr: '', exitCode: 0 }; }
  try {
    return await N.os.execCommand(cmd, { background: false });
  } catch (e) {
    console.warn('exec failed:', cmd, e);
    return { stdOut: '', stdErr: String(e), exitCode: -1 };
  }
}

async function execBg(cmd) {
  if (!N) { console.warn('[mock] exec(bg)', cmd); return; }
  try { await N.os.execCommand(cmd, { background: true }); }
  catch (e) { console.warn('exec(bg) failed:', cmd, e); }
}

export async function homeDir() {
  if (!N) return '~';
  try {
    const home = await N.os.getEnv('USERPROFILE');
    return home || (await N.os.getEnv('HOME')) || '~';
  } catch { return '~'; }
}

// Beyond this many entries we skip the eager getStats round-trip and
// emit name/is_dir/extension immediately; size + modified_ms fill in
// asynchronously per `EAGER_STAT_CHUNK`. On a 10k-file folder the eager
// path costs 10k IPC trips (10+ s cold); the lazy path paints in tens
// of ms and back-fills the rest in the background.
const EAGER_STAT_THRESHOLD = 200;
const EAGER_STAT_CHUNK = 100;

export async function listDir(path, opts = {}) {
  if (!N) {
    const items = SAMPLE[path];
    if (!items) return [];
    return items.map((it) => ({ ...it, path: fakePath(path, it.name) }));
  }
  let entries;
  try {
    entries = await N.filesystem.readDirectory(path);
  } catch (e) {
    // Windows scatters legacy reparse-point junctions across every
    // user profile (`Application Data`, `Cookies`, `My Documents`,
    // `Start Menu`, `Recent`, …) and the AppData tree
    // (`Local/History`, `Local/Temporary Internet Files`, …). Their
    // DACL denies list-folder so XP→Vista profile-upgrade tools
    // can't loop forever; Explorer hides them. We see them through
    // `readDirectory` and fail to enumerate with `NE_FS_NOPATHE`
    // (permission denied) or `NE_RT_NATRTER` (e.g. WindowsApps,
    // protected by TrustedInstaller). Same story for any folder
    // genuinely denied to the user — surfacing these as `console.warn`
    // floods the dev console on every tree expansion of the home
    // folder. Drop to `console.debug` for the known-noisy codes so
    // they're still inspectable when wanted but don't crowd out
    // signal; keep `warn` for anything else.
    const code = e?.code;
    if (code === 'NE_FS_NOPATHE' || code === 'NE_RT_NATRTER') {
      console.debug('readDirectory skipped:', path, code);
    } else {
      console.warn('readDirectory failed:', path, e);
    }
    return [];
  }
  // Skip the "." and ".." sentinel entries Neutralino includes on some
  // platforms.
  const real = entries.filter((e) => e.entry !== '.' && e.entry !== '..');
  const out = real.map((e) => {
    const name = e.entry || e.name || '';
    const full = e.path || joinPath(path, name);
    const isDir = e.type === 'DIRECTORY';
    return {
      name,
      is_dir: isDir,
      size: 0,
      modified_ms: 0,
      extension: isDir ? '' : extOf(name),
      path: full,
    };
  });
  // Folders first, then case-insensitive name sort. We sort before the
  // stat fill so the first paint is deterministic (size/modified sorts
  // re-stabilize as stats land — same trade-off Explorer makes while
  // it walks a big folder).
  out.sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  if (out.length <= EAGER_STAT_THRESHOLD) {
    await Promise.all(out.map((it) => fillStat(it)));
    return out;
  }
  // Big folder: return now, fill stats in the background. Caller can
  // opt in via `opts.onProgress` to drive a coalesced re-render, and
  // `opts.signal` to cancel when the pane navigates away.
  void fillStatsAsync(out, opts);
  return out;
}

async function fillStat(entry) {
  try {
    const s = await N.filesystem.getStats(entry.path);
    entry.size = s.size || 0;
    entry.modified_ms = s.modifiedAt || 0;
  } catch {}
}

async function fillStatsAsync(out, { signal, onProgress } = {}) {
  for (let i = 0; i < out.length; i += EAGER_STAT_CHUNK) {
    if (signal?.aborted) return;
    const slice = out.slice(i, i + EAGER_STAT_CHUNK);
    await Promise.all(slice.map((it) => fillStat(it)));
    if (signal?.aborted) return;
    onProgress?.();
    // Yield to the UI between chunks so input + paint stay responsive.
    await new Promise((r) => setTimeout(r, 0));
  }
}

// Read text from a file, capped at maxBytes characters (rough — string
// length, not bytes after UTF-8 decode). Used by the preview pane to
// avoid blowing up the WebView with multi-megabyte logs / data files.
// Returns null when the read fails (file gone, permission denied, etc.)
// so callers can render a graceful fallback.
export async function readTextFile(path, maxBytes = 1024 * 1024) {
  if (!N) return '[mock preview]\n' + path;
  try {
    const text = await N.filesystem.readFile(path);
    if (typeof text !== 'string') return String(text || '');
    if (text.length > maxBytes) {
      return text.slice(0, maxBytes) + `\n\n… (truncated to ${maxBytes} chars)`;
    }
    return text;
  } catch (e) {
    console.warn('readTextFile failed:', path, e);
    return null;
  }
}

export async function makeDir(path) {
  if (!N) { console.warn('[mock] mkdir', path); return; }
  await N.filesystem.createDirectory(path);
}

export async function rename(from, to) {
  if (!N) { console.warn('[mock] rename', from, '->', to); return; }
  await N.filesystem.move(from, to);
}

export async function copy(from, to) {
  if (!N) { console.warn('[mock] copy', from, '->', to); return; }
  await N.filesystem.copy(from, to);
}

export async function move(from, to) {
  if (!N) { console.warn('[mock] move', from, '->', to); return; }
  await N.filesystem.move(from, to);
}

// True when `path` resolves to an existing file or directory.
// Callers use this for conflict detection (the transfer pipeline)
// and unique-name probing ("Keep Both"). Mock mode always reports
// missing — the SAMPLE table is in-memory only.
export async function pathExists(path) {
  if (!N) return false;
  try { await N.filesystem.getStats(path); return true; }
  catch { return false; }
}

// Send a path to the Recycle Bin. Prefers the native helper (one
// IFileOperation call, ~50 ms); falls back to PowerShell +
// Microsoft.VisualBasic.FileIO when the helper hasn't been built yet
// (~250-400 ms, but still uses the documented Microsoft recycle path).
export async function deleteToTrash(path) {
  if (!N) { console.warn('[mock] trash', path); return; }
  if (await helperAvailable()) {
    await runHelper('trash', path);
    return;
  }
  let isDir = false;
  try {
    const s = await N.filesystem.getStats(path);
    isDir = !!s.isDirectory;
  } catch {}
  const fn = isDir ? 'DeleteDirectory' : 'DeleteFile';
  const ps = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${fn}(${psQuote(path)}, 'OnlyErrorDialogs', 'SendToRecycleBin')`;
  await exec(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`);
}

export async function deletePermanent(path) {
  if (!N) { console.warn('[mock] delete!', path); return; }
  await N.filesystem.remove(path);
}

export async function listDrives() {
  if (!N) {
    return [
      { name: '(C:)', path: 'C:\\', free_bytes: 0, total_bytes: 0 },
      { name: '(D:)', path: 'D:\\', free_bytes: 0, total_bytes: 0 },
    ];
  }
  if (await helperAvailable()) {
    const r = await runHelper('drives');
    try {
      const arr = JSON.parse(r.stdOut.trim() || '[]');
      return arr.map((d) => ({
        name: `(${d.letter}:)`,
        path: `${d.letter}:\\`,
        free_bytes: Number(d.free) || 0,
        total_bytes: Number(d.total) || 0,
      }));
    } catch { return []; }
  }
  const ps = "Get-PSDrive -PSProvider FileSystem | ForEach-Object { [pscustomobject]@{ Name = $_.Name; Free = [int64]$_.Free; Used = [int64]$_.Used } } | ConvertTo-Json -Compress";
  const r = await exec(`powershell -NoProfile -Command "${ps}"`);
  try {
    const raw = JSON.parse(r.stdOut.trim() || '[]');
    const arr = Array.isArray(raw) ? raw : [raw];
    return arr.map((d) => ({
      name: `(${d.Name}:)`,
      path: `${d.Name}:\\`,
      free_bytes: Number(d.Free) || 0,
      total_bytes: (Number(d.Free) || 0) + (Number(d.Used) || 0),
    }));
  } catch {
    return [];
  }
}

export async function openInOS(path) {
  if (!N) { console.warn('[mock] open', path); return; }
  try { await N.os.open(path); }
  catch (e) { console.warn('os.open failed:', path, e); }
}

export async function revealInOS(path) {
  if (!N) { console.warn('[mock] reveal', path); return; }
  await execBg(`explorer.exe /select,"${path}"`);
}

// ── Curated context-menu actions (new vs Tauri version) ─────────────────────

// Show the real Windows Properties dialog. Prefers the native helper
// (~50 ms via ShellExecuteEx + "properties" verb); falls back to
// `Start-Process -Verb Properties` when the helper hasn't been built
// yet (~250-400 ms). The earlier `Shell.Application.InvokeVerb`
// fallback was modeless and got torn down when PowerShell exited a
// beat later -- the dialog flickered and disappeared. Start-Process
// hands the verb to ShellExecuteEx, which gives the dialog the OS
// shell as parent, so it persists after PowerShell returns.
export async function showProperties(path) {
  if (!N) { console.warn('[mock] properties', path); return; }
  if (await helperAvailable()) {
    await N.os.execCommand(`"${HELPER_PATH}" properties "${path}"`, { background: true });
    return;
  }
  // Single-quoted PS string preserves backslashes; escape any embedded
  // single quotes by doubling them per PS lexical rules.
  const psPath = path.replace(/'/g, "''");
  const ps = `Start-Process -FilePath '${psPath}' -Verb Properties`;
  await execBg(`powershell -NoProfile -WindowStyle Hidden -Command "${ps.replace(/"/g, '\\"')}"`);
}

export async function openInVSCode(path) {
  if (!N) { console.warn('[mock] code', path); return; }
  await execBg(`code "${path}"`);
}

export async function openInTerminal(path) {
  if (!N) { console.warn('[mock] wt', path); return; }
  // Prefer Windows Terminal; cmd.exe is the universal fallback.
  const r = await exec(`where wt.exe`);
  if (r.exitCode === 0 && r.stdOut.trim()) {
    await execBg(`wt.exe -d "${path}"`);
  } else {
    await execBg(`cmd /K cd /D "${path}"`);
  }
}

export async function openInPowerShell(path) {
  if (!N) { console.warn('[mock] powershell', path); return; }
  // Prefer Windows Terminal hosting PowerShell (modern, themed); fall
  // back to a bare `powershell.exe` window when wt isn't installed.
  // `-NoExit` so the prompt stays after `Set-Location`; the working
  // directory arg ensures the prompt opens already at `path` instead
  // of the user's profile home.
  const r = await exec(`where wt.exe`);
  if (r.exitCode === 0 && r.stdOut.trim()) {
    await execBg(`wt.exe -d "${path}" powershell.exe -NoExit`);
  } else {
    await execBg(`powershell.exe -NoExit -Command "Set-Location -LiteralPath '${path.replace(/'/g, "''")}'"`);
  }
}

export async function openInCmd(path) {
  if (!N) { console.warn('[mock] cmd', path); return; }
  // Bare cmd.exe at `path`. The Windows-Terminal-hosted path is
  // identical to openInTerminal's fallback, so we just call it
  // directly with no wt detection — keeps the user's intent explicit
  // ("I asked for cmd, give me cmd") instead of silently upgrading
  // to wt.
  await execBg(`cmd /K cd /D "${path}"`);
}

export async function openInBash(path) {
  if (!N) { console.warn('[mock] bash', path); return; }
  // Git for Windows ships `bash.exe`; locate it via `where`. Falls
  // back to mintty (Git Bash's terminal of choice) when wt isn't
  // available, since plain `bash.exe` in a cmd console gives a
  // degraded experience (no colors, no resize, line-input only).
  // The `-c` form starts an interactive login shell with `cd` to
  // the target path; `exec bash` keeps the shell alive after `cd`
  // so the prompt stays open for further commands.
  const where = await exec(`where bash.exe`);
  if (where.exitCode !== 0 || !where.stdOut.trim()) {
    console.warn('openInBash: bash.exe not found in PATH (install Git for Windows)');
    return;
  }
  const bashPath = where.stdOut.split(/\r?\n/)[0].trim();
  const wt = await exec(`where wt.exe`);
  const escaped = path.replace(/\\/g, '/').replace(/"/g, '\\"');
  if (wt.exitCode === 0 && wt.stdOut.trim()) {
    await execBg(`wt.exe -d "${path}" "${bashPath}" --login -i -c "cd \\"${escaped}\\"; exec bash"`);
  } else {
    await execBg(`"${bashPath}" --login -i -c "cd \\"${escaped}\\"; exec bash"`);
  }
}

export async function copyPath(path) {
  if (!N) { console.warn('[mock] copy path', path); return; }
  try { await N.clipboard.writeText(path); }
  catch (e) { console.warn('clipboard.writeText failed:', e); }
}
