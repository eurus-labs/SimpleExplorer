# SimpleExplorer — Design

Single source of truth for current status, architecture, and conventions
specific to this codebase. See [`../CLAUDE.md`](../CLAUDE.md) for repository-
wide AI-assistant conventions (branch discipline, Conventional Commits, etc.).
Forward-looking work — what's painted but not wired, and what's deferred —
lives in [`./roadmap.md`](./roadmap.md).

## North star

An explorer for Windows. **Simple and fast.** Optimize every change for those
two words. If a change adds complexity without making the explorer measurably
simpler to use or faster to launch/browse, drop it.

## Status

v1 in progress. The shell is a Neutralinojs Windows desktop app; the frontend
is vanilla HTML/CSS/JS rendering three switchable design directions. Real
local FS access is wired through `Neutralino.filesystem` plus a few PowerShell
shell-outs for shell-integration features Neutralino does not cover natively.

## Stack

- **Shell:** Neutralinojs. One native Windows `.exe` (~2 MB) wrapping the OS
  WebView2 (already installed on Win11). No Rust, no MSVC, no .NET.
- **Frontend:** vanilla HTML/CSS/JS, ES modules, **no bundler**, **no React**.
- **Filesystem:** real local FS via the `Neutralino.filesystem` API plus a few
  PowerShell shell-outs for things Neutralino doesn't cover natively (recycle
  bin, drive list, Properties dialog).

## Run / build

- `npm start` — one-command path. Runs `scripts/run.ps1`, which is
  idempotent: `npm install` if needed, `neu update` if needed, build
  `extras/shellhelp.exe` if MSVC `cl` is on PATH and the binary is
  missing/stale, then `neu run`.
- Granular: `npm install` (once), `npm run setup` (one-time runtime
  download), `npm run dev` (hot-reload), `npm run build` (release exe).
- `src/index.html` opens directly in a browser too — `src/fs.js` falls
  back to mock data when `window.Neutralino` is missing.

## Layout

```
neutralino.config.json    Neutralino app + window + binary config
src/                      frontend, no build step
  ├── index.html          entry; loads neutralino.js then app.js
  ├── app.js              top-level: panes, settings, action dispatch, key bindings
  ├── pane.js             shared pane engine: row rendering, navigation, context menu
  ├── fs.js               Neutralino-FS adapter + mock fallback + path helpers
  ├── icons.js            inline SVG icons (lifted from design bundle)
  ├── sidebar-data.js     static sidebar + rail item lists
  ├── styles-core.css     shared engine + overlays; cross-direction selectors
  ├── styles-fluent.css   Direction A — Fluent (.a-* + [data-direction="fluent"])
  ├── styles-cmd.css      Direction B — Cmd     (.b-* + [data-direction="cmd"])
  └── directions/
        ├── fluent.js     A · Fluent Refined (Win11 Mica chrome)
        └── cmd.js        B · Command-bar first (Linear/Arc inspired)
docs/
  └── design.md           this file (single source of truth per CLAUDE.md)
```

`bin/` (Neutralino runtime), `dist/` (build output), and `src/neutralino.js`
(generated client lib) are gitignored.

## Native helpers

Several right-click actions — Properties, Delete-to-Recycle-Bin, drive
list, and the full Windows shell context menu — used to either shell out
to PowerShell or be missing entirely. Each PowerShell call paid ~200 ms
of cold-start, dominating perceived latency, and the curated JS-only
menu was missing the OS shell-extension entries (Open with VS Code, Git
Bash, 7-Zip, TortoiseSVN, Send to, …) that users expect from stock
Explorer. To stay near native speed without re-introducing Rust/MSVC at
install time, we ship a small MSVC-built binary at `extras/shellhelp.exe`:

