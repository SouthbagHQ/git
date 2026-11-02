// Southbag Git — page shell and small view helpers. Server-rendered HTML (hono/html: every
// interpolated string is escaped; use raw() only for trusted markup). Styling: public/css/southbag.css
// (house style), forge.css (forge furniture), chaos.css (jank). Copy rules: ../social/docs/STYLE.md.

import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import type { Repo, User } from '../env';
import { FEES, money as formatMoney, type FeeKey } from '../lib/fees';
import { aestText, isBusinessHours, nextOpening } from '../lib/hours';

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;
/** Anything that can go in a template slot: markup, text (escaped), numbers, lists, nothing. */
export type Child = Html | string | number | null | undefined | false | Child[];

const SITE = 'Southbag Git';

// ── Formatting ───────────────────────────────────────────────────────────

/** "$2.50" (cents in, dollars out; negative amounts get a minus). */
export const money = (cents: number): string => formatMoney(cents);

const dateFormat = new Intl.DateTimeFormat('en-AU', {
  timeZone: 'Australia/Sydney', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
});
const dayFormat = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', day: 'numeric', month: 'long', year: 'numeric' });

/** "15 Oct 2026, 3:40 pm" in Sydney time. */
export const dateTime = (ms: number): string => dateFormat.format(new Date(ms));
/** "15 October 2026" in Sydney time. */
export const dateOnly = (ms: number): string => dayFormat.format(new Date(ms));

/** "just now", "5 minutes ago", "3 days ago"; older than 30 days is a date. Future times say "in …". */
export function timeAgo(ms: number, now = Date.now()): string {
  const diff = now - ms;
  const abs = Math.abs(diff);
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  let text: string;
  if (abs < 45000) return 'just now';
  if (abs < 3600000) text = unit(Math.round(abs / 60000), 'minute');
  else if (abs < 86400000) text = unit(Math.round(abs / 3600000), 'hour');
  else if (abs < 30 * 86400000) text = unit(Math.round(abs / 86400000), 'day');
  else return dateOnly(ms);
  return diff >= 0 ? `${text} ago` : `in ${text}`;
}

/** <time> with the relative text and the full date as a tooltip. */
export const when = (ms: number) => html`<time datetime="${new Date(ms).toISOString()}" title="${dateTime(ms)}">${timeAgo(ms)}</time>`;

/** "1 issue", "3 issues". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Appends ?page=n or &page=n to a URL. */
const withPage = (base: string, page: number) => `${base}${base.includes('?') ? '&' : '?'}page=${page}`;

// ── Small pieces ─────────────────────────────────────────────────────────

/** A ridge-bordered panel with an optional heading. */
export const card = (title: string | null, body: Child, opts: { tilt?: boolean; id?: string } = {}) =>
  html`<section class="south-card card${opts.tilt ? ' tilt' : ''}"${opts.id ? html` id="${opts.id}"` : ''}>${title ? html`<h2>${title}</h2>` : ''}${body}</section>`;

/** "No repositories yet." */
export const emptyState = (text: string, action?: Child) => html`<div class="empty"><p>${text}</p>${action ?? ''}</div>`;

/** A notice in a double border. */
export const notice = (body: Child) => html`<div class="notice">${body}</div>`;

const STATUS_WORDS: Record<string, string> = {
  open: 'Pending', pending: 'Pending', queued: 'Pending', processing: 'Processing', processed: 'Processed',
  approved: 'Approved', declined: 'Declined', rejected: 'Rejected', executed: 'Executed', withdrawn: 'Withdrawn',
  expired: 'Expired', merged: 'Merged', closed: 'Closed', cancelled: 'Cancelled', charged: 'Charged', failed: 'Failed',
};
/** Final statuses (approved, declined, executed, merged, expired, withdrawn, rejected, processed). */
export const FINAL_STATUSES = new Set(['approved', 'declined', 'executed', 'merged', 'expired', 'withdrawn', 'rejected', 'processed']);

