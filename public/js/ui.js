// Shared UI kit for Southbag Git's server-rendered pages: retro dialogs (also used for every
// message: there are no toasts and no alert()), confirmations, copying and the deletion refusal.

import { h } from './dom.js';

// ── Dialogs (Office style: stretched logo, heading, text, grey buttons) ────
/**
 * Opens a dialog. Resolves with the value of the clicked action (or null when closed).
 *   dialog({ title: 'Are you sure?', body: 'Text or node', actions: [{ label: 'OK', value: true, primary: true }] })
 */
export function dialog({ title = 'Southbag Git', body, actions = [{ label: 'OK', value: true, primary: true }], wide = false, onOpen } = {}) {
  return new Promise(resolve => {
    const previous = document.activeElement;
    let done = false;
    const close = value => {
      if (done) return;
      done = true;
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
      resolve(value ?? null);
    };
    const onKey = e => { if (e.key === 'Escape') close(null); };
    const content = typeof body === 'function' ? body(close) : body;
    const box = h('div.dialog', { class: { wide }, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div.titlebar', h('img', { src: '/img/logo-400.png', alt: 'southbag' }),
        h('button', { type: 'button', onclick: () => close(null) }, 'Close')),
      h('h2.dialog-title', title),
      h('div.body', typeof content === 'string' ? h('p', { style: 'margin:0' }, content) : content),
      actions.length ? h('div.actions', actions.map(a =>
        h('button.retro-btn', { type: 'button', class: { primary: a.primary }, onclick: () => close(a.value) }, a.label))) : null,
    );
    const overlay = h('div.overlay', { onclick: e => { if (e.target === overlay) close(null); } }, box);
    document.body.append(overlay);
    document.addEventListener('keydown', onKey);
    (box.querySelector('.retro-btn.primary') || box.querySelector('.body input, .body textarea, .body button'))?.focus();
    onOpen?.(box, close);
  });
}

// The same message is never open twice at once.
const openMessages = new Set();
/** toast('Saved.') / toast('Repository not found.', { error: true }) — opens a dialog with OK. */
export async function toast(message, { error = false, title } = {}) {
  const text = message instanceof Error ? message.message : String(message);
  if (openMessages.has(text)) return;
  openMessages.add(text);
  try { await dialog({ title: title || (error ? 'Error' : 'Southbag Git'), body: text }); } finally { openMessages.delete(text); }
}

/** confirm('Request a star?', { ok: 'Continue' }) → Promise<boolean> */
export async function confirm(message, { title = 'Are you sure?', ok = 'Continue', cancel = 'Cancel' } = {}) {
  return Boolean(await dialog({
    title, body: message,
    actions: [{ label: cancel, value: false }, { label: ok, value: true, primary: true }],
  }));
}

/** Nothing on Southbag Git can be deleted. Every Delete calls this instead; the server refuses too. */
export function refuseDelete() {
  return toast("Deletion isn't available. Kevin knows what you did.", { error: true });
}

/** Copies text; falls back to a dialog with the text selected when the clipboard is blocked. */
export async function copy(text, message = 'Copied.') {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    dialog({
      title: 'Copy this',
      body: h('input.input', { value: text, readOnly: true, onfocus: e => e.target.select() }),
      onOpen: box => box.querySelector('input')?.select(),
    });
  }
}
