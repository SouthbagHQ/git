// Jank, after Southbag Online Banking, Identity, Social and Service Table: a splash screen with
// promotional slides, a cookie banner, more help buttons than anyone needs (rendered by the server),
// an announcements ticker (also the server), sidebar links that slide in, and a page that jumps a
// little while you scroll. None of it is a joke on screen; it is just a site that was built badly.
// Everything is once-per-session or harmless, and nothing here stops anyone reading code, filing
// requests or commenting. Motion lives in css/chaos.css.

import { h } from './dom.js';
import { dialog } from './ui.js';

const once = key => {
  try { if (sessionStorage.getItem(key)) return false; sessionStorage.setItem(key, '1'); } catch {}
  return true;
};

// ── Splash ───────────────────────────────────────────────────────────────
// Banking's loader: promotional slides and a progress bar, once per browser session. No skip.
// The head script hides the page (html.splash-open) until this has run, so nothing flashes first.
const slides = [
  ['/img/ad-1.jpg', 'Merge requests now reviewed by Kevin.'],
  ['/img/ad-2.jpg', 'Every push is processed during business hours.'],
  ['/img/ad-3.jpg', 'Apply for an open source fee waiver.'],
  ['/img/ad-4.jpg', 'Southbag Git. Version control, reviewed.'],
  ['/img/ad-5.jpg', 'Star requests are assessed within 5 to 10 business days.'],
  ['/img/ad-6.jpg', 'Your code is kept.'],
  ['/img/ad-7.jpg', 'Fork requests. Now with an execution fee.'],
  ['/img/ad-8.jpg', 'Every pull is approved before it happens.'],
  ['/img/ad-9.jpg', 'Southbag Git. Powered by Southbag Online Banking.'],
];
const statuses = ['Loading', 'Verifying session', 'Indexing repositories', 'Calculating fees', 'Almost done', 'Almost done'];

/** Shows the splash (once per session). Resolves when it is gone, straight away if it isn't shown. */
export function splash(duration = 4200) {
  const root = document.documentElement;
  if (!once('sb_splash_seen')) { root.classList.remove('splash-open'); return Promise.resolve(); }
  const chosen = [...slides].sort(() => Math.random() - 0.5).slice(0, 3);
  const img = h('img', { src: chosen[0][0], alt: '' });
  const caption = h('h2.splash-caption', chosen[0][1]);
  const bar = h('div.splash-bar');
  const status = h('p.splash-status', statuses[0]);
  const el = h('div.splash', { role: 'progressbar', 'aria-label': 'Loading Southbag Git' }, img, caption, h('div.splash-track', bar), status);
  document.body.append(el);
  root.classList.add('splash-open');
  const start = performance.now();
  let done;
  const finished = new Promise(resolve => { done = resolve; });
  const tick = setInterval(() => {
    const t = Math.min(1, (performance.now() - start) / duration);
    // Fast to 80%, then a crawl, like every progress bar.
    bar.style.width = `${Math.round((t < 0.5 ? t * 1.6 : 0.8 + (t - 0.5) * 0.4) * 100)}%`;
    const slide = chosen[Math.min(chosen.length - 1, Math.floor(t * chosen.length))];
    if (img.getAttribute('src') !== slide[0]) { img.src = slide[0]; caption.textContent = slide[1]; }
    status.textContent = statuses[Math.min(statuses.length - 1, Math.floor(t * statuses.length))];
    if (t < 1) return;
    clearInterval(tick);
    el.classList.add('leaving');
    root.classList.remove('splash-open');
    setTimeout(() => { el.remove(); done(); }, 500);
  }, 60);
  return finished;
}

// ── Cookie banner ────────────────────────────────────────────────────────
// Once per browser. "Manage preferences" lists every cookie we could think of, all required.
const cookies = [
  'Session', 'Sign-in state', 'Sign-in redirect', 'Security token', 'Request forgery protection',
  'Load balancing', 'Region routing', 'Cache variation', 'Feature flags', 'Gradual rollout',
  'Theme', 'Language', 'Locale', 'Time zone', 'Date format', 'Number format', 'Sidebar state',
  'Dismissed banners', 'Promotion strip', 'Splash screen seen', 'Cookie banner seen',
  'Cookie preferences', 'Recently viewed repositories', 'Last branch', 'Diff view preference',
  'Clone protocol', 'File tree state', 'Fee estimate', 'Business hours notice', 'Unread counts',
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

export function cookieBanner() {
  try { if (localStorage.getItem('sb_cookies_choice')) return; } catch {}
  const close = choice => {
    try { localStorage.setItem('sb_cookies_choice', choice); } catch {}
    banner.remove();
  };
  const banner = h('section.cookie-banner', { role: 'region', 'aria-label': 'Cookies' },
    h('h3', 'Cookies'),
    h('p', 'Southbag Git uses cookies. Some cannot be declined. Continued use constitutes acceptance. ', h('a', { href: '/terms' }, 'Terms')),
    h('div.cookie-actions',
      h('button.btn-large', { type: 'button', onclick: () => close('all') }, 'Accept all'),
      h('button.btn-large', { type: 'button', onclick: () => close('accept') }, 'Accept'),
      h('button.btn-tiny', { type: 'button', onclick: async () => { await cookiePreferences(); close('managed'); } }, 'Manage preferences')));
  setTimeout(() => document.body.append(banner), 2500);
}

// ── Help strip ───────────────────────────────────────────────────────────
// The server renders six links ([data-help]) to Southbag Support. They all open the same dialog.
export function helpButtons() {
  document.addEventListener('click', e => {
    const link = e.target.closest?.('[data-help]');
    if (!link) return;
    e.preventDefault();
    dialog({
      title: 'Support',
      body: 'Support is available during business hours: 9:00 to 17:00 AEST, Monday to Friday. Requests made outside business hours are processed the next business day.',
      actions: [{ label: 'Close', value: false }, { label: 'Southbag Support', value: true, primary: true }],
    }).then(go => { if (go) window.open(link.href, '_blank', 'noopener'); });
  });
}

// ── Sidebar ──────────────────────────────────────────────────────────────
// The sidebar links slide in one by one, once per session, after the splash.
export function navArrival(after) {
  const nav = document.querySelector('.south-nav');
  if (!nav || !once('sb_nav_arrived')) return;
  after.then(() => {
    nav.classList.add('arriving');
    const last = nav.querySelector('li:last-of-type');
    const arrived = e => {
      if (e.animationName !== 'nav-arrive' || e.target !== last) return;
      nav.classList.remove('arriving');
      nav.removeEventListener('animationend', arrived);
    };
    nav.addEventListener('animationend', arrived);
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