/**
 * A status. Final ones are plain bold uppercase text ("APPROVED"); others are bordered text:
 * open becomes "Pending", processing "Processing". Issues are "Open"/"Closed": pass `{ issue: true }`.
 */
export function statusWord(status: string, opts: { issue?: boolean } = {}) {
  const word = opts.issue && status === 'open' ? 'Open' : STATUS_WORDS[status] ?? (status.charAt(0).toUpperCase() + status.slice(1));
  const cls = status.replace(/[^a-z_-]/gi, '');
  if (FINAL_STATUSES.has(status)) return html`<b class="status status-final status-${cls}">${word.toUpperCase()}</b>`;
  return html`<span class="status status-${cls}">${word}</span>`;
}

/** A label, rendered as plain text in square brackets. */
export const label = (text: string) => html`<span class="label">${text}</span>`;

/** A grey square with the first letter of the username. Sizes: xs (20), sm (26), default (32), lg (72), xl (160). */
export const avatar = (username: string, size: 'xs' | 'sm' | 'md' | 'lg' | 'xl' = 'md') =>
  html`<span class="avatar${size === 'md' ? '' : ` ${size}`}" aria-hidden="true">${(username.charAt(0) || '?').toUpperCase()}</span>`;

export const userLink = (username: string) => html`<a class="user-link" href="/${encodeURIComponent(username)}">${username}</a>`;

/** "Filing fee $2.50" for a fee key. */
export const feeText = (key: FeeKey) => `${FEES[key].label} ${money(FEES[key].amount)}`;

/** A notice listing the fees that apply to what the page is about to do. */
export function feeNotice(keys: FeeKey[], intro = 'Fees apply.') {
  const total = keys.reduce((sum, key) => sum + FEES[key].amount, 0);
  return html`<div class="fee-notice"><strong>${intro}</strong> ${keys.map((key, i) => html`${i ? '; ' : ''}${FEES[key].label}: <span class="fee">${money(FEES[key].amount)}</span>`)}.${keys.length > 1 ? html` Total: <strong>${money(total)}</strong>.` : ''} Fees are charged to your Southbag Online Banking account.</div>`;
}

/**
 * The house button. Sizes: large, small, tiny (3px until hovered). Defaults to type="submit".
 * `attrs` is trusted markup (e.g. raw('data-refuse-delete') or raw('formaction="/x"')).
 */
export function button(text: string, opts: { size?: 'large' | 'small' | 'tiny'; type?: 'submit' | 'button' | 'reset'; name?: string; value?: string; attrs?: string; disabled?: boolean } = {}) {
  const cls = opts.size ? `btn-${opts.size}` : 'btn';
  return html`<button class="${cls}" type="${opts.type ?? 'submit'}"${opts.name ? html` name="${opts.name}"` : ''}${opts.value != null ? html` value="${opts.value}"` : ''}${opts.disabled ? raw(' disabled') : ''}${opts.attrs ? raw(` ${opts.attrs}`) : ''}>${text}</button>`;
}

/** A link styled as the house button. */
export const linkButton = (text: string, href: string, size?: 'large' | 'small' | 'tiny') =>
  html`<a class="${size ? `btn-${size}` : 'btn'}" href="${href}">${text}</a>`;

export interface FieldOptions {
  label: string;
  name: string;
  type?: 'text' | 'textarea' | 'select' | 'password' | 'email' | 'url' | 'number' | 'search' | 'checkbox' | 'hidden';
  value?: string | number | null;
  placeholder?: string;
  hint?: string;
  required?: boolean;
  maxlength?: number;
  rows?: number;
  options?: Array<string | { value: string; label: string }>;
  checked?: boolean;
  autocomplete?: string;
  readonly?: boolean;
}

