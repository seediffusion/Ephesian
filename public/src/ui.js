let idSeq = 0;
export function nextId(prefix = 'id') {
  idSeq += 1;
  return `${prefix}-${idSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' && v) el.checked = true;
    else if (typeof v === 'boolean' && v) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function el(tag, attrs, children) { return h(tag, attrs, children); }

// Decorative icon: visible glyph, hidden from assistive tech.
export function icon(glyph) {
  return h('span', { 'aria-hidden': 'true' }, [glyph]);
}

// Visually hidden, exposed to assistive tech.
export function srOnly(text) {
  return h('span', { class: 'sr-only' }, [text]);
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function toast(message, kind = 'info', { ttl = 4500 } = {}) {
  const region = document.getElementById('toast-region');
  // Errors should interrupt; informational toasts go through the polite region.
  if (kind === 'error') {
    const alertNode = h('div', { class: `toast ${kind}`, role: 'alert' }, [message]);
    region.appendChild(alertNode);
    setTimeout(() => { alertNode.style.opacity = '0'; setTimeout(() => alertNode.remove(), 220); }, ttl);
    return;
  }
  const node = h('div', { class: `toast ${kind}` }, [message]);
  region.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity 200ms';
    setTimeout(() => node.remove(), 220);
  }, ttl);
}

// Track stack of background elements made inert so we restore correctly when nested modals close.
const inertStack = [];

function applyInertToBackground() {
  const targets = [];
  const modalRoot = document.getElementById('modal-root');
  // Inert every top-level region that isn't a live-region helper or the modal root.
  for (const c of document.body.children) {
    if (c.id === 'modal-root' || c.id === 'toast-region' || c.id === 'route-announcer') continue;
    if (!c.hasAttribute('inert')) {
      c.setAttribute('inert', '');
      c.setAttribute('aria-hidden', 'true');
      targets.push(c);
    }
  }
  // Also inert any previously-opened modal so focus is trapped in the new top-most one.
  if (modalRoot) {
    const existing = Array.from(modalRoot.children);
    for (const sibling of existing) {
      if (!sibling.hasAttribute('inert')) {
        sibling.setAttribute('inert', '');
        sibling.setAttribute('aria-hidden', 'true');
        targets.push(sibling);
      }
    }
  }
  inertStack.push(targets);
}

function releaseInertFromBackground() {
  const targets = inertStack.pop() || [];
  for (const t of targets) {
    t.removeAttribute('inert');
    t.removeAttribute('aria-hidden');
  }
}

const FOCUSABLE_SELECTOR =
  'a[href]:not([disabled]), button:not([disabled]), textarea:not([disabled]), ' +
  'input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
  '[tabindex]:not([tabindex="-1"]):not([disabled])';

function focusableIn(root) {
  return Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR))
    .filter(el => !el.hasAttribute('inert') && el.offsetParent !== null);
}

export function openModal({ title, body, footer, onClose, describedBy, initialFocus } = {}) {
  const root = document.getElementById('modal-root');
  const titleId = nextId('modal-title');
  const descId = nextId('modal-desc');

  let bodyNode = body;
  const bodyIsPlainText = typeof body === 'string';
  if (bodyIsPlainText) bodyNode = h('div', { html: body });

  // The visible glyph is decorative; the accessible name is "Close dialog".
  const closeBtn = h('button', {
    type: 'button',
    class: 'btn btn-ghost modal-close',
    'aria-label': 'Close dialog'
  }, [icon('×')]);

  const headerH2 = h('h2', { class: 'modal-title', id: titleId }, [title || 'Dialog']);
  const modalBody = h('div', { class: 'modal-body', id: descId }, [bodyNode || '']);
  const modalFooter = footer ? h('div', { class: 'modal-footer' }, [].concat(footer)) : null;

  const dialogAttrs = {
    class: 'modal',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': titleId,
    tabindex: '-1'
  };
  if (describedBy) dialogAttrs['aria-describedby'] = describedBy;
  else if (bodyIsPlainText) dialogAttrs['aria-describedby'] = descId;

  const dialog = h('div', dialogAttrs, [
    h('div', { class: 'modal-header' }, [headerH2, closeBtn]),
    modalBody,
    modalFooter
  ].filter(Boolean));

  const backdrop = h('div', { class: 'modal-backdrop' }, [dialog]);

  const lastActive = document.activeElement;
  let closed = false;

  function close(value) {
    if (closed) return;
    closed = true;
    backdrop.remove();
    document.removeEventListener('keydown', escHandler);
    releaseInertFromBackground();
    // Restore focus to the trigger.
    if (lastActive && document.contains(lastActive) && lastActive.focus) {
      setTimeout(() => lastActive.focus(), 0);
    }
    onClose && onClose(value);
  }
  function escHandler(e) {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      // Only close the *topmost* modal — Esc on a nested modal doesn't bleed up.
      const last = root.lastElementChild;
      if (last === backdrop) {
        e.stopPropagation();
        close();
      }
    }
  }
  closeBtn.addEventListener('click', () => close());
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', escHandler);

  applyInertToBackground();
  root.appendChild(backdrop);

  // Focus order:
  //   1. explicit `initialFocus` element (used for destructive confirms → Cancel button)
  //   2. first interactive control in the body
  //   3. first focusable anywhere in the dialog (close button as fallback)
  //   4. the dialog itself (so AT users land in the dialog at all)
  setTimeout(() => {
    if (initialFocus && document.contains(initialFocus)) {
      initialFocus.focus();
      return;
    }
    const focusables = focusableIn(dialog);
    const firstBody = focusableIn(modalBody)[0];
    (firstBody || focusables[0] || dialog).focus();
  }, 0);

  // Focus trap.
  dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f = focusableIn(dialog);
    if (!f.length) { e.preventDefault(); dialog.focus(); return; }
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  });

  return { close, body: modalBody, dialog };
}

export function confirm(title, message, { confirmLabel = 'Confirm', kind = 'primary' } = {}) {
  return new Promise(resolve => {
    let didResolve = false;
    const messageId = nextId('confirm-msg');
    const okClass = kind === 'danger' ? 'btn btn-danger' : 'btn btn-primary';
    const ok = h('button', {
      type: 'button',
      class: okClass,
      onclick: () => { didResolve = true; m.close(true); resolve(true); }
    }, [confirmLabel]);
    const cancel = h('button', {
      type: 'button',
      class: 'btn',
      onclick: () => { didResolve = true; m.close(false); resolve(false); }
    }, ['Cancel']);
    const m = openModal({
      title,
      body: h('p', { id: messageId }, [message]),
      describedBy: messageId,
      footer: [cancel, ok],
      // Destructive prompts focus Cancel (the safe option).
      // Non-destructive prompts focus the primary action so Enter confirms.
      initialFocus: kind === 'danger' ? cancel : ok,
      onClose: () => { if (!didResolve) resolve(false); }
    });
  });
}

// Used by busy() to remember an element's children without serialising to text.
const busyStash = new WeakMap();

export function busy(target, on = true) {
  if (on) {
    if (busyStash.has(target)) return; // already busy
    busyStash.set(target, {
      wasDisabled: !!target.disabled,
      // Keep the actual DOM children so icon wrappers (aria-hidden) survive.
      childNodes: Array.from(target.childNodes)
    });
    target.disabled = true;
    target.setAttribute('aria-busy', 'true');
    // Remove existing children temporarily and replace with spinner + a visible-text label
    // taken from the button's accessible name (aria-label or text content).
    while (target.firstChild) target.removeChild(target.firstChild);
    const accessibleName = target.getAttribute('aria-label') ||
      busyStash.get(target).childNodes.map(n => n.textContent || '').join('').trim() ||
      'Working';
    target.appendChild(h('span', { class: 'spinner', 'aria-hidden': 'true' }));
    target.appendChild(document.createTextNode(' ' + accessibleName));
  } else {
    const stash = busyStash.get(target);
    if (!stash) return;
    target.disabled = stash.wasDisabled;
    target.removeAttribute('aria-busy');
    while (target.firstChild) target.removeChild(target.firstChild);
    for (const n of stash.childNodes) target.appendChild(n);
    busyStash.delete(target);
  }
}

export function announce(message) {
  const region = document.getElementById('route-announcer');
  if (!region) return;
  // Clear & re-set to force SR re-announce even if string is unchanged.
  region.textContent = '';
  setTimeout(() => { region.textContent = message; }, 30);
}

// Focus the main landmark and announce the new page after route changes.
export function announceRoute(title) {
  document.title = title ? `${title} · Ephesian` : 'Ephesian';
  announce(title || 'Ephesian');
  const main = document.getElementById('main');
  if (main) {
    // Move focus to main so SR users land at the top of the page content.
    main.setAttribute('tabindex', '-1');
    setTimeout(() => main.focus({ preventScroll: false }), 0);
  }
}

export function formatTime(ms) {
  const d = new Date(ms);
  return d.toLocaleString();
}
