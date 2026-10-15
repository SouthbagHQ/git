// Dev-only preview of the views with fake data: GET /__preview (?signedout=1, ?frozen=1, ?starred=1,
// ?layout=default|wide|narrow, ?flash=Text: "Error: …" is an error)
// and GET /__preview/error.

import { Hono } from 'hono';
import { html } from 'hono/html';
import type { AppEnv, Repo, User } from '../env';
import { FEES, type FeeKey } from '../lib/fees';
import { blobView, branchMenu, breadcrumbs, cloneBox, commitList, diffView, fileTable } from './code';
import {
  avatar, button, card, confirmForm, dateOnly, dateTime, emptyState, errorPage, feeNotice, formField, label, money,
  page, pagination, repoHeader, statusWord, userLink, when,
} from './layout';

// Date.now() is 0 at module scope in Workers, so `now` is set per request.
let now = 0;
const min = 60000, hour = 3600000, day = 86400000;

const alice: User = {
  id: 'u-alice', username: 'alice', name: 'Alice', email: 'alice@example.com', bio: 'Writes notes.', created_at: 0,
  frozen: 0, frozen_reason: null, frozen_at: null, security_question: null, security_streak: 0,
};
const repo: Repo = {
  id: 'r-1', owner_id: 'u-alice', owner: 'alice', name: 'ledger-tools', description: 'Tools for reconciling ledgers. Internal use.',
  default_branch: 'main', network_id: 'n-1', forked_from: 'r-0', next_number: 8, stars: 3, forks: 1, created_at: 0, updated_at: 0,
};

const readme = html`<div class="markdown">
  <h1>ledger-tools</h1>
  <p>Scripts for reconciling the general ledger against <a href="#">Southbag Online Banking</a> exports.</p>
  <h2>Usage</h2>
  <pre><code>npm install
npm run reconcile -- --month 2026-09</code></pre>
  <ul><li>Requires an approved pull request.</li><li>Pushes are processed during business hours.</li></ul>
  <blockquote>Reconciliations are reviewed.</blockquote>
</div>`;

const source = `import { readLedger } from './ledger';

export async function reconcile(month: string) {
  const ledger = await readLedger(month);
  let total = 0;
  for (const entry of ledger.entries) {
    total += entry.amount;
  }
  return { month, total, balanced: total === 0 };
}
`;

export const preview = new Hono<AppEnv>();