/** A labelled form field: text inputs, textareas, selects and checkboxes. */
export function formField(o: FieldOptions) {
  const id = `f-${o.name.replace(/[^a-z0-9_-]/gi, '')}`;
  const common = html` id="${id}" name="${o.name}"${o.required ? raw(' required') : ''}${o.readonly ? raw(' readonly') : ''}${o.maxlength ? html` maxlength="${o.maxlength}"` : ''}${o.placeholder ? html` placeholder="${o.placeholder}"` : ''}${o.autocomplete ? html` autocomplete="${o.autocomplete}"` : ''}`;
  const hint = o.hint ? html`<span class="hint">${o.hint}</span>` : '';
  const value = o.value == null ? '' : String(o.value);
  if (o.type === 'hidden') return html`<input type="hidden" name="${o.name}" value="${value}">`;
  if (o.type === 'checkbox') {
    return html`<label class="checkbox" for="${id}"><input type="checkbox"${common} value="${value || '1'}"${o.checked ? raw(' checked') : ''}> <span>${o.label}${hint}</span></label>`;
  }
  let control: Html;
  if (o.type === 'textarea') control = html`<textarea${common} rows="${o.rows ?? 6}">${value}</textarea>`;
  else if (o.type === 'select') {
    control = html`<select${common}>${(o.options ?? []).map(opt => {
      const { value: v, label: l } = typeof opt === 'string' ? { value: opt, label: opt } : opt;
      return html`<option value="${v}"${v === value ? raw(' selected') : ''}>${l}</option>`;
    })}</select>`;
  } else control = html`<input type="${o.type ?? 'text'}"${common} value="${value}">`;
  return html`<div class="field"><label class="field-label" for="${id}">${o.label}</label>${control}${hint}</div>`;
}

/** Newer / Older links for page-numbered lists (`?page=`). Renders nothing when there is one page. */
export function pagination(opts: { page: number; hasNext: boolean; base: string }) {
  const { page, hasNext, base } = opts;
  if (page <= 1 && !hasNext) return html``;
  return html`<nav class="pagination" aria-label="Pages">
    ${page > 1 ? html`<a class="btn-small" href="${withPage(base, page - 1)}" rel="prev">Previous</a>` : html`<span class="btn-small disabled">Previous</span>`}
    <span class="page">Page ${page}</span>
    ${hasNext ? html`<a class="btn-small" href="${withPage(base, page + 1)}" rel="next">Next</a>` : html`<span class="btn-small disabled">Next</span>`}
  </nav>`;
}

/** A form that posts to `action` after the two confirmation dialogs (forge.js). */
export function confirmForm(action: string, text: string, opts: { confirm: string; fee?: FeeKey | FeeKey[]; size?: 'large' | 'small' | 'tiny'; hidden?: Record<string, string> } ) {
  const fees = opts.fee == null ? [] : Array.isArray(opts.fee) ? opts.fee : [opts.fee];
  const total = fees.reduce((sum, key) => sum + FEES[key].amount, 0);
  return html`<form class="inline" method="post" action="${action}" data-confirm="${opts.confirm}"${fees.length ? html` data-fee="${money(total)}"` : ''}>${Object.entries(opts.hidden ?? {}).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}${button(text, { size: opts.size })}</form>`;
}

// ── Flash messages ───────────────────────────────────────────────────────
//
// Routes redirect with a flash string. "Error: …" is an error (the prefix is dropped); anything else
// is a plain message. The server renders it in #flash (visible without JavaScript); forge.js shows it
// in a dialog with OK.

export type FlashKind = 'error' | 'plain';
export interface FlashInput { message: string; error?: boolean }

/** Whether a flash message is an error, and its text without an "Error: " prefix. */
export function flashKind(flash: FlashInput): { kind: FlashKind; text: string } {
  if (flash.message.startsWith('Error: ')) return { kind: 'error', text: flash.message.slice(7).trim() };
  return { kind: flash.error ? 'error' : 'plain', text: flash.message };
}

/** #flash. forge.js turns it into a dialog. */
export function flashView(flash: FlashInput) {
  const { kind, text } = flashKind(flash);
  return html`<div id="flash" class="flash flash-${kind} notice" role="${kind === 'error' ? 'alert' : 'status'}" data-flash="${kind}" data-message="${text}"${kind === 'error' ? raw(' data-error') : ''}>${text}</div>`;
}