| Verb | Implementation | Replaces |
| --- | --- | --- |
| `properties <path>` | `ShellExecuteEx("properties")` | PowerShell + `Shell.Application` COM |
| `trash <path…>` | `IFileOperation::DeleteItem` (batched, recycle-bin flag) | PowerShell + `Microsoft.VisualBasic.FileIO` |
| `drives` | `GetLogicalDriveStringsW` + `GetDiskFreeSpaceExW` → JSON | PowerShell + `Get-PSDrive` |
| `menu <path…>` | `IShellFolder::GetUIObjectOf` → `IContextMenu::QueryContextMenu` → JSON tree | curated static JS list |
| `invoke <id> <path…>` | `IContextMenu::InvokeCommand` with the chosen verb id | (no equivalent before) |
| `thumb <size> <path>` | `IShellItemImageFactory::GetImage` → WIC PNG → `%TEMP%` path printed to stdout | kind icons only |
| `dragout <path…>` | `BHID_DataObject` → `DoDragDrop`; `DROPEFFECT` printed to stdout | (no equivalent before) |

The curated SimpleExplorer items (Open in active pane, Copy path, Rename,
Delete, Show in Explorer, Properties) still live in `src/pane.js` and
render at the top of the menu — they're *ours*, not the OS's, and they
don't appear in `IContextMenu`. Below them, the helper's JSON tree fills
in asynchronously: typically < 300 ms, < 1 s worst case. Submenus
(`Send to`, `7-Zip`, `TortoiseSVN`) expand on hover after a 200 ms delay
and use `IContextMenu3::HandleMenuMsg2(WM_INITMENUPOPUP)` to populate
lazy entries. A 3-second TTL cache keyed by selection paths avoids
re-walking COM on repeat right-clicks.

Source: [`tools/shellhelp.cpp`](../tools/shellhelp.cpp). Build instructions:
[`tools/build.md`](../tools/build.md). The compiled exe is checked into
`extras/` so end users never need a C++ toolchain.

`src/fs.js` calls the helper when present and falls back to the original
PowerShell paths when not — this keeps the app working immediately after
`git pull` and before someone with MSVC has rebuilt the helper.

Latency budget after the change:

- Right-click → curated items visible: < 30 ms
- Right-click → shell-extension items filled: < 300 ms typical, < 1 s worst case
- Right-click → Properties dialog visible: < 100 ms (was 250–400 ms)
- Delete (single file): < 100 ms (was 250–400 ms)
- Drive list paint: < 150 ms (was 250–400 ms)

Open / Open in VS Code / Open in Terminal / Show in Explorer / Copy path /
Rename are already direct spawns or pure JS — no helper needed.

### Terminal launchers (replaces Phase 8b embedded terminal)

SimpleExplorer launches external terminals at the active pane's path
instead of hosting one in-process. Four actions live in the palette
(`Ctrl+K`), the pane context menu, and the toolbar/rail "Terminal"
button's dropdown:

- **Open in Terminal** — prefer `wt.exe -d <path>` (Windows Terminal),
  fall back to `cmd /K cd /D <path>` when wt isn't installed.
- **Open in PowerShell** — `wt.exe -d <path> powershell.exe -NoExit`,
  fall back to `powershell.exe -NoExit -Command "Set-Location …"`.
- **Open in Cmd** — `cmd /K cd /D <path>`, no wt detection (explicit
  intent: "I asked for cmd, give me cmd").
- **Open in Git Bash** — resolves `bash.exe` via `where`, prefers a
  wt-hosted `bash.exe --login -i -c "cd …; exec bash"` invocation,
  falls back to bare git-bash when wt isn't installed. Warns in the
  console when Git for Windows isn't on `PATH`.

The toolbar terminal icon is a dropdown trigger (`showShellPickerMenu`
in `src/pane.js` reuses the right-click menu primitives so the popup
inherits the same outside-click / Escape dismiss handling). Each entry
dispatches the matching `'powershell' | 'cmd' | 'bash' | 'terminal'`
action through the existing `explorer:action` event channel —
`src/app.js` routes those through `fs.openIn*`. The keyboard route via
`Ctrl+K` palette stays for users who prefer not to mouse.

