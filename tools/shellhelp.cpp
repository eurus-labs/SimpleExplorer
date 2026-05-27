// tools/shellhelp.cpp
//
// Native Win32 helper for SimpleExplorer's right-click actions. Replaces
// PowerShell shell-outs in src/fs.js, eliminating the ~200 ms PowerShell
// cold-start tax that dominates Properties / Delete / drive-list latency,
// and exposes the full Windows shell context menu (every installed shell
// extension — Open with VS Code, Git Bash, 7-Zip, TortoiseSVN, Send to,
// …) via IContextMenu so it matches stock Explorer 1:1.
//
// Build (one-time, MSVC):
//   cl /nologo /EHsc /O2 /utf-8 shellhelp.cpp ^
//     /link shell32.lib ole32.lib user32.lib gdi32.lib windowscodecs.lib
//
// Verbs:
//   shellhelp properties <path>             — show real Windows Properties
//   shellhelp trash <path> [<path> ...]     — send to Recycle Bin (batched)
//   shellhelp drives                        — emit drive-list JSON to stdout
//   shellhelp menu <path> [<path> ...]      — emit context-menu JSON tree
//   shellhelp invoke <id> <path> [<path>...] — invoke menu command id
//   shellhelp thumb <size> <path>           — write PNG thumb to %TEMP%; print path
//   shellhelp dragout <path> [<path> ...]   — start CF_HDROP DoDragDrop; print effect

#include <windows.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <objbase.h>
#include <wincodec.h>
#include <oleidl.h>
#include <stdio.h>
#include <wchar.h>
#include <string.h>
#include <stdlib.h>

// ID range for QueryContextMenu. 1-based — id 0 means "no command".
#define CTX_ID_MIN  1
#define CTX_ID_MAX  0x7FFF

static int verb_properties(int argc, wchar_t** argv) {
    if (argc < 3) {
        fwprintf(stderr, L"shellhelp: properties needs <path>\n");
        return 2;
    }
    SHELLEXECUTEINFOW sei = { sizeof(sei) };
    sei.fMask = SEE_MASK_INVOKEIDLIST;
    sei.lpVerb = L"properties";
    sei.lpFile = argv[2];
    sei.nShow = SW_SHOW;
    if (!ShellExecuteExW(&sei)) {
        fwprintf(stderr, L"shellhelp: properties failed (%lu)\n", GetLastError());
        return 1;
    }
    return 0;
}

static int verb_trash(int argc, wchar_t** argv) {
    if (argc < 3) {
        fwprintf(stderr, L"shellhelp: trash needs <path> [<path> ...]\n");
        return 2;
    }
    HRESULT hr = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
    if (FAILED(hr)) return (int)hr;

    IFileOperation* op = NULL;
    hr = CoCreateInstance(CLSID_FileOperation, NULL, CLSCTX_ALL, IID_PPV_ARGS(&op));
    if (FAILED(hr)) {
        CoUninitialize();
        return (int)hr;
    }
    op->SetOperationFlags(FOF_ALLOWUNDO | FOF_NOCONFIRMATION |
                          FOF_NOERRORUI | FOF_SILENT | FOFX_RECYCLEONDELETE);

    int failed = 0;
    for (int i = 2; i < argc; ++i) {
        IShellItem* item = NULL;
        if (FAILED(SHCreateItemFromParsingName(argv[i], NULL, IID_PPV_ARGS(&item)))) {
            ++failed;
            continue;
        }
        if (FAILED(op->DeleteItem(item, NULL))) ++failed;
        item->Release();
    }

    hr = op->PerformOperations();
    op->Release();
    CoUninitialize();
    if (FAILED(hr)) return (int)hr;
    return failed ? 1 : 0;
}