// ── Page shell ───────────────────────────────────────────────────────────
// Masthead (stretched logo, account menu), a menu bar, then a few things nobody got round to
// styling (business hours, a breadcrumb trail, a footer of default tables and lists). Full-width
// content, no sidebar. Anything with class "raw" is left at the browser's default look.

const navLinks = (user: User | null) => user
  ? [
    { href: '/explore', label: 'Explore' },
    { href: '/requests', label: 'Requests' },
    { href: '/merge-requests', label: 'Merge requests' },
    { href: '/waivers', label: 'Fee waivers' },
  ]
  : [
    { href: '/explore', label: 'Explore' },
    { href: '/waivers', label: 'Fee waivers' },
  ];

const isCurrent = (href: string, path: string) => href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`);
const current = (href: string, path: string | undefined) => (path && isCurrent(href, path) ? raw(' aria-current="page"') : '');
const countBadge = (n: number) => (n ? html`<span class="badge">${n > 99 ? '99+' : n}</span>` : '');

function header(user: User | null, unread: number, path: string | undefined, balanceNote?: string) {
  const account = user
    ? html`<details class="menu-details account-menu">
        <summary class="btn">${user.username}</summary>
        <div class="menu" role="menu">
          <p class="menu-note">Signed in as ${user.username}</p>
          <a role="menuitem" href="/${encodeURIComponent(user.username)}">Profile</a>
          <a role="menuitem" href="/">Dashboard</a>
          <a role="menuitem" href="/settings/tokens">Access tokens</a>
          <a role="menuitem" href="/billing">${balanceNote ? `Billing (${balanceNote})` : 'Billing'}</a>
          <a role="menuitem" href="/security">Account security</a>
          <a role="menuitem" href="/settings">Settings</a>
          <hr>
          <a role="menuitem" href="/auth/logout">Sign out</a>
        </div>
      </details>`
    : html`<a class="btn" href="/auth/login">Sign in</a>`;
  return html`<header class="site-header">
    <div class="masthead">
      <a class="brand" href="/" aria-label="${SITE}"><img src="/img/logo-400.png" alt="southbag"><span class="brand-name">Git</span></a>
      <p class="masthead-note">Customer code services</p>
      <div class="account">${user ? html`<span class="signed-in tiny">Welcome, ${user.name || user.username}</span>` : ''}${account}</div>
    </div>
    <nav class="menubar" aria-label="${SITE}">
      ${navLinks(user).map(l => html`<a href="${l.href}"${current(l.href, path)}>${l.label}</a>`)}
      ${user ? html`<a href="/notifications"${current('/notifications', path)}>Notifications${countBadge(unread)}</a>
        <a class="btn-small menubar-new" href="/repo/new"${current('/repo/new', path)}>New repository</a>` : ''}
    </nav>
  </header>`;
}

/** Business hours as one line of text nobody styled, with two links. */
function hoursLine(now: number) {
  const open = isBusinessHours(now);
  return html`<p class="raw hours-line"><small>Business hours: 9:00-17:00 AEST Mon-Fri (currently ${open ? 'open' : html`closed, reopens ${aestText(nextOpening(now))}`})</small><br>
    <a href="/waivers">Fee waivers</a> | <a class="print-link" href="?print=1">Printer-friendly version</a></p>`;
}

const TRAIL_TOP: Record<string, string> = {
  explore: 'Explore', requests: 'Requests', 'merge-requests': 'Merge requests', waivers: 'Fee waivers',
  billing: 'Billing', settings: 'Settings', notifications: 'Notifications', security: 'Account security', status: 'Status',
  terms: 'Terms', repo: 'Repositories', auth: 'Sign in', __preview: 'Preview',
};
const TRAIL_REPO: Record<string, string> = {
  issues: 'Issues', 'merge-requests': 'Merge requests', requests: 'Requests', pushes: 'Push queue', activity: 'Activity',
  settings: 'Settings', commits: 'Commits', branches: 'Branches', src: 'Files', raw: 'Raw', commit: 'Commit',
};
const TRAIL_SUB: Record<string, string> = { new: 'New', tokens: 'Access tokens' };

/** "Home > Southbag Git > Services > …" from the request path. */
function trail(path: string | undefined) {
  const parts = (path ?? '/').split('/').filter(Boolean).map(p => { try { return decodeURIComponent(p); } catch { return p; } });
  const crumbs: Array<{ label: string; href?: string }> = [
    { label: 'Home', href: 'https://southbag.cc' },
    { label: SITE, href: '/' },
    { label: 'Services' },
  ];
  if (parts.length && TRAIL_TOP[parts[0]]) {
    crumbs.push({ label: TRAIL_TOP[parts[0]], href: `/${parts[0]}` });
    for (const p of parts.slice(1)) crumbs.push({ label: TRAIL_SUB[p] ?? p });
  } else if (parts.length) {
    crumbs.push({ label: 'Repositories', href: '/explore' });
    const base = parts.slice(0, 2).map(encodeURIComponent);
    crumbs.push({ label: parts[0], href: `/${base[0]}` });
    if (parts[1]) crumbs.push({ label: parts[1], href: `/${base[0]}/${base[1]}` });
    if (parts[2]) {
      const linked = ['issues', 'merge-requests', 'requests', 'pushes', 'activity', 'settings', 'branches'].includes(parts[2]);
      crumbs.push({ label: TRAIL_REPO[parts[2]] ?? parts[2], href: linked ? `/${base.join('/')}/${parts[2]}` : undefined });
      for (const p of parts.slice(3, 8)) crumbs.push({ label: p });
    }
  }
  const last = crumbs.length - 1;
  return html`<div class="raw trail"><nav aria-label="Breadcrumb">You are here: ${crumbs.map((c, i) => html`${i ? ' > ' : ''}${c.href && i !== last ? html`<a href="${c.href}">${c.label}</a>` : html`<span${i === last ? raw(' aria-current="page"') : ''}>${c.label}</span>`}`)}</nav></div>`;
}

function footer(now: number, balanceNote?: string) {
  // A visitor counter. It goes up about once every nine seconds.
  const visitors = String(Math.floor((now - 1704067200000) / 9000)).padStart(8, '0');
  const year = new Date(now + 10 * 3600000).getUTCFullYear();
  return html`<footer class="site-footer"><div class="inner">
    <div class="raw footer-raw">
      <h3>Business hours</h3>
      <table border="1" cellpadding="3" cellspacing="0">
        <tr><td>Monday to Friday</td><td>9:00 - 17:00 AEST</td></tr>
        <tr><td>Saturday</td><td>Closed</td></tr>
        <tr><td>Sunday</td><td>Closed</td></tr>
        <tr><td>Public holidays</td><td>Closed</td></tr>
      </table>
      <p><small>Pushes and requests received outside business hours are processed the next business day.</small></p>
      <ul>
        <li><a href="/terms">Terms</a></li>
        <li><a href="/waivers">Fee waivers</a></li>
        <li><a href="/status">Status</a></li>
        <li><a href="https://support.southbag.cc" target="_blank" rel="noopener">Support</a></li>
        <li><a href="https://banking.southbag.cc" target="_blank" rel="noopener">${balanceNote ? `Southbag Online Banking (${balanceNote})` : 'Southbag Online Banking'}</a></li>
      </ul>
      <label>Other Southbag sites: <select data-jump aria-label="Other Southbag sites">
        <option value="">-- Please select --</option>
        <option value="https://southbag.cc">southbag.cc</option>
        <option value="https://identity.southbag.cc/home">Southbag Identity</option>
        <option value="https://social.southbag.cc">Southbag Social</option>
        <option value="https://office.southbag.cc">Southbag Office</option>
      </select></label>
      <hr>
      <img class="secure-badge" src="data:image/gif;base64," alt="Southbag Secure Site" width="88" height="31">
      <p>Visitors: ${visitors}</p>
      <p><small>Last updated: 14/03/2011</small></p>
    </div>
    <p class="fine-print">Activity on ${SITE} is reviewed. Fees are charged to your Southbag Online Banking account. Continued use constitutes acceptance.</p>
    <p class="fine-print">Best viewed at 1024 x 768 in Internet Explorer 8. &copy; ${year} Southbag.</p>
    <p><button class="btn-tiny js-only" type="button" data-theme-toggle>Theme</button></p>
  </div></footer>`;
}

// Runs before anything paints: marks JS as on and switches to the
// printer-friendly stylesheet for ?print=1.
const headScript = raw(`<script>(function(){var d=document.documentElement;d.classList.add('js');if(/[?&]print=1(&|$)/.test(location.search)){d.classList.add('print-view');var l=document.getElementById('print-css');if(l)l.media='all'}})();</script>`);

export interface PageOptions {
  title: string;
  user: User | null | undefined;
  body: Child;
  flash?: string | null | { message: string; error?: boolean };
  /** default: content up to 1200px. wide: up to 1400px (repository pages). narrow: one 600px column (sign-in, errors). */
  layout?: 'default' | 'wide' | 'narrow';
  unread?: number;
  /** Shown beside Billing in the account menu and Southbag Online Banking in the footer, e.g. "$12.40". */
  balanceNote?: string;
  /** The request path: marks the current menu link and builds the breadcrumb trail. */
  path?: string;
}

/** The full document. */
export function page(opts: PageOptions) {
  const { layout = 'default', unread = 0 } = opts;
  const user = opts.user ?? null;
  const flash = typeof opts.flash === 'string' ? { message: opts.flash, error: false } : opts.flash ?? null;
  const now = Date.now();
  return html`<!doctype html>
