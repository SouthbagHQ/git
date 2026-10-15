// Jank: a cookie consent form nobody styled, a site picker that is a plain <select>, and a page
// that jumps a little while you scroll. None of it is a joke on screen; parts of the site were just never finished. Nothing here stops anyone reading
// code, filing requests or commenting.

import { h } from './dom.js';
import { dialog } from './ui.js';

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} },
};

// ── Cookie banner ────────────────────────────────────────────────────────
// Once per browser. Every box is ticked and cannot be unticked.
const cookies = [
  'Session', 'Sign-in state', 'Sign-in redirect', 'Security token', 'Request forgery protection',
  'Load balancing', 'Region routing', 'Cache variation', 'Feature flags', 'Gradual rollout',
  'Theme', 'Language', 'Locale', 'Time zone', 'Date format', 'Number format',
  'Cookie consent', 'Recently viewed repositories', 'Last branch', 'Diff view preference',
  'Clone protocol', 'Fee estimate', 'Business hours notice', 'Unread counts', 'Printer-friendly version',
  'Analytics', 'Session replay', 'Performance', 'Error reporting', 'Web vitals', 'Page leave',
  'kevin_session', 'Bot protection', 'Rate limiting',
];

function cookiePreferences() {
  return dialog({
    title: 'Cookie preferences',
    wide: true,
    body: h('div',
      h('div.cookie-list', cookies.map(name =>
        h('label.cookie-row', h('input', { type: 'checkbox', checked: true, disabled: true }), ` ${name} `, h('span.tiny', '(required)')))),
      h('p.tiny', 'Your preferences have been recorded.')),
    actions: [{ label: 'Save', value: true, primary: true }],
  });
}

export function cookieConsent() {
  if (store.get('sb_cookies_choice')) return;
  const close = choice => {
    store.set('sb_cookies_choice', choice);
    form.remove();
  };
  const row = name => h('label', h('input', { type: 'checkbox', checked: true, disabled: true }), ` ${name}`, h('br'));
  const form = h('form.cookie-form.raw', { 'aria-label': 'Cookies', onsubmit: e => { e.preventDefault(); close('accepted'); } },
    h('b', 'Cookies'),
    h('p', h('small', 'Southbag Git uses cookies. Some cannot be declined. Continued use constitutes acceptance.')),
    row('Strictly necessary'), row('Functional'), row('Performance'), row('Analytics'),
    h('button', { type: 'submit' }, 'Accept'), ' ',
    h('a', { href: '#', onclick: async e => { e.preventDefault(); await cookiePreferences(); close('managed'); } }, 'Manage preferences'));
  setTimeout(() => document.body.append(form), 2500);
}

// ── Other Southbag sites ─────────────────────────────────────────────────
// <select data-jump>: picking an option goes there.
export function siteJump() {
  document.addEventListener('change', e => {
    const select = e.target;
    if (!(select instanceof HTMLSelectElement) || !select.hasAttribute('data-jump') || !select.value) return;
    window.open(select.value, '_blank', 'noopener');
    select.value = '';
  });
}

// ── Jank ─────────────────────────────────────────────────────────────────
// The page shifts a little now and then while scrolling (Service Table does the same).
export function jank() {
  document.addEventListener('scroll', () => {
    if (Math.random() > 0.05) return;
    document.body.style.paddingTop = `${Math.round(Math.random() * 40)}px`;
    document.body.style.paddingLeft = `${Math.round(Math.random() * 8)}px`;
  }, { passive: true });
}