static int verb_drives(void) {
    wchar_t buf[1024] = { 0 };
    DWORD len = GetLogicalDriveStringsW(_countof(buf), buf);
    if (!len) return 1;

    fputs("[", stdout);
    int first = 1;
    for (wchar_t* p = buf; *p; p += wcslen(p) + 1) {
        UINT t = GetDriveTypeW(p);
        if (t != DRIVE_FIXED && t != DRIVE_REMOVABLE &&
            t != DRIVE_REMOTE && t != DRIVE_CDROM) continue;

        ULARGE_INTEGER freeBytes = { 0 }, totalBytes = { 0 };
        GetDiskFreeSpaceExW(p, NULL, &totalBytes, &freeBytes);

        if (!first) fputs(",", stdout);
        first = 0;
        // p is e.g. "C:\\"; first char is the drive letter.
        printf("{\"letter\":\"%c\",\"free\":%llu,\"total\":%llu}",
               (char)p[0],
               (unsigned long long)freeBytes.QuadPart,
               (unsigned long long)totalBytes.QuadPart);
    }
    fputs("]\n", stdout);
    return 0;
}

// ── Context-menu helpers ────────────────────────────────────────────────────

// Print a UTF-8, JSON-escaped string. Input is UTF-16; we transcode to UTF-8
// via WideCharToMultiByte and escape the JSON-special chars on the way out.
static void json_print_str(const wchar_t* w) {
    if (!w) { fputs("\"\"", stdout); return; }
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, NULL, 0, NULL, NULL);
    if (n <= 1) { fputs("\"\"", stdout); return; }
    char* u = (char*)malloc((size_t)n);
    if (!u) { fputs("\"\"", stdout); return; }
    WideCharToMultiByte(CP_UTF8, 0, w, -1, u, n, NULL, NULL);

    fputc('"', stdout);
    for (char* p = u; *p; ++p) {
        unsigned char c = (unsigned char)*p;
        switch (c) {
            case '"':  fputs("\\\"", stdout); break;
            case '\\': fputs("\\\\", stdout); break;
            case '\b': fputs("\\b",  stdout); break;
            case '\f': fputs("\\f",  stdout); break;
            case '\n': fputs("\\n",  stdout); break;
            case '\r': fputs("\\r",  stdout); break;
            case '\t': fputs("\\t",  stdout); break;
            default:
                if (c < 0x20) printf("\\u%04x", c);
                else fputc((int)c, stdout);
        }
    }
    fputc('"', stdout);
    free(u);
}

// A hidden message-only window the verb invocations can use as a
// parent HWND. Several shell verbs (Pin / Unpin to Quick access on
// Win10/11, Compress / "Send to" submenus when they want a status
// dialog, anything that calls IsWindow on the supplied hwnd) silently
// bail when ici.hwnd is NULL — the user clicks the menu entry and
// nothing happens. A message-only window stays invisible (no taskbar
// entry, no draw) while still satisfying COM's "I need a real parent"
// check. Created lazily on first use; the OS reclaims it on process
// exit so there's no explicit DestroyWindow path.
static HWND get_invoke_hwnd() {
    static HWND s_hwnd = NULL;
    if (!s_hwnd) {
        s_hwnd = CreateWindowExW(0, L"STATIC", L"", 0,
                                 0, 0, 0, 0,
                                 HWND_MESSAGE, NULL,
                                 GetModuleHandleW(NULL), NULL);
    }
    return s_hwnd;
}

