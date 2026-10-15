// Southbag Git — page shell and small view helpers. Server-rendered HTML (hono/html: every
// interpolated string is escaped; use raw() only for trusted markup). Styling: public/css/southbag.css
// (house style), forge.css (forge furniture), chaos.css (jank). Copy rules: ../social/docs/STYLE.md.

import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import type { Repo, User } from '../env';
import { FEES, money as formatMoney, type FeeKey } from '../lib/fees';

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
/**
 * A status as plain bordered text: open → "Pending", executed → "Executed" and so on.
 * Issues are "Open"/"Closed": pass `{ issue: true }`.
 */
export function statusWord(status: string, opts: { issue?: boolean } = {}) {
  const word = opts.issue && status === 'open' ? 'Open' : STATUS_WORDS[status] ?? (status.charAt(0).toUpperCase() + status.slice(1));
  return html`<span class="status status-${status.replace(/[^a-z_-]/gi, '')}">${word}</span>`;
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

// ── Page shell ───────────────────────────────────────────────────────────

const announcements = [
  'Welcome to Southbag Git.',
  'Pushes received outside business hours are processed the next business day.',
  'Every request is reviewed.',
  'Scheduled maintenance: in progress. Estimated completion: unknown.',
  'Fee schedule updated. Continued use constitutes acceptance.',
  'Activity on Southbag Git is reviewed.',
];
const ticker = () => html`<div class="ticker" aria-hidden="true"><div class="ticker-track">${[...announcements, ...announcements].map(line => html`<span>${line}</span>`)}</div></div>`;

const helpLabels = ['Help', 'Help Centre', 'Get help', 'Support', 'Contact Support', 'Contact us', 'Live chat', 'FAQ'];
function helpStrip() {
  const labels = [...helpLabels].sort(() => Math.random() - 0.5).slice(0, 6);
  return html`<div class="help-strip" role="navigation" aria-label="Help">${labels.map((text, i) =>
    html`<a class="${i % 2 ? 'btn-large' : 'btn-tiny'}" href="https://support.southbag.cc" data-help>${text}</a>`)}</div>`;
}

const topLinks = [
  { href: '/explore', label: 'Explore' },
  { href: '/requests', label: 'Requests' },
  { href: '/merge-requests', label: 'Merge requests' },
  { href: '/fees', label: 'Fees' },
  { href: '/waivers', label: 'Fee waivers' },
];

const isCurrent = (href: string, path: string) => href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`);
const current = (href: string, path: string | undefined) => (path && isCurrent(href, path) ? raw(' aria-current="page"') : '');

function header(user: User | null, unread: number, path?: string) {
  const account = user
    ? html`<a class="btn" href="/repo/new">New repository</a>
      <a href="/notifications"${current('/notifications', path)}>Notifications${unread ? html`<span class="badge">${unread > 99 ? '99+' : unread}</span>` : ''}</a>
      <details class="menu-details">
        <summary class="btn">${user.username}</summary>
        <div class="menu" role="menu">
          <p class="menu-note">Signed in as ${user.username}</p>
          <a role="menuitem" href="/${encodeURIComponent(user.username)}">Profile</a>
          <a role="menuitem" href="/settings/tokens">Access tokens</a>
          <a role="menuitem" href="/billing">Billing</a>
          <hr>
          <a role="menuitem" href="/auth/logout">Sign out</a>
        </div>
      </details>`
    : html`<a class="btn" href="/auth/login">Sign in</a>`;
  return html`<header class="site-header">
    <a class="brand" href="/" aria-label="${SITE}"><img src="/img/logo-400.png" alt="southbag"><h2>Git</h2></a>
    <nav class="top-links" aria-label="${SITE}">${topLinks.map(l => html`<a href="${l.href}"${current(l.href, path)}>${l.label}</a>`)}</nav>
    <div class="account">${account}</div>
  </header>`;
}

function sidebar(user: User | null, unread: number, path: string | undefined, balanceNote?: string) {
  const links: Array<{ href: string; label: string; badge?: number; external?: boolean }> = user
    ? [
      { href: '/', label: 'Dashboard' },
      { href: `/${encodeURIComponent(user.username)}`, label: 'Your repositories' },
      { href: '/repo/new', label: 'New repository' },
      { href: '/explore', label: 'Explore' },
      { href: '/requests', label: 'Requests' },
      { href: '/merge-requests', label: 'Merge requests' },
      { href: '/notifications', label: 'Notifications', badge: unread },
      { href: '/billing', label: 'Billing' },
      { href: '/fees', label: 'Fee schedule' },
      { href: '/waivers', label: 'Fee waivers' },
      { href: '/settings/tokens', label: 'Access tokens' },
      { href: '/security', label: 'Account security' },
      { href: 'https://support.southbag.cc', label: 'Help', external: true },
    ]
    : [
      { href: '/', label: 'Home' },
      { href: '/explore', label: 'Explore' },
      { href: '/fees', label: 'Fee schedule' },
      { href: '/waivers', label: 'Fee waivers' },
      { href: 'https://support.southbag.cc', label: 'Help', external: true },
      { href: '/auth/login', label: 'Sign in' },
    ];
  const apps = [
    { href: 'https://banking.southbag.cc', label: balanceNote ? `Southbag Online Banking (${balanceNote})` : 'Southbag Online Banking' },
    { href: 'https://southbag.cc', label: 'Southbag' },
    { href: 'https://identity.southbag.cc/home', label: 'Southbag Identity' },
    { href: 'https://social.southbag.cc', label: 'Southbag Social' },
    { href: 'https://office.southbag.cc', label: 'Southbag Office' },
  ];
  let i = 0;
  const item = (l: { href: string; label: string; badge?: number; external?: boolean }, external = false) =>
    html`<li style="--i: ${i++}"><a href="${l.href}"${external || l.external ? raw(' target="_blank" rel="noopener"') : current(l.href, path)}>${l.label}${l.badge ? html`<span class="badge">${l.badge > 99 ? '99+' : l.badge}</span>` : ''}</a></li>`;
  return html`<nav class="south-nav" aria-label="Sidebar">
    <p class="nav-title">${SITE}</p>
    ${user ? html`<p class="nav-hello tiny">Hello, "${user.email || user.username}" !</p>` : ''}
    <ul>${links.map(l => item(l))}</ul>
    <p class="nav-title nav-apps">Southbag</p>
    <ul>${apps.map(a => item(a, true))}</ul>
    <div class="nav-footer">
      ${user ? html`<a class="btn" href="/auth/logout">Sign out</a>` : html`<a class="btn" href="/auth/login">Sign in</a>`}
      <p class="tiny">Kevin is watching</p>
    </div>
  </nav>`;
}

function aside() {
  return html`<aside><div class="sticky">
    <section class="announcement-grid">
      <h3>Notices</h3>
      <div class="announcement-card"><h3>Business hours</h3><p>Pushes are processed 9:00 to 17:00 AEST, Monday to Friday. Pushes received at other times attract an after-hours processing fee of ${money(FEES.push_after_hours.amount)}.</p></div>
      <div class="announcement-card"><h3>Fee waivers</h3><p>Open source projects may apply for a fee waiver. Application fee ${money(FEES.waiver_apply.amount)}.</p><p><a href="/waivers">Apply</a></p></div>
      <div class="announcement-card"><h3>Fee schedule</h3><p>Fees apply to requests, merges, issues and comments.</p><p><a href="/fees">View fee schedule</a></p></div>
    </section>
  </div></aside>`;
}

function footer() {
  return html`<footer class="site-footer"><div class="inner">
    <strong>${SITE}</strong>
    <a href="/terms">Terms</a>
    <a href="/fees">Fee schedule</a>
    <a href="/waivers">Fee waivers</a>
    <a href="/status">Status</a>
    <a href="https://southbag.cc">southbag.cc</a>
    <button class="btn-tiny js-only" type="button" data-theme-toggle>Theme</button>
    <p>Activity on Southbag Git is reviewed.</p>
    <p>Business hours: 9:00 to 17:00 AEST, Monday to Friday.</p>
  </div></footer>`;
}

// Runs before anything paints: marks JS as on, applies the saved theme, and hides the page until the
// splash (once per session) has run. A timer brings the page back if the scripts never load.
const headScript = raw(`<script>(function(){var d=document.documentElement;d.classList.add('js');try{var t=localStorage.getItem('sb_theme');if(t==='dark'||t==='light')d.dataset.theme=t;if(!sessionStorage.getItem('sb_splash_seen')){d.classList.add('splash-open');setTimeout(function(){d.classList.remove('splash-open')},9000)}}catch(e){}})();</script>`);

export interface PageOptions {
  title: string;
  user: User | null | undefined;
  body: Child;
  flash?: string | null | { message: string; error?: boolean };
  /** default: sidebar, page, notices. wide: sidebar and page (repository pages). narrow: one column (sign-in, errors). */
  layout?: 'default' | 'wide' | 'narrow';
  unread?: number;
  /** Shown beside Southbag Online Banking in the sidebar, e.g. "$12.40". */
  balanceNote?: string;
  /** The request path, to mark the current nav link. */
  path?: string;
}

/** The full document. */
export function page(opts: PageOptions) {
  const { layout = 'default', unread = 0 } = opts;
  const user = opts.user ?? null;
  const flash = typeof opts.flash === 'string' ? { message: opts.flash, error: false } : opts.flash ?? null;
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
${headScript}
<script src="/palantir.js" data-app="git" data-session-url="/api/me"></script>
<script type="module" src="/js/forge.js"></script>
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
${ticker()}
${header(user, unread, opts.path)}
${user?.frozen ? html`<div class="frozen-banner" role="alert">Your account is frozen pending review. <a href="/security">Answer the security questions</a></div>` : ''}
${helpStrip()}
<div class="layout${layout === 'default' ? '' : ` ${layout}`}">
${layout === 'narrow' ? '' : sidebar(user, unread, opts.path, opts.balanceNote)}
<main id="main" tabindex="-1">
${flash?.message ? html`<div id="flash" class="notice" role="status" data-message="${flash.message}"${flash.error ? raw(' data-error') : ''}>${flash.message}</div>` : ''}
${opts.body}
</main>
${layout === 'default' ? aside() : ''}
</div>
${footer()}
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

export type RepoTab = 'code' | 'issues' | 'merge' | 'pull' | 'push' | 'pushes' | 'fork' | 'star' | 'activity' | 'settings';

/** Where each repository tab lives, relative to /{owner}/{repo}. */
export const REPO_TAB_PATHS: Record<RepoTab, string> = {
  code: '',
  issues: '/issues',
  merge: '/merge-requests',
  pull: '/requests/pull',
  push: '/requests/push',
  pushes: '/pushes',
  fork: '/requests/fork',
  star: '/requests/star',
  activity: '/activity',
  settings: '/settings',
};
const REPO_TAB_LABELS: Record<RepoTab, string> = {
  code: 'Code', issues: 'Issues', merge: 'Merge requests', pull: 'Pull requests', push: 'Push requests',
  pushes: 'Push queue', fork: 'Fork requests', star: 'Star requests', activity: 'Activity', settings: 'Settings',
};

export const repoPath = (repo: Pick<Repo, 'owner' | 'name'>) => `/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;

/**
 * Forgejo-style repository header: owner / name, "Forked from", description, the request buttons
 * (each a GET form to the request tab, which has the filing form with its reason; filing fee shown) and the tab bar.
 *   counts: { issues, merge, pull, push, pushes, fork, star } shown after tab labels.
 *   parent: the repository this was forked from (or forkedFrom: "owner/name").
 *   isOwner: shows the Settings tab (default: user.id === repo.owner_id).
 */
export function repoHeader(repo: Repo, opts: { user: User | null | undefined; active: RepoTab; counts?: Partial<Record<string, number>>; starred?: boolean; parent?: { owner: string; name: string } | null; forkedFrom?: string | null; isOwner?: boolean }) {
  const base = repoPath(repo);
  const owner = opts.isOwner ?? Boolean(opts.user && opts.user.id === repo.owner_id);
  const full = `${repo.owner}/${repo.name}`;
  const fromText = opts.forkedFrom?.split('/');
  const parent = opts.parent ?? (fromText?.length === 2 ? { owner: fromText[0], name: fromText[1] } : null);
  // The filing form (with its required reason) is on the request tab, so these go there.
  const action = (kind: 'star' | 'unstar' | 'fork' | 'pull' | 'push', text: string, _confirmText: string, count?: number) => {
    const fee = FEES[`${kind}_file` as FeeKey];
    return html`<form class="repo-action" method="get" action="${base}/requests/${kind === 'unstar' ? 'star' : kind}">
      <button class="btn-small" type="submit">${text}</button>${count != null ? html`<span class="count" title="${text}">${count}</span>` : html`<span></span>`}
      <span class="fee">Filing fee ${money(fee.amount)}</span>
    </form>`;
  };
  const tabs = (Object.keys(REPO_TAB_PATHS) as RepoTab[]).filter(tab => tab !== 'settings' || owner);
  return html`<div class="repo-header">
    <h1 class="repo-title"><a href="/${encodeURIComponent(repo.owner)}">${repo.owner}</a><span class="sep">/</span><a class="repo-name" href="${base}">${repo.name}</a></h1>
    ${parent ? html`<p class="repo-meta">Forked from <a href="${repoPath(parent)}">${parent.owner}/${parent.name}</a></p>` : ''}
    <p class="repo-desc">${repo.description || html`<span class="muted">No description.</span>`}</p>
    <div class="repo-actions">
      ${opts.starred
        ? action('unstar', 'Request unstar', `File a request to remove your star from ${full}?`, repo.stars)
        : action('star', 'Request star', `File a request to star ${full}?`, repo.stars)}
      ${action('fork', 'Request fork', `File a request to fork ${full}?`, repo.forks)}
      ${action('pull', 'Request pull', `File a request to pull from ${full}?`)}
      ${action('push', 'Request push', `File a request to push to ${full}?`)}
    </div>
  </div>
  <nav class="tabs repo-tabs" aria-label="Repository">${tabs.map(tab => {
    const count = opts.counts?.[tab];
    return html`<a href="${base}${REPO_TAB_PATHS[tab]}"${tab === opts.active ? raw(' aria-current="page"') : ''}${tab === 'settings' ? raw(' class="settings-tab"') : ''}>${REPO_TAB_LABELS[tab]}${count != null ? html`<span class="tab-count">${count}</span>` : ''}</a>`;
  })}</nav>`;
}