<html lang="en-AU" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title ? `${opts.title} - ${SITE}` : SITE}</title>
<meta name="theme-color" content="#efeee9">
<link rel="icon" href="/img/favicon.png" type="image/png">
<link rel="apple-touch-icon" href="/img/s-256.png">
<link rel="stylesheet" href="/css/southbag.css">
<link rel="stylesheet" href="/css/forge.css">
<link rel="stylesheet" href="/css/chaos.css">
<link id="print-css" rel="stylesheet" href="/css/print.css" media="print">
${headScript}
<script src="/palantir.js" data-app="git" data-session-url="/api/me"></script>
<script type="module" src="/js/forge.js"></script>
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
${header(user, unread, opts.path, opts.balanceNote)}
${hoursLine(now)}
${trail(opts.path)}
${user?.frozen ? html`<div class="frozen-banner" role="alert">Your account is frozen pending review. Every Southbag service is blocked. <a href="https://identity.southbag.cc/unfreeze">Unfreeze at Southbag Identity</a></div>` : ''}
<div class="layout${layout === 'default' ? '' : ` ${layout}`}">
<main id="main" tabindex="-1">
${flash?.message ? flashView(flash) : ''}
${opts.body}
</main>
</div>
${footer(now, opts.balanceNote)}
</body>
</html>`;
}

/** A whole error page: 404 "Not found", 403 "Not allowed" and so on, with the message. */
export function errorPage(user: User | null | undefined, status: number, message: string) {
  const titles: Record<number, string> = {
    400: 'Bad request', 401: 'Sign in required', 403: 'Not allowed', 404: 'Not found', 409: 'Conflict',
    413: 'Too large', 422: 'Not accepted', 423: 'Account frozen', 429: 'Too many requests', 500: 'Something went wrong',
    502: 'Service unavailable', 503: 'Service unavailable',
  };
  const title = titles[status] ?? 'Error';
  return page({
    title,
    user,
    layout: 'narrow',
    body: html`<div class="page-head"><h1>${title}</h1></div>
      <div class="error-box" role="alert"><p>${message}</p></div>
      ${status === 404 ? html`<p class="muted">This path is withheld. Your request has been logged.</p>` : ''}
      ${status === 401 ? html`<p><a class="btn-large" href="/auth/login">Sign in</a></p>` : ''}
      ${status === 423 ? html`<p><a class="btn" href="/security">Account security</a></p>` : ''}
      <p><a href="/">Back to ${SITE}</a></p>`,
  });
}

// ── Repository header ───────────────────────────────────────────────────

export type RepoTab = 'code' | 'issues' | 'merge' | 'pull' | 'push' | 'fork' | 'star' | 'unstar' | 'pushes' | 'activity' | 'settings';

/** Where each repository tab lives, relative to /{owner}/{repo}. */
export const REPO_TAB_PATHS: Record<RepoTab, string> = {
  code: '',
  issues: '/issues',
  merge: '/merge-requests',
  pull: '/requests/pull',
  push: '/requests/push',
  fork: '/requests/fork',
  star: '/requests/star',
  unstar: '/requests/unstar',
  pushes: '/pushes',
  activity: '/activity',
  settings: '/settings',
};
const REPO_TAB_LABELS: Record<RepoTab, string> = {
  code: 'Code', issues: 'Issues', merge: 'Merge requests', pull: 'Pull requests', push: 'Push requests', fork: 'Fork requests',
  star: 'Star requests', unstar: 'Unstar requests', pushes: 'Push queue', activity: 'Activity', settings: 'Settings',
};

export const repoPath = (repo: Pick<Repo, 'owner' | 'name'>) => `/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;