preview.get('/__preview', c => {
  now = Date.now();
  const signedOut = c.req.query('signedout') === '1';
  const user: User | null = signedOut ? null : { ...alice, frozen: c.req.query('frozen') === '1' ? 1 : 0 };
  const layout = (c.req.query('layout') as 'default' | 'wide' | 'narrow' | undefined) ?? 'wide';
  const base = '/alice/ledger-tools';

  const body = html`
    ${repoHeader(repo, { user, active: 'code', counts: { issues: 7, merge: 2, requests: 4, pushes: 2 }, starred: c.req.query('starred') === '1', parent: { owner: 'kevin', name: 'ledger-tools' } })}

    <div class="pending-banner">2 pushes are waiting to be processed. Pushes are processed 9:00 to 17:00 AEST, Monday to Friday.</div>
    <div class="repo-toolbar">
      ${branchMenu('main', [{ name: 'main', href: '#' }, { name: 'reconcile-q3', href: '#' }, { name: 'kevin/review', href: '#' }])}
      ${breadcrumbs([{ name: 'ledger-tools', href: base }, { name: 'src' }])}
      <span class="spacer"></span>
      ${cloneBox('https://git.southbag.cc/alice/ledger-tools.git', { archive: `${base}/archive` })}
    </div>
    ${fileTable([
      { name: 'docs', type: 'tree', href: '#', commit: { message: 'Add month-end checklist', href: '#', time: now - 3 * day } },
      { name: 'src', type: 'tree', href: '#', commit: { message: 'Round amounts to the cent before summing', href: '#', time: now - 2 * hour } },
      { name: '.gitignore', type: 'blob', href: '#', commit: { message: 'Initial commit', href: '#', time: now - 40 * day } },
      { name: 'README.md', type: 'blob', href: '#', commit: { message: 'Explain the pull request requirement in the README', href: '#', time: now - 5 * day } },
      { name: 'package.json', type: 'blob', href: '#', commit: { message: 'Pin dependencies', href: '#', time: now - 12 * day } },
    ], { latest: { sha: '3f9a2c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39', href: '#', message: 'Round amounts to the cent before summing', author: 'alice', time: now - 2 * hour } })}
    <section class="south-card readme"><div class="readme-head">README.md</div>${readme}</section>

    <h2>Blob</h2>
    ${blobView({ path: 'src/reconcile.ts', text: source, size: source.length, rawHref: '#', historyHref: '#' })}

    <h2>Commit</h2>
    <div class="commit-head">
      <p class="message">Round amounts to the cent before summing</p>
      <p class="body">Floating point totals did not balance for September.</p>
      <div class="meta"><span>${userLink('alice')} committed ${when(now - 2 * hour)}</span><span class="sha">3f9a2c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39</span><span>Parent <a class="sha" href="#">9c0d1e2f3a</a></span></div>
    </div>
    ${diffView([
      { path: 'src/reconcile.ts', change: 'modified', hunks: [{ header: '@@ -3,7 +3,7 @@ export async function reconcile(month: string) {', lines: [
        { kind: 'ctx', text: '  const ledger = await readLedger(month);', oldNo: 4, newNo: 4 },
        { kind: 'ctx', text: '  let total = 0;', oldNo: 5, newNo: 5 },
        { kind: 'ctx', text: '  for (const entry of ledger.entries) {', oldNo: 6, newNo: 6 },
        { kind: 'del', text: '    total += entry.amount;', oldNo: 7 },
        { kind: 'add', text: '    total += Math.round(entry.amount * 100);', newNo: 7 },
        { kind: 'ctx', text: '  }', oldNo: 8, newNo: 8 },
      ] }] },
      { path: 'docs/checklist.md', change: 'added', hunks: [{ header: '@@ -0,0 +1,2 @@', lines: [
        { kind: 'add', text: '# Month-end checklist', newNo: 1 },
        { kind: 'add', text: '1. File a pull request.', newNo: 2 },
      ] }] },
      { path: 'assets/logo.png', change: 'added', binary: true, hunks: [] },
    ])}

    <h2>Commits</h2>
    ${commitList([
      { sha: '3f9a2c1d8e7b6a5f4e3d', href: '#', message: 'Round amounts to the cent before summing', author: 'alice', time: now - 2 * hour },
      { sha: '9c0d1e2f3a4b5c6d7e8f', href: '#', message: 'Add month-end checklist', author: 'alice', time: now - 3 * day },
      { sha: '1a2b3c4d5e6f7a8b9c0d', href: '#', message: 'Initial commit', author: 'Kevin', time: now - 40 * day },
    ], dateOnly)}
    ${pagination({ page: 2, hasNext: true, base: `${base}/commits/main` })}

    <h2>Issues</h2>
    <div class="list-filters"><a href="#" aria-current="page">Open (6)</a><a href="#">Closed (1)</a><span class="spacer"></span>${confirmForm('#', 'New issue', { confirm: 'Open a new issue?', fee: 'issue_file', size: 'small' })}</div>
    <ul class="issue-list">
      <li class="issue-row">${statusWord('open', { issue: true })}<a class="title" href="#">The Issue</a><span class="meta">#1 opened 2019 by ${userLink('Kevin')} ${label('immutable')} ${label('wontfix')}</span><span class="side">412 comments</span></li>
      <li class="issue-row">${statusWord('open', { issue: true })}<a class="title" href="#">September totals do not balance</a><span class="meta">#6 opened ${when(now - 3 * day)} by ${userLink('alice')} ${label('bug')}</span><span class="side">3 comments</span></li>
      <li class="issue-row">${statusWord('closed', { issue: true })}<a class="title" href="#">Add a README</a><span class="meta">#2 closed ${when(now - 30 * day)}</span><span class="side">0 comments</span></li>
    </ul>

    <h1 class="issue-title">September totals do not balance <span class="number">#6</span></h1>
    <div class="issue-sub">${statusWord('open', { issue: true })}<span>${userLink('alice')} opened this ${when(now - 3 * day)}</span><span>3 comments</span></div>
    <div class="issue-layout">
      <div>
        <div class="timeline">
          <article class="timeline-item comment"><div class="comment-head">${avatar('alice', 'xs')} ${userLink('alice')} <span class="muted">commented ${when(now - 3 * day)}</span><span class="spacer"></span><span class="role">Owner</span></div>
            <div class="comment-body">The September reconciliation is out by $0.01.\nSteps: run npm run reconcile -- --month 2026-09.</div></article>
          <div class="timeline-item event">${userLink('Kevin')} added the label ${label('bug')} ${when(now - 2 * day)}</div>
          <article class="timeline-item comment"><div class="comment-head">${avatar('Kevin', 'xs')} ${userLink('Kevin')} <span class="muted">commented ${when(now - 2 * day)}</span></div>
            <div class="comment-body">Noted.</div></article>
          <div class="timeline-item event">${userLink('alice')} referenced this issue in <a class="sha" href="#">3f9a2c1d8e</a> ${when(now - 2 * hour)}</div>
        </div>
        <form class="comment-form" method="post" action="#" data-confirm="Post this comment?" data-fee="${money(FEES.comment.amount)}">
          ${formField({ label: 'Comment', name: 'body', type: 'textarea', placeholder: 'Leave a comment', hint: `Comment fee ${money(FEES.comment.amount)}.` })}
          <div class="form-actions">${button('Comment')}${button('Close issue', { size: 'small', name: 'close', value: '1' })}${button('Delete', { size: 'tiny', type: 'button', attrs: 'data-refuse-delete' })}</div>
        </form>
      </div>
      <aside>
        <section class="south-card"><h3>Labels</h3>${label('bug')}</section>
        <section class="south-card"><h3>Assignee</h3>${userLink('Kevin')}</section>
        <section class="south-card"><h3>Participants</h3>${avatar('alice', 'sm')} ${avatar('Kevin', 'sm')}</section>
      </aside>
    </div>

    <h2>Requests</h2>
    ${feeNotice(['pull_file', 'pull_approve', 'pull_execute'], 'Pull requests.')}
    <ul class="request-list">
      <li class="request-row">${statusWord('open')}<span class="what"><strong>Pull request</strong> by ${userLink('bob')}<span class="meta">Filed ${when(now - 40 * min)}. Expires ${dateTime(now + 30 * day)}.</span><span class="reason">Need the September scripts.</span></span>
        <span class="decide">${confirmForm('#', 'Approve', { confirm: 'Approve this pull request?', fee: 'pull_approve', size: 'small' })}${confirmForm('#', 'Decline', { confirm: 'Decline this pull request?', size: 'small' })}</span></li>
      <li class="request-row">${statusWord('approved')}<span class="what"><strong>Push request</strong> by ${userLink('carol')}<span class="meta">Approved by alice ${when(now - 5 * hour)}. Valid for 24 hours.</span></span></li>
      <li class="request-row">${statusWord('executed')}<span class="what"><strong>Fork request</strong> by ${userLink('dave')}<span class="meta">Executed ${when(now - 4 * day)}.</span></span></li>
      <li class="request-row">${statusWord('declined')}<span class="what"><strong>Star request</strong> by ${userLink('erin')}<span class="meta">Declined ${when(now - 9 * day)}.</span></span></li>
      <li class="request-row">${statusWord('expired')}<span class="what"><strong>Unstar request</strong> by ${userLink('frank')}<span class="meta">Expired ${when(now - 31 * day)}.</span></span></li>
    </ul>
    <table class="request-table"><thead><tr><th>Request</th><th>Repository</th><th>Status</th><th>Filed</th></tr></thead><tbody>
      <tr><td>Pull request</td><td><a href="#">kevin/ledger-tools</a></td><td>${statusWord('open')}</td><td>${when(now - 2 * day)}</td></tr>
      <tr><td>Star request</td><td><a href="#">bob/notes</a></td><td>${statusWord('withdrawn')}</td><td>${when(now - 6 * day)}</td></tr>
    </tbody></table>

    <h2>Statuses</h2>
    <p class="row wrap">${['open', 'pending', 'processing', 'approved', 'declined', 'rejected', 'executed', 'merged', 'processed', 'expired', 'withdrawn', 'closed'].map(st => statusWord(st))}</p>

    <h2>Flash messages</h2>
    <p class="muted">With JavaScript these open as dialogs. Try <a href="?flash=Error%3A%20Starring%20this%20repository%20requires%20an%20approved%20star%20request.">an error</a> or <a href="?flash=Star%20request%20filed.%20Filing%20fee%3A%20%240.99.">a message</a>.</p>

    <h2>Fee schedule</h2>
    <table class="fee-table"><thead><tr><th>Fee</th><th class="amount">Amount</th></tr></thead><tbody>
      ${(Object.keys(FEES) as FeeKey[]).slice(0, 10).map(k => html`<tr><td>${FEES[k].label}</td><td class="amount">${money(FEES[k].amount)}</td></tr>`)}
    </tbody></table>

    <h2>Forms</h2>
    ${card('Request', html`<form method="post" action="#">
      ${feeNotice(['pull_file'])}
      ${formField({ label: 'Request type', name: 'kind', type: 'select', options: ['Pull request', 'Push request', 'Fork request', 'Star request'] })}
      ${formField({ label: 'Reason', name: 'reason', type: 'textarea', rows: 3, required: true, hint: 'Required. Requests without a reason are declined.' })}
      ${formField({ label: 'I accept the fees', name: 'accept', type: 'checkbox' })}
      <div class="form-actions">${button('File request')}</div>
    </form>`)}
    ${card('New repository', html`<form class="form" method="post" action="#" data-confirm="Create this repository?" data-fee="${money(FEES.repo_create.amount)}">
      ${feeNotice(['repo_create'])}
      <label>Repository name<input name="name" required maxlength="64"></label>
      <div class="split"><label>Default branch<input name="branch" value="main"></label><label>Visibility<select name="v"><option>Public</option></select></label></div>
      <label>Description<textarea name="description"></textarea><span class="hint">Optional.</span></label>
      <label class="check"><input type="checkbox" name="readme" checked> Add a README</label>
      <div class="form-actions">${button('Create repository', { size: 'large' })}</div>
    </form>`)}
    ${card('Access tokens', html`<p class="lead">Use a token as the password for git over HTTPS.</p><code class="token" data-copy>sbg_3f9a2c1d8e7b6a5f4e3d2c1b0a9f8e7d</code><p class="hint">Click the token to copy it. It is shown once.</p>
      <ul class="list"><li class="list-item unread">bob filed a pull request on alice/ledger-tools. <span class="hint">${when(now - 40 * min)}</span></li><li class="list-item">Your push to alice/ledger-tools was processed. <span class="hint">${when(now - day)}</span></li></ul>`)}
    ${card('Repositories', html`<ul class="repo-list"><li class="repo-list-item"><a class="repo-list-name" href="#">alice/ledger-tools</a><span class="stats">3 stars, 1 fork</span><p>Tools for reconciling ledgers.</p></li><li class="repo-list-item"><a class="repo-list-name" href="#">alice/notes</a><span class="stats">0 stars, 0 forks</span><p>No description.</p></li></ul>`)}
    ${card('Empty', emptyState('No repositories yet.'))}
    <p class="kevin">Approved.</p>
  `;
  return c.html(page({
    title: 'alice/ledger-tools',
    user,
    layout,
    unread: 3,
    balanceNote: '$12.40',
    path: base,
    flash: c.req.query('flash') ?? null,
    body,
  }));
});

preview.get('/__preview/error', c => c.html(errorPage(alice, 404, 'Repository not found.'), 404));