// Build an IContextMenu over <n> sibling paths (must share one parent
// folder, which is how Explorer's multi-select works). Hands back the
// parent IShellFolder so callers can release it after the menu is done.
static HRESULT build_context_menu(int n, wchar_t** paths,
                                  IContextMenu** out_cm,
                                  IShellFolder** out_parent) {
    *out_cm = NULL;
    *out_parent = NULL;
    if (n <= 0) return E_INVALIDARG;

    // First path defines the parent folder.
    PIDLIST_ABSOLUTE pidl0 = NULL;
    HRESULT hr = SHParseDisplayName(paths[0], NULL, &pidl0, 0, NULL);
    if (FAILED(hr)) return hr;

    IShellFolder* parent = NULL;
    PCUITEMID_CHILD child0 = NULL;
    hr = SHBindToParent(pidl0, IID_PPV_ARGS(&parent), &child0);
    if (FAILED(hr)) { CoTaskMemFree(pidl0); return hr; }

    // Callers (selections in one pane) always share a parent folder, so
    // we don't validate it — just gather the child PIDLs.
    PCUITEMID_CHILD* children = (PCUITEMID_CHILD*)malloc(sizeof(PCUITEMID_CHILD) * (size_t)n);
    PIDLIST_ABSOLUTE* abs = (PIDLIST_ABSOLUTE*)malloc(sizeof(PIDLIST_ABSOLUTE) * (size_t)n);
    if (!children || !abs) {
        free(children); free(abs);
        parent->Release(); CoTaskMemFree(pidl0);
        return E_OUTOFMEMORY;
    }
    abs[0] = pidl0;
    children[0] = child0;
    UINT count = 1;
    for (int i = 1; i < n; ++i) {
        PIDLIST_ABSOLUTE pidlI = NULL;
        if (FAILED(SHParseDisplayName(paths[i], NULL, &pidlI, 0, NULL))) continue;
        IShellFolder* parentI = NULL;
        PCUITEMID_CHILD childI = NULL;
        if (FAILED(SHBindToParent(pidlI, IID_PPV_ARGS(&parentI), &childI))) {
            CoTaskMemFree(pidlI);
            continue;
        }
        parentI->Release();
        abs[count] = pidlI;
        children[count] = childI;
        count++;
    }

    IContextMenu* cm = NULL;
    // hwndOwner is NULL on purpose: when GetUIObjectOf gets a real
    // HWND, well-behaved shell extensions (TortoiseSVN, Bosch File
    // Services, etc.) do extra initialization work — registering for
    // window messages, prefetching icons, walking SCC status caches —
    // that they skip when there's no parent. With many extensions
    // installed the cumulative cost adds seconds to every menu paint.
    // The HWND is only strictly required at InvokeCommand time (for
    // verbs like Pin/Unpin to Quick access that gate on it), and
    // verb_invoke supplies it there via get_invoke_hwnd().
    hr = parent->GetUIObjectOf(NULL, count, (PCUITEMID_CHILD_ARRAY)children,
                               IID_IContextMenu, NULL, (void**)&cm);

    // PIDLs were absolute; SHBindToParent's child pointers are interior to
    // the absolute PIDL, so freeing each absolute PIDL also frees the child.
    for (UINT i = 0; i < count; ++i) CoTaskMemFree(abs[i]);
    free(children);
    free(abs);

    if (FAILED(hr)) { parent->Release(); return hr; }
    *out_cm = cm;
    *out_parent = parent;
    return S_OK;
}