/**
 * Forgejo-style repository header: owner / name, "Forked from", description, the Watch, Star (or
 * Unstar) and Fork buttons with their counts (plain POST forms to /watch, /star or /unstar, /fork)
 * and the tab bar.
 *   counts: { issues, merge, pull, push, fork, star, unstar, pushes } shown after tab labels (keys are the tab names).
 *   starred: shows Unstar (posting to /unstar) instead of Star.
 *   parent: the repository this was forked from (or forkedFrom: "owner/name").
 *   isOwner: shows the Settings tab (default: user.id === repo.owner_id).
 */
export function repoHeader(repo: Repo, opts: { user: User | null | undefined; active: RepoTab; counts?: Partial<Record<string, number>>; starred?: boolean; parent?: { owner: string; name: string } | null; forkedFrom?: string | null; isOwner?: boolean }) {
  const base = repoPath(repo);
  const owner = opts.isOwner ?? Boolean(opts.user && opts.user.id === repo.owner_id);
  const fromText = opts.forkedFrom?.split('/');
  const parent = opts.parent ?? (fromText?.length === 2 ? { owner: fromText[0], name: fromText[1] } : null);
  const action = (path: string, text: string, count: number, title?: string) =>
    html`<form class="repo-button" method="post" action="${base}/${path}"><button class="btn-small" type="submit">${text}</button><span class="count"${title ? html` title="${title}"` : ''}>${count}</span></form>`;
  const tabs = (Object.keys(REPO_TAB_PATHS) as RepoTab[]).filter(tab => tab !== 'settings' || owner);
  return html`<div class="repo-header">
    <div class="repo-heading">
      <h1 class="repo-title"><a href="/${encodeURIComponent(repo.owner)}">${repo.owner}</a><span class="sep">/</span><a class="repo-name" href="${base}">${repo.name}</a></h1>
      ${parent ? html`<p class="repo-meta">Forked from <a href="${repoPath(parent)}">${parent.owner}/${parent.name}</a></p>` : ''}
      <p class="repo-desc">${repo.description || html`<span class="muted">No description.</span>`}</p>
    </div>
    <div class="repo-buttons">
      ${action('watch', 'Watch', 1, 'Kevin is watching')}
      ${opts.starred ? action('unstar', 'Unstar', repo.stars) : action('star', 'Star', repo.stars)}
      ${action('fork', 'Fork', repo.forks)}
    </div>
  </div>
  <nav class="tabs repo-tabs" aria-label="Repository">${tabs.map(tab => {
    const count = opts.counts?.[tab];
    return html`<a href="${base}${REPO_TAB_PATHS[tab]}"${tab === opts.active ? raw(' aria-current="page"') : ''}${tab === 'settings' ? raw(' class="settings-tab"') : ''}>${REPO_TAB_LABELS[tab]}${count != null ? html`<span class="tab-count">${count}</span>` : ''}</a>`;
  })}</nav>`;
}
