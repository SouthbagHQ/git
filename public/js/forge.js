// Southbag Git — progressive enhancement for the server-rendered pages. Every page works without
// this file (forms post, menus are <details>, the flash is a notice); with it, messages become
// dialogs and the house jank runs.
//
//   <form data-confirm="Request a star for alice/notes?" data-fee="$0.99">  two dialogs, then submits
//   <div id="flash" data-flash="plain|error" data-message="Saved.">     shown as a dialog with OK
//                                                                            rejection notice: a copy of its contents)
//   <button data-copy="#clone-url">Copy</button>                              copies an input's value; <code data-copy> copies its own text
//   <button data-refuse-delete>Delete</button>                                refuses (no deleting on Southbag Git)
//   <details class="menu-details"> … <input data-filter> … </details>        menus close when you click away; filter narrows links
//   <button data-theme-toggle>Theme</button>                                  light/dark

import { capitaliseKevin, toggleTheme } from './gags.js';
import { cookieConsent, jank, siteJump } from './chaos.js';
import { copy, dialog, refuseDelete, toast } from './ui.js';

// ── Confirmations ─────────────────────────────────────────────────────────
// A slow "Are you sure?", then "Fees apply. Continue?". Then the form goes as it would have.
document.addEventListener('submit', async e => {
  const form = e.target;
  if (!(form instanceof HTMLFormElement)) return;
  const submitter = e.submitter;
  if (submitter?.hasAttribute('data-refuse-delete') || form.hasAttribute('data-refuse-delete')) {
    e.preventDefault();
    refuseDelete();
    return;
  }
  if (form.dataset.confirm != null && form.dataset.confirmed !== '1') {
    e.preventDefault();
    const sure = await dialog({
      title: 'Are you sure?',
      body: form.dataset.confirm || 'This action cannot be undone.',
      actions: [{ label: 'Cancel', value: false }, { label: 'Continue', value: true, primary: true }],
    });
    if (!sure) return;
    const fee = form.dataset.fee;
    const pay = await dialog({
      title: 'Fees apply. Continue?',
      body: fee ? `A fee of ${fee} will be charged to your Southbag Online Banking account.` : 'Fees may apply. They are charged to your Southbag Online Banking account.',
      actions: [{ label: 'Cancel', value: false }, { label: 'Continue', value: true, primary: true }],
    });
    if (!pay) return;
    form.dataset.confirmed = '1';
    if (submitter && form.contains(submitter)) form.requestSubmit(submitter);
    else form.requestSubmit();
    return;
  }
  // The form is going. Say so on the button and stop it going twice.
  if (submitter instanceof HTMLButtonElement && !submitter.hasAttribute('data-busy')) {
    submitter.dataset.busy = '';
    setTimeout(() => { submitter.disabled = true; submitter.textContent = 'Processing'; }, 0);
  }
});

// ── Clicks ────────────────────────────────────────────────────────────────
document.addEventListener('click', e => {
  const target = e.target instanceof Element ? e.target : null;
  if (!target) return;

  const refuse = target.closest('[data-refuse-delete]');
  if (refuse && !(refuse.matches('button[type=submit], button:not([type])') && refuse.form)) {
    e.preventDefault();
    refuseDelete();
    return;
  }

  const copier = target.closest('[data-copy], [data-copy-text]');
  if (copier) {
    e.preventDefault();
    // data-copy="#clone-url" copies that element's value (or text); a bare data-copy copies its own text.
    let source = copier;
    const sel = copier.dataset.copy;
    if (sel && /^[#.\[]/.test(sel)) { try { source = document.querySelector(sel) || copier; } catch {} }
    const text = copier.dataset.copyText ?? (source instanceof HTMLInputElement || source instanceof HTMLTextAreaElement ? source.value : source.textContent) ?? '';
    copy(text.trim(), copier.dataset.copied || 'Copied.');
    return;
  }

  if (target.closest('[data-theme-toggle]')) {
    e.preventDefault();
    toggleTheme();
    return;
  }

  // Open menus close when you click somewhere else.
  for (const open of document.querySelectorAll('details.menu-details[open]')) {
    if (!open.contains(target)) open.removeAttribute('open');
  }
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  for (const open of document.querySelectorAll('details.menu-details[open]')) {
    open.removeAttribute('open');
    open.querySelector('summary')?.focus();
  }
});

// Filter boxes inside menus (the branch list) narrow the links below them.
document.addEventListener('input', e => {
  const input = e.target;
  if (!(input instanceof HTMLInputElement) || !input.hasAttribute('data-filter')) return;
  const q = input.value.trim().toLowerCase();
  const menu = input.closest('.menu') || input.parentElement;
  for (const link of menu.querySelectorAll('a')) link.hidden = q !== '' && !link.textContent.toLowerCase().includes(q);
});

// ── Flash ─────────────────────────────────────────────────────────────────
// The server renders the message in #flash; it opens as a dialog with OK.
function showFlash() {
  const flash = document.getElementById('flash');
  if (!flash?.dataset.message) return;
  toast(flash.dataset.message, { error: flash.hasAttribute('data-error') });
}

// ── Boot ──────────────────────────────────────────────────────────────────
function boot() {
  capitaliseKevin();
  siteJump();
  jank();
  cookieConsent();
  showFlash();
}

boot();