// Recursively walk an HMENU populated by QueryContextMenu and emit JSON.
// Calls IContextMenu3::HandleMenuMsg2(WM_INITMENUPOPUP) before recursing
// into each submenu — without this, lazy submenus (Send to, 7-Zip,
// TortoiseSVN, …) come back empty.
static void emit_menu(IContextMenu* cm, HMENU hm) {
    IContextMenu3* cm3 = NULL;
    cm->QueryInterface(IID_PPV_ARGS(&cm3)); // optional; may be NULL

    int n = GetMenuItemCount(hm);
    fputs("[", stdout);
    int first = 1;
    for (int i = 0; i < n; ++i) {
        MENUITEMINFOW mii = { sizeof(mii) };
        mii.fMask = MIIM_FTYPE | MIIM_ID | MIIM_SUBMENU | MIIM_STRING | MIIM_STATE;
        mii.dwTypeData = NULL;
        if (!GetMenuItemInfoW(hm, (UINT)i, TRUE, &mii)) continue;

        if (!first) fputs(",", stdout);
        first = 0;

        if (mii.fType & MFT_SEPARATOR) {
            fputs("{\"separator\":true}", stdout);
            continue;
        }

        // Re-query with a buffer for the label.
        wchar_t label[512] = { 0 };
        mii.cch = _countof(label);
        mii.dwTypeData = label;
        mii.fMask = MIIM_FTYPE | MIIM_ID | MIIM_SUBMENU | MIIM_STRING | MIIM_STATE;
        GetMenuItemInfoW(hm, (UINT)i, TRUE, &mii);

        bool disabled = (mii.fState & (MFS_DISABLED | MFS_GRAYED)) != 0;

        fputs("{", stdout);
        fputs("\"label\":", stdout);
        json_print_str(label);

        if (mii.hSubMenu) {
            // Populate lazy submenus before recursing.
            if (cm3) {
                LRESULT lr = 0;
                cm3->HandleMenuMsg2(WM_INITMENUPOPUP,
                                    (WPARAM)mii.hSubMenu,
                                    (LPARAM)i, &lr);
            }
            fputs(",\"submenu\":", stdout);
            emit_menu(cm, mii.hSubMenu);
        } else {
            // Leaf entry — emit id + canonical verb if available.
            UINT idx = mii.wID >= CTX_ID_MIN ? (mii.wID - CTX_ID_MIN) : 0;
            printf(",\"id\":%u", idx);
            wchar_t verb[128] = { 0 };
            HRESULT hv = cm->GetCommandString(idx, GCS_VERBW, NULL,
                                              (LPSTR)verb, _countof(verb));
            if (SUCCEEDED(hv) && verb[0]) {
                fputs(",\"verb\":", stdout);
                json_print_str(verb);
            }
        }
        if (disabled) fputs(",\"disabled\":true", stdout);
        fputs("}", stdout);
    }
    fputs("]", stdout);

    if (cm3) cm3->Release();
}

static int verb_menu(int argc, wchar_t** argv) {
    if (argc < 3) {
        fwprintf(stderr, L"shellhelp: menu needs <path> [<path> ...]\n");
        return 2;
    }
    HRESULT hr = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
    if (FAILED(hr)) return (int)hr;

    IContextMenu* cm = NULL;
    IShellFolder* parent = NULL;
    hr = build_context_menu(argc - 2, argv + 2, &cm, &parent);
    if (FAILED(hr) || !cm) {
        CoUninitialize();
        fwprintf(stderr, L"shellhelp: menu build failed (0x%08lx)\n", (unsigned long)hr);
        return 1;
    }

    HMENU hm = CreatePopupMenu();
    hr = cm->QueryContextMenu(hm, 0, CTX_ID_MIN, CTX_ID_MAX,
                              CMF_NORMAL | CMF_EXTENDEDVERBS);
    if (FAILED(hr)) {
        DestroyMenu(hm);
        cm->Release();
        parent->Release();
        CoUninitialize();
        return 1;
    }

    emit_menu(cm, hm);
    fputs("\n", stdout);

    DestroyMenu(hm);
    cm->Release();
    parent->Release();
    CoUninitialize();
    return 0;
}

static int verb_invoke(int argc, wchar_t** argv) {
    if (argc < 4) {
        fwprintf(stderr, L"shellhelp: invoke needs <id> <path> [<path> ...]\n");
        return 2;
    }
    UINT id = (UINT)_wtoi(argv[2]);
    HRESULT hr = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
    if (FAILED(hr)) return (int)hr;

    IContextMenu* cm = NULL;
    IShellFolder* parent = NULL;
    hr = build_context_menu(argc - 3, argv + 3, &cm, &parent);
    if (FAILED(hr) || !cm) {
        CoUninitialize();
        return 1;
    }

    // Build the menu so any registered IDs are valid in the IContextMenu's
    // internal state, even though we don't consult the HMENU.
    HMENU hm = CreatePopupMenu();
    cm->QueryContextMenu(hm, 0, CTX_ID_MIN, CTX_ID_MAX,
                         CMF_NORMAL | CMF_EXTENDEDVERBS);

    CMINVOKECOMMANDINFOEX ici = { sizeof(ici) };
    // CMIC_MASK_UNICODE  -> shell reads the lpVerbW field.
    // CMIC_MASK_FLAG_LOG_USAGE  -> verbs that update MRU lists
    //   (e.g. Pin to Quick access maintains a pinned-folders list) get
    //   their bookkeeping done. Without it some verbs no-op silently.
    ici.fMask = CMIC_MASK_UNICODE | CMIC_MASK_FLAG_LOG_USAGE;
    ici.hwnd = get_invoke_hwnd();
    ici.lpVerb  = MAKEINTRESOURCEA(id);
    ici.lpVerbW = MAKEINTRESOURCEW(id);
    ici.nShow = SW_SHOWNORMAL;
    hr = cm->InvokeCommand((CMINVOKECOMMANDINFO*)&ici);

    DestroyMenu(hm);
    cm->Release();
    parent->Release();
    CoUninitialize();
    return SUCCEEDED(hr) ? 0 : 1;
}