The embedded xterm.js + ConPTY integration that Phase 8b originally
shipped was removed after an extended debugging session pinned the
input direction as broken under Neutralino's `cmd /c` spawn wrapper on
Windows 11 build 26100: bytes written to the PTY input pipe were
drained by conhost but never delivered as console input records to the
child shell, regardless of console attachment state, focus-event
suppression, Win32 input-mode encoding, or shell choice (both `cmd.exe`
and `powershell.exe` failed identically). The manual
`extras\shellhelp.exe pty cmd.exe` launch from a real PowerShell window
worked end-to-end with the same binary, so the fault was specific to
Neutralino's spawn context — out of our reach without forking
Neutralino. External launchers ship the same end-user value (typing
into a shell rooted at the current pane) at a fraction of the surface
area.

### Dev vs production DevTools

`modes.window.enableInspector` in `neutralino.config.json` is `false`,
so end users running a `npm run build` binary never get a DevTools
window. `npm run dev` re-enables it via the runtime CLI override
(`neu run -- --window-enable-inspector=true`) so day-to-day iteration
keeps the inspector available without permanently flipping the config.
If a maintainer needs DevTools against a built binary for a one-off
debug session, the same flag works against the produced exe.

## Design source of truth (visual)

The visual reference originates from a Claude Design handoff bundle. Port
colors, spacing, fonts, and SVG icons exactly from the prototype JSX rather
than inventing new values:

- `explorer-shared.jsx` — colors, icon set, sample paths
- `explorer-fluent.jsx` — Direction A spec (palette near the top)
- `explorer-cmd.jsx` — Direction B spec

When tweaking visuals, port from those files.

## Conventions (project-specific)

- **No React/JSX, no UI framework.** Vanilla DOM updates are fast enough for
  a file list and keep the surface area small.
- **CSS variables for theming.** Every direction defines a palette block in
  its own file (`styles-fluent.css` / `styles-cmd.css`) keyed on
  `[data-direction][data-theme]`. Components reference
  `var(--bg)`, `var(--text)`, `var(--accent)`, etc. — never hard-code colors.
- **One module per direction.** Chrome differences live in
  `src/directions/<name>.js`. Shared row/pane logic lives in `src/pane.js`.
  A pane owns a list of tabs; the active tab's fields (`path`,
  `history`, `selected`, `entries`, `filter`) are mirrored on the
  pane object so existing call sites read them directly without
  threading a tab argument.
- **All FS calls go through `src/fs.js`.** Don't call `Neutralino.*` directly
  from UI code — that adapter handles the Neutralino/mock split.
- **Settings persist via `localStorage`** under the `simple-explorer.*` keys.
  No state library. Tab state (per-pane `tabs[].path` + `activeTabIdx`) lives
  under `simple-explorer.tabs`; non-active tabs lazy-list their entries on
  first switch.
- **Right-click actions** dispatch a `CustomEvent('explorer:action', { detail })`
  on `document`; `app.js` routes them through `doAction()`. Add new menu
  items to the array in `pane.js` `showContextMenu()` and a `case` in
  `doAction()`.

## Don'ts

- Don't add a bundler (Vite, webpack). The frontend is intentionally
  build-step-free. If a file gets too big, split it into more ES modules.
- Don't import a UI framework or component library.
- Don't add a state-management library — `localStorage` + plain objects is
  enough.
- Don't add features the user hasn't asked for. The v1 deliberately ships
  *less* than stock Explorer (no thumbnails, no preview pane) to keep launch
  fast and code small. Re-justify any expansion against the north star.
- Don't reach for a native extension to add a context-menu action when a
  PowerShell shell-out via `Neutralino.os.execCommand` will do — see the
  Properties / Recycle Bin / drive list paths in `src/fs.js` for the pattern.
