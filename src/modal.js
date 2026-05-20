// Phase 8e — in-app modal primitives.
//
// Replaces window.prompt / window.confirm (which render as the
// WebView2-native "127.0.0.1:NNNN says…" chrome that breaks the
// Mica frameless look and locks the whole app while open).
//
// Three primitives, all Promise-returning so callers stay
// async-await-shaped:
//
//   prompt({ title, label, value, placeholder, validate, okText })
//     -> Promise<string | null>     null on cancel / Esc
//
//   confirm({ title, body, items, danger, okText, cancelText })
//     -> Promise<boolean>           false on cancel / Esc
//
//   choose({ title, body, options })
//     options: [{ label, value, primary?, danger? }]
//     -> Promise<any | null>        null on cancel / Esc
//
// Single-instance: opening a second modal tears down any existing
// overlay first. Esc cancels; Enter submits the primary button
// (the input on prompt; the OK / primary option on confirm /
// choose). Click-outside cancels unless `danger: true`, where
// the only way out is an explicit button (matches Explorer's
// "Permanently delete" sheet).

let current = null;

export function prompt({ title, label, value = '', placeholder = '', validate, okText = 'OK' } = {}) {
  return new Promise((resolve) => {
    const { overlay, body, footer } = mount(title, false);

    if (label) {
      const lbl = document.createElement('div');
      lbl.className = 'app-modal__label';
      lbl.textContent = label;
      body.appendChild(lbl);
    }
    const input = document.createElement('input');
    input.className = 'app-modal__input';
    input.type = 'text';
    input.value = value;
    input.placeholder = placeholder;
    body.appendChild(input);

    const err = document.createElement('div');
    err.className = 'app-modal__error';
    body.appendChild(err);

    const ok = makeBtn(okText, 'primary');
    const cancel = makeBtn('Cancel');
    footer.append(cancel, ok);

    const runValidate = () => {
      if (!validate) { err.textContent = ''; ok.disabled = !input.value.trim(); return true; }
      const msg = validate(input.value);
      err.textContent = msg || '';
      ok.disabled = !!msg;
      return !msg;
    };
    input.addEventListener('input', runValidate);

    const finish = (v) => { teardown(overlay); resolve(v); };
    ok.addEventListener('click', () => { if (runValidate()) finish(input.value); });
    cancel.addEventListener('click', () => finish(null));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(null); });
    document.addEventListener('keydown', current.onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
      else if (e.key === 'Enter' && document.activeElement !== cancel) {
        e.preventDefault();
        if (runValidate()) finish(input.value);
      }
    }, true);

    runValidate();
    // Pre-select the basename so the user can replace it without
    // touching the extension (matches the F2 inline rename's pattern).
    requestAnimationFrame(() => {
      input.focus();
      const dot = value.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : value.length);
    });
  });
}

export function confirm({ title, body: bodyHtml, items, danger = false, okText, cancelText = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    const { overlay, body, footer } = mount(title, danger);

    if (bodyHtml) {
      const p = document.createElement('div');
      p.className = 'app-modal__body-text';
      p.textContent = bodyHtml;
      body.appendChild(p);
    }
    if (items?.length) {
      const list = document.createElement('ul');
      list.className = 'app-modal__items';
      const shown = items.slice(0, 5);
      shown.forEach((name) => {
        const li = document.createElement('li');
        li.textContent = name;
        list.appendChild(li);
      });
      if (items.length > shown.length) {
        const more = document.createElement('li');
        more.className = 'app-modal__items-more';
        more.textContent = `…and ${items.length - shown.length} more`;
        list.appendChild(more);
      }
      body.appendChild(list);
    }

    const ok = makeBtn(okText || (danger ? 'Delete' : 'OK'), danger ? 'danger' : 'primary');
    const cancel = makeBtn(cancelText);
    footer.append(cancel, ok);

    const finish = (v) => { teardown(overlay); resolve(v); };
    ok.addEventListener('click', () => finish(true));
    cancel.addEventListener('click', () => finish(false));
    if (!danger) {
      overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(false); });
    }
    document.addEventListener('keydown', current.onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      else if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    }, true);

    // Focus Cancel by default for destructive prompts so an accidental
    // Enter doesn't nuke files; OK for non-destructive ones.
    requestAnimationFrame(() => (danger ? cancel : ok).focus());
  });
}

export function choose({ title, body: bodyHtml, options = [] } = {}) {
  return new Promise((resolve) => {
    const { overlay, body, footer } = mount(title, false);

    if (bodyHtml) {
      const p = document.createElement('div');
      p.className = 'app-modal__body-text';
      p.textContent = bodyHtml;
      body.appendChild(p);
    }

    const buttons = options.map((opt) => {
      const variant = opt.danger ? 'danger' : (opt.primary ? 'primary' : '');
      const btn = makeBtn(opt.label, variant);
      btn.addEventListener('click', () => { teardown(overlay); resolve(opt.value); });
      return btn;
    });
    footer.append(...buttons);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { teardown(overlay); resolve(null); }
    });
    document.addEventListener('keydown', current.onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); teardown(overlay); resolve(null); }
      else if (e.key === 'Enter') {
        const primary = options.find((o) => o.primary);
        if (primary) { e.preventDefault(); teardown(overlay); resolve(primary.value); }
      }
    }, true);

    requestAnimationFrame(() => {
      const primaryIdx = options.findIndex((o) => o.primary);
      buttons[primaryIdx >= 0 ? primaryIdx : buttons.length - 1]?.focus();
    });
  });
}

// ── Plumbing ──────────────────────────────────────────────────────────

function mount(title, danger) {
  if (current) teardown(current.overlay);

  const overlay = document.createElement('div');
  overlay.className = 'app-modal__overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  const modal = document.createElement('div');
  modal.className = 'app-modal' + (danger ? ' app-modal--danger' : '');
  overlay.appendChild(modal);

  const header = document.createElement('div');
  header.className = 'app-modal__header';
  header.textContent = title || '';
  modal.appendChild(header);

  const body = document.createElement('div');
  body.className = 'app-modal__body';
  modal.appendChild(body);

  const footer = document.createElement('div');
  footer.className = 'app-modal__footer';
  modal.appendChild(footer);

  document.body.appendChild(overlay);
  current = { overlay, onKey: null };
  return { overlay, body, footer };
}

function teardown(overlay) {
  if (current?.onKey) document.removeEventListener('keydown', current.onKey, true);
  overlay?.remove();
  current = null;
}

function makeBtn(label, variant = '') {
  const btn = document.createElement('button');
  btn.className = 'app-modal__btn' + (variant ? ` app-modal__btn--${variant}` : '');
  btn.textContent = label;
  return btn;
}