// Save HBITMAP to a PNG file via WIC. Caller owns the bitmap. Returns
// HRESULT; on success, the file at `outPath` contains the encoded PNG.
static HRESULT save_hbitmap_png(HBITMAP hbm, const wchar_t* outPath) {
    IWICImagingFactory* factory = NULL;
    HRESULT hr = CoCreateInstance(CLSID_WICImagingFactory, NULL, CLSCTX_INPROC_SERVER,
                                  IID_PPV_ARGS(&factory));
    if (FAILED(hr)) return hr;

    IWICBitmap* bitmap = NULL;
    hr = factory->CreateBitmapFromHBITMAP(hbm, NULL, WICBitmapUseAlpha, &bitmap);
    if (SUCCEEDED(hr)) {
        IWICStream* stream = NULL;
        hr = factory->CreateStream(&stream);
        if (SUCCEEDED(hr)) {
            hr = stream->InitializeFromFilename(outPath, GENERIC_WRITE);
            if (SUCCEEDED(hr)) {
                IWICBitmapEncoder* enc = NULL;
                hr = factory->CreateEncoder(GUID_ContainerFormatPng, NULL, &enc);
                if (SUCCEEDED(hr)) {
                    hr = enc->Initialize(stream, WICBitmapEncoderNoCache);
                    if (SUCCEEDED(hr)) {
                        IWICBitmapFrameEncode* frame = NULL;
                        IPropertyBag2* props = NULL;
                        hr = enc->CreateNewFrame(&frame, &props);
                        if (SUCCEEDED(hr)) {
                            frame->Initialize(props);
                            UINT w = 0, h = 0;
                            bitmap->GetSize(&w, &h);
                            frame->SetSize(w, h);
                            WICPixelFormatGUID fmt = GUID_WICPixelFormat32bppBGRA;
                            frame->SetPixelFormat(&fmt);
                            frame->WriteSource(bitmap, NULL);
                            frame->Commit();
                            enc->Commit();
                            frame->Release();
                            if (props) props->Release();
                        }
                    }
                    enc->Release();
                }
            }
            stream->Release();
        }
        bitmap->Release();
    }
    factory->Release();
    return hr;
}

static int verb_thumb(int argc, wchar_t** argv) {
    if (argc < 4) {
        fwprintf(stderr, L"shellhelp: thumb needs <size> <path>\n");
        return 2;
    }
    int size = _wtoi(argv[2]);
    if (size <= 0 || size > 1024) size = 96;
    const wchar_t* path = argv[3];

    HRESULT hr = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
    if (FAILED(hr)) return (int)hr;

    IShellItemImageFactory* factory = NULL;
    hr = SHCreateItemFromParsingName(path, NULL, IID_PPV_ARGS(&factory));
    if (FAILED(hr)) { CoUninitialize(); return (int)hr; }

    SIZE sz = { size, size };
    HBITMAP hbm = NULL;
    // SIIGBF_THUMBNAILONLY would refuse to fall back to an icon. We
    // accept fallback so the cache still has *something* for icons.
    hr = factory->GetImage(sz, SIIGBF_RESIZETOFIT | SIIGBF_BIGGERSIZEOK, &hbm);
    factory->Release();
    if (FAILED(hr) || !hbm) { CoUninitialize(); return (int)hr; }

    // Write to %TEMP%\sephthumb_<tick>.png; tick keeps the name unique
    // across rapid calls without bloating the cache helper-side.
    wchar_t tempDir[MAX_PATH];
    GetTempPathW(_countof(tempDir), tempDir);
    wchar_t outPath[MAX_PATH];
    swprintf_s(outPath, _countof(outPath), L"%ssephthumb_%llu.png",
               tempDir, (unsigned long long)GetTickCount64());

    hr = save_hbitmap_png(hbm, outPath);
    DeleteObject(hbm);
    CoUninitialize();
    if (FAILED(hr)) return (int)hr;

    // Print the path — JS reads it via filesystem.readBinaryFile.
    wprintf(L"%ls\n", outPath);
    return 0;
}

static int verb_dragout(int argc, wchar_t** argv) {
    if (argc < 3) {
        fwprintf(stderr, L"shellhelp: dragout needs <path> [<path> ...]\n");
        return 2;
    }
    HRESULT hr = OleInitialize(NULL);
    if (FAILED(hr)) return (int)hr;

    IShellItemArray* arr = NULL;
    PIDLIST_ABSOLUTE* pidls = (PIDLIST_ABSOLUTE*)CoTaskMemAlloc(sizeof(PIDLIST_ABSOLUTE) * (argc - 2));
    int count = 0;
    for (int i = 2; i < argc; ++i) {
        PIDLIST_ABSOLUTE pidl = NULL;
        if (SUCCEEDED(SHParseDisplayName(argv[i], NULL, &pidl, 0, NULL))) {
            pidls[count++] = pidl;
        }
    }
    if (!count) { CoTaskMemFree(pidls); OleUninitialize(); return 1; }

    hr = SHCreateShellItemArrayFromIDLists(count, (PCIDLIST_ABSOLUTE_ARRAY)pidls, &arr);
    for (int i = 0; i < count; ++i) ILFree(pidls[i]);
    CoTaskMemFree(pidls);
    if (FAILED(hr) || !arr) { OleUninitialize(); return (int)hr; }

    IDataObject* data = NULL;
    hr = arr->BindToHandler(NULL, BHID_DataObject, IID_PPV_ARGS(&data));
    arr->Release();
    if (FAILED(hr) || !data) { OleUninitialize(); return (int)hr; }

    DWORD effect = 0;
    hr = DoDragDrop(data, NULL, DROPEFFECT_COPY | DROPEFFECT_MOVE | DROPEFFECT_LINK, &effect);
    data->Release();
    OleUninitialize();
    // Print effect so JS can decide whether to refresh the source pane:
    //   1 = copy, 2 = move, 4 = link, 0 = none/cancelled.
    wprintf(L"%lu\n", effect);
    return SUCCEEDED(hr) ? 0 : 1;
}

int wmain(int argc, wchar_t** argv) {
    if (argc < 2) {
        fwprintf(stderr, L"shellhelp: needs verb (properties|trash|drives|menu|invoke|thumb|dragout)\n");
        return 2;
    }
    if (wcscmp(argv[1], L"properties") == 0) return verb_properties(argc, argv);
    if (wcscmp(argv[1], L"trash") == 0)      return verb_trash(argc, argv);
    if (wcscmp(argv[1], L"drives") == 0)     return verb_drives();
    if (wcscmp(argv[1], L"menu") == 0)       return verb_menu(argc, argv);
    if (wcscmp(argv[1], L"invoke") == 0)     return verb_invoke(argc, argv);
    if (wcscmp(argv[1], L"thumb") == 0)      return verb_thumb(argc, argv);
    if (wcscmp(argv[1], L"dragout") == 0)    return verb_dragout(argc, argv);
    fwprintf(stderr, L"shellhelp: unknown verb %ls\n", argv[1]);
    return 2;
}
