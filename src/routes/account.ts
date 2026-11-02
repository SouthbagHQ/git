// Account pages: fees, fee waivers, billing, settings, access tokens, notifications, security
// questions and the cross-repository request inbox.

import { Hono } from 'hono';
import { html } from 'hono/html';
import type { AppEnv } from '../env';
import { FEES, chargeFee, money } from '../lib/fees';
import { fail, form, redirect, requireActiveUser, requireUser, str } from '../lib/http';
import { UNFREEZE_URL } from '../lib/identity';
import { KIND_LABEL, KINDS, fileRequest, requestSelect, type RequestRow, type SimpleKind } from '../lib/requests';
import { feeFor } from '../lib/fees';
import { getRepo, repoUrl } from '../lib/repos';
import { mentionsBannedTopic } from '../lib/banned';
import { TOKEN_DAYS, createToken } from '../lib/tokens';
import { LICENCES, applyForWaiver } from '../lib/waivers';
import { aestText, isBusinessHours, nextOpening } from '../lib/hours';
import { card, dateTime, emptyState, page, statusWord, timeAgo } from '../views/layout';

const app = new Hono<AppEnv>();

/** Paths a username would shadow. */
const RESERVED = new Set(['repo', 'explore', 'fees', 'waivers', 'billing', 'settings', 'notifications', 'security', 'requests',
  'status', 'terms', 'auth', 'api', 'css', 'js', 'img', 'admin', 'floor-3', 'palantir.js']);

// ── Fee waivers ──

app.get('/waivers', async c => {
  const user = c.get('user');
  const waivers = user ? (await c.env.DB.prepare('SELECT * FROM waivers WHERE user_id = ? ORDER BY created_at DESC LIMIT 50')
    .bind(user.id).all<{ id: string; project: string; licence: string; status: string; decision: string | null; created_at: number; decided_at: number | null }>()).results : [];
  return c.html(page({
    path: c.req.path,
    unread: c.get('unread'),
    title: 'Fee waivers',
    user,
    flash: c.get('flash'),
    body: html`
      <h1 class="page-title">Fee waivers</h1>
      <p>Open source projects may apply to have Southbag Git fees waived. Applications are assessed individually.
        An application fee of ${money(FEES.waiver_apply.amount)} applies. An assessment fee of ${money(FEES.waiver_decline.amount)}
        applies to applications that are not approved.</p>
      ${user ? card('Apply for a fee waiver', html`
        <form method="post" action="/waivers" class="form" data-confirm="Apply for a fee waiver? The application fee is ${money(FEES.waiver_apply.amount)}.">
          <label>Project name<input name="project" required maxlength="100"></label>
          <label>Licence
            <select name="licence">${LICENCES.map(l => html`<option>${l}</option>`)}</select></label>
          <label>Project website<input name="website" maxlength="200" placeholder="https://"></label>
          <label>Number of contributors<input name="contributors" type="number" min="1" required></label>
          <label>Annual revenue (AUD)<input name="revenue" type="number" min="0" required></label>
          <label>Why should fees be waived?<textarea name="reason" required minlength="200" maxlength="4000" rows="8"></textarea></label>
          <p class="hint">At least 200 characters.</p>
          <label class="check"><input type="checkbox" name="declare" required> I declare that the information provided is true and correct and that I have read the Fee Waiver Policy, which is not published.</label>
          <button class="btn btn-large" type="submit">Submit application</button>
        </form>`) : html`<p><a href="/auth/login?next=/waivers">Sign in</a> to apply.</p>`}
      ${user ? card('Your applications', waivers.length ? html`
        <table class="table">
          <thead><tr><th>Project</th><th>Licence</th><th>Submitted</th><th>Status</th><th>Decision</th></tr></thead>
          <tbody>${waivers.map(w => html`<tr>
            <td>${w.project}</td><td>${w.licence}</td><td>${dateTime(w.created_at)}</td>
            <td>${statusWord(w.status === 'pending' ? 'Under assessment' : 'Declined')}</td>
            <td>${w.decision ?? 'Pending'}</td></tr>`)}</tbody>
        </table>` : emptyState('No applications.')) : ''}`,
  }));
});

app.post('/waivers', async c => {
  const user = requireActiveUser(c);
  const f = await form(c);
  const project = str(f.project, 100);
  const reason = str(f.reason, 4000);
  if (!project) fail(400, 'Enter a project name.');
  if (reason.length < 200) fail(400, 'Explain why fees should be waived in at least 200 characters.');
  if (!f.declare) fail(400, 'You must make the declaration.');
  const licence = LICENCES.includes(f.licence) ? f.licence : 'Other';
  await applyForWaiver(c.env, user, { project, licence, reason });
  return redirect(c, '/waivers', `Application submitted. Application fee: ${money(FEES.waiver_apply.amount)}. You will be notified of the outcome.`);
});

// ── Billing ──

app.get('/billing', async c => {
  const user = requireUser(c);
  const { results } = await c.env.DB.prepare('SELECT * FROM charges WHERE user_id = ? ORDER BY created_at DESC LIMIT 200')
    .bind(user.id).all<{ id: string; amount: number; description: string; status: string; created_at: number }>();
  const total = results.filter(r => r.status === 'charged').reduce((n, r) => n + r.amount, 0);
  return c.html(page({
    path: c.req.path,
    unread: c.get('unread'),
    title: 'Billing',
    user,
    flash: c.get('flash'),
    body: html`
      <h1 class="page-title">Billing</h1>
      <p>Fees are taken from your Southbag Online Banking account. Showing the last 200 fees.</p>
      <p><strong>Total shown: ${money(total)}</strong></p>
      ${results.length ? html`<table class="table">
        <thead><tr><th>Date</th><th>Description</th><th>Amount</th><th>Status</th></tr></thead>
        <tbody>${results.map(r => html`<tr><td>${dateTime(r.created_at)}</td><td>${r.description}</td><td>${money(r.amount)}</td>
          <td>${statusWord(r.status === 'charged' ? 'Charged' : 'Failed')}</td></tr>`)}</tbody>
      </table>` : emptyState('No fees yet.')}`,
  }));
});

// ── Settings ──

app.get('/settings', c => {
  const user = requireUser(c);
  return c.html(page({
    path: c.req.path,
    unread: c.get('unread'),
    title: 'Settings',
    user,
    flash: c.get('flash') ?? (c.req.query('welcome') ? `Welcome to Southbag Git. Your username is ${user.username}.` : null),
    body: html`
      <h1 class="page-title">Settings</h1>
      ${card('Profile', html`
        <form method="post" action="/settings/profile" class="form">
          <label>Display name<input name="name" value="${user.name}" maxlength="50"></label>
          <label>Bio<textarea name="bio" maxlength="300" rows="3">${user.bio}</textarea></label>
          <button class="btn" type="submit">Save</button>
        </form>`)}
      ${card('Username', html`
        <p>Your username is <strong>${user.username}</strong>. It was assigned when your account was opened.</p>
        <form method="post" action="/settings/username" class="form" data-confirm="Change your username? The username change fee is ${money(FEES.username_change.amount)}.">
          <label>New username<input name="username" required pattern="[A-Za-z0-9-]{3,30}" maxlength="30"></label>
          <button class="btn" type="submit">Change username (${money(FEES.username_change.amount)})</button>
        </form>`)}
      ${card('Access tokens', html`<p>Git over HTTPS uses access tokens. <a href="/settings/tokens">Manage access tokens</a>.</p>`)}
      ${card('Delete account', html`<button class="btn" type="button" data-refuse-delete>Delete account</button>`)}`,
  }));
});

app.post('/settings/profile', async c => {
  const user = requireActiveUser(c);
  const f = await form(c);
  await c.env.DB.prepare('UPDATE users SET name = ?, bio = ?, updated_at = ? WHERE id = ?')
    .bind(str(f.name, 50) || user.name, str(f.bio, 300), Date.now(), user.id).run();
  return redirect(c, '/settings', 'Saved.');
});

app.post('/settings/username', async c => {
  const user = requireActiveUser(c);
  const username = str((await form(c)).username, 30);
  if (!/^[A-Za-z0-9-]{3,30}$/.test(username)) fail(400, 'Usernames are 3 to 30 letters, digits or hyphens.');
  if (/^kevin$/i.test(username) || RESERVED.has(username.toLowerCase())) fail(409, 'That username is taken.');
  if (await c.env.DB.prepare('SELECT 1 FROM users WHERE username = ?').bind(username).first()) fail(409, 'That username is taken.');
  await c.env.DB.prepare('UPDATE users SET username = ?, updated_at = ? WHERE id = ?').bind(username, Date.now(), user.id).run();
  await chargeFee(c.env, user, 'username_change', username);
  return redirect(c, '/settings', `Username changed to ${username}. Username change fee: ${money(FEES.username_change.amount)}.`);
});

app.get('/settings/tokens', async c => {
  const user = requireUser(c);
  const { results } = await c.env.DB.prepare('SELECT * FROM access_tokens WHERE user_id = ? ORDER BY created_at DESC LIMIT 50')
    .bind(user.id).all<{ id: string; name: string; last_four: string; created_at: number; expires_at: number; last_used_at: number | null }>();
  const created = c.req.query('created') ? c.get('flash') : null;
  return c.html(page({
    path: c.req.path,
    unread: c.get('unread'),
    title: 'Access tokens',
    user,
    flash: created ? null : c.get('flash'),
    body: html`
      <h1 class="page-title">Access tokens</h1>
      <p>Use an access token as your password for git over HTTPS. Tokens expire after ${TOKEN_DAYS} days.</p>
      ${created ? card('New token', html`<p>Copy your token now. It will not be shown again.</p>
        <p><code class="token" data-copy>${created}</code></p>`) : ''}
      ${card('Issue a token', html`
        <form method="post" action="/settings/tokens" class="form" data-confirm="Issue an access token? The access token issuance fee is ${money(FEES.token_create.amount)}.">
          <label>Token name<input name="name" required maxlength="50"></label>
          <button class="btn" type="submit">Issue token (${money(FEES.token_create.amount)})</button>
        </form>`)}
      ${card('Your tokens', results.length ? html`<table class="table">
        <thead><tr><th>Name</th><th>Token</th><th>Issued</th><th>Expires</th><th>Last used</th><th></th></tr></thead>
        <tbody>${results.map(t => html`<tr><td>${t.name}</td><td>sbg_...${t.last_four}</td><td>${dateTime(t.created_at)}</td>
          <td>${t.expires_at < Date.now() ? 'Expired' : dateTime(t.expires_at)}</td><td>${t.last_used_at ? timeAgo(t.last_used_at) : 'Never'}</td>
          <td><button class="btn btn-small" type="button" data-refuse-delete>Revoke</button></td></tr>`)}</tbody>
      </table>` : emptyState('No tokens.'))}`,
  }));
});

app.post('/settings/tokens', async c => {
  const user = requireActiveUser(c);
  const name = str((await form(c)).name, 50);
  if (!name) fail(400, 'Enter a token name.');
  const token = await createToken(c.env, user, name);
  // The token travels in the flash cookie (HttpOnly, 60 seconds) so it isn't in a URL.
  return redirect(c, '/settings/tokens?created=1', token);
});

// ── Notifications ──

app.get('/notifications', async c => {
  const user = requireUser(c);
  const { results } = await c.env.DB.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100')
    .bind(user.id).all<{ id: string; body: string; link: string | null; read_at: number | null; created_at: number }>();
  await c.env.DB.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').bind(Date.now(), user.id).run();
  return c.html(page({
    path: c.req.path,
    unread: c.get('unread'),
    title: 'Notifications',
    user,
    flash: c.get('flash'),
    body: html`
      <h1 class="page-title">Notifications</h1>
      ${results.length ? html`<ul class="list">${results.map(n => html`<li class="list-item ${n.read_at ? '' : 'unread'}">
        ${n.link ? html`<a href="${n.link}">${n.body}</a>` : n.body} <span class="muted">${timeAgo(n.created_at)}</span></li>`)}</ul>`
        : emptyState('No notifications.')}`,
  }));
});

// ── Security questions (frozen accounts) ──

app.get('/security', async c => {
  const user = requireUser(c);
  if (!user.frozen) return c.html(page({
    path: c.req.path,
    unread: c.get('unread'),
    title: 'Account security', user, flash: c.get('flash'),
    body: html`<h1 class="page-title">Account security</h1><p>Your account is not frozen.</p>`,
  }));
  const events = (await c.env.DB.prepare(`SELECT rule, detail, created_at FROM fraud_events WHERE user_id = ? AND rule != 'activity'
    ORDER BY created_at DESC LIMIT 10`).bind(user.id).all<{ rule: string; detail: string; created_at: number }>()).results;
  return c.html(page({
    path: c.req.path,
    unread: c.get('unread'),
    title: 'Account review',
    user,
    flash: c.get('flash'),
    body: html`
      <h1 class="page-title">Account review</h1>
      <p>Your account was frozen on ${user.frozen_at ? dateTime(user.frozen_at) : 'an unrecorded date'} by fraud detection.
        Reason: ${user.frozen_reason ?? 'Not recorded'}.</p>
      <p>Account freezes are now handled at the account level. While frozen, every Southbag service blocks your account.
        To unfreeze, answer the security questions at
        <a href="https://identity.southbag.cc/unfreeze">Southbag Identity</a>. An incorrect answer costs
        ${money(FEES.security_wrong.amount)}; the account review fee of ${money(FEES.fraud_review.amount)} applies when the
        freeze lifts.</p>
      ${card('Findings', html`<table class="table"><thead><tr><th>Rule</th><th>Detail</th><th>When</th></tr></thead>
        <tbody>${events.map(e => html`<tr><td>${e.rule}</td><td>${e.detail}</td><td>${dateTime(e.created_at)}</td></tr>`)}</tbody></table>`)}`,
  }));
});

app.post('/security', c => redirect(c, '/security', `Account freezes moved to Southbag Identity. Unfreeze at ${UNFREEZE_URL}`));

// ── Requests across repositories ──

app.get('/requests', async c => {
  const user = requireUser(c);
  const select = `${requestSelect.replace('SELECT requests.*,', 'SELECT requests.*, o.username AS repo_owner, repos.name AS repo_name,')}
    JOIN repos ON repos.id = requests.repo_id JOIN users o ON o.id = repos.owner_id`;
  type Row = RequestRow & { repo_owner: string; repo_name: string };
  const inbox = (await c.env.DB.prepare(`${select} WHERE repos.owner_id = ? AND requests.status = 'open' ORDER BY requests.created_at LIMIT 100`)
    .bind(user.id).all<Row>()).results;
  const mine = (await c.env.DB.prepare(`${select} WHERE requests.requester_id = ? ORDER BY requests.created_at DESC LIMIT 100`)
    .bind(user.id).all<Row>()).results;
  const table = (rows: Row[]) => rows.length ? html`<table class="table request-table">
    <thead><tr><th>Request</th><th>Repository</th><th>Filed by</th><th>Filed</th><th>Status</th></tr></thead>
    <tbody>${rows.map(r => html`<tr>
      <td><a href="/${r.repo_owner}/${r.repo_name}/requests/${r.kind}/${r.id}">${KIND_LABEL[r.kind]}</a></td>
      <td><a href="/${r.repo_owner}/${r.repo_name}">${r.repo_owner}/${r.repo_name}</a></td>
      <td>${r.requester}</td><td>${timeAgo(r.created_at)}</td><td>${statusWord(r.status)}</td></tr>`)}</tbody></table>`
    : emptyState('No requests.');
  return c.html(page({
    path: c.req.path,
    unread: c.get('unread'),
    title: 'Requests',
    user,
    flash: c.get('flash'),
    body: html`
      <h1 class="page-title">Requests</h1>
      <p>Business hours: 9:00 to 17:00 AEST, Monday to Friday. ${isBusinessHours(Date.now())
        ? 'Southbag Git is currently in business hours.'
        : html`Southbag Git is currently outside business hours. Next opening: ${aestText(nextOpening(Date.now()))}.`}</p>
      ${card('File a request', html`
        <form method="post" action="/requests" class="form"
          data-confirm="File this request? The filing fee for the selected request type applies.">
          <label>Repository (owner/name)<input name="repository" required maxlength="140" autocomplete="off" spellcheck="false"></label>
          <label>Request type
            <select name="kind" required>
              <option value="">Select</option>
              <option value="unstar">Unstar request (filing fee ${money(feeFor('unstar', 'file').amount)})</option>
              <option value="fork">Fork request (filing fee ${money(feeFor('fork', 'file').amount)})</option>
              <option value="push">Push request (filing fee ${money(feeFor('push', 'file').amount)})</option>
              <option value="star">Star request (filing fee ${money(feeFor('star', 'file').amount)})</option>
              <option value="pull">Pull request (filing fee ${money(feeFor('pull', 'file').amount)})</option>
            </select></label>
          <label>Reason for request<textarea name="reason" required minlength="20" maxlength="1000" rows="4"></textarea></label>
          <p class="hint">At least 20 characters. Requests without a sufficient reason may be declined.</p>
          <label class="check"><input type="checkbox" name="declare" required> I understand that fees apply.</label>
          <button class="btn" type="submit">File request</button>
        </form>`)}
      ${card('Awaiting your decision', table(inbox))}
      ${card('Filed by you', table(mine))}`,
  }));
});

app.post('/requests', async c => {
  const user = requireActiveUser(c);
  const f = await form(c);
  const [owner, name, extra] = str(f.repository, 140).split('/');
  const repo = owner && name && extra === undefined ? await getRepo(c.env, owner, name) : null;
  if (!repo) fail(404, 'Repository not found. Enter it as owner/name.');
  if (!KINDS.includes(f.kind as SimpleKind)) fail(400, 'Select a request type.');
  const kind = f.kind as SimpleKind;
  const reason = str(f.reason, 1000);
  if (reason.length < 20) fail(400, 'Give a reason of at least 20 characters.');
  if (mentionsBannedTopic(reason)) fail(400, 'Your reason refers to a topic that cannot be discussed.');
  if (!f.declare) fail(400, 'Confirm that you understand fees apply.');
  const request = await fileRequest(c.env, user, repo, kind, reason);
  return redirect(c, `${repoUrl(repo)}/requests/${kind}/${request.id}`,
    `${KIND_LABEL[kind]} filed for ${repo.owner}/${repo.name}. ${FEES[`${kind}_file`].label}: ${money(feeFor(kind, 'file').amount)}. The repository owner has been notified.`);
});

// ── Status and terms ──

app.get('/status', async c => {
  const now = Date.now();
  const counts = await c.env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM pushes WHERE status IN ('pending', 'processing')) AS pending,
      (SELECT COUNT(*) FROM pushes WHERE status = 'processed' AND processed_at > ?1) AS processed,
      (SELECT COUNT(*) FROM waivers WHERE status = 'pending') AS waivers,
      (SELECT COUNT(*) FROM users WHERE frozen = 1) AS frozen`).bind(now - 86400000).first<Record<string, number>>();
  const open = isBusinessHours(now);
  return c.html(page({
    path: c.req.path,
    unread: c.get('unread'),
    title: 'Status',
    user: c.get('user'),
    flash: c.get('flash'),
    body: html`
      <h1 class="page-title">Status</h1>
      ${card('Push processing', html`<table class="table">
        <tr><th>Processing</th><td>${open ? 'Open' : 'Closed'}</td></tr>
        <tr><th>Business hours</th><td>9:00 to 17:00 AEST, Monday to Friday</td></tr>
        ${open ? '' : html`<tr><th>Next opening</th><td>${aestText(nextOpening(now))}</td></tr>`}
        <tr><th>Pushes pending</th><td>${counts?.pending ?? 0}</td></tr>
        <tr><th>Pushes processed (24 hours)</th><td>${counts?.processed ?? 0}</td></tr>
      </table>`)}
      ${card('Other services', html`<table class="table">
        <tr><th>Git over HTTPS</th><td>Operational</td></tr>
        <tr><th>Fee collection</th><td>Operational</td></tr>
        <tr><th>Fraud detection</th><td>Operational. ${counts?.frozen ?? 0} accounts under review.</td></tr>
        <tr><th>Fee waiver assessment</th><td>Operational. ${counts?.waivers ?? 0} applications under assessment.</td></tr>
        <tr><th>Floor 3</th><td>Not applicable</td></tr>
      </table>`)}`,
  }));
});

app.get('/terms', c => c.html(page({
  path: c.req.path,
  unread: c.get('unread'),
  title: 'Terms of Service',
  user: c.get('user'),
  flash: c.get('flash'),
  body: html`
    <h1 class="page-title">Terms of Service</h1>
    <ol class="terms">
      <li>Southbag Git is provided by Southbag. Continued use constitutes acceptance of these terms and any later terms.</li>
      <li>Fees are shown where they apply and may change without notice. Fees are taken from your Southbag Online Banking account. Fees are final.</li>
      <li>Every pull, push, fork, star and unstar requires a request approved by the repository owner.</li>
      <li>Pushes are processed during business hours, 9:00 to 17:00 AEST, Monday to Friday. Southbag does not observe daylight saving.</li>
      <li>Commit messages, issues and comments must not refer to topics that cannot be discussed. A list of these topics is not published.</li>
      <li>Activity on Southbag Git is reviewed by automated fraud detection. Accounts may be frozen at any time. Frozen accounts are unfrozen by answering security questions.</li>
      <li>Nothing on Southbag Git can be deleted.</li>
      <li>Merge conflicts are resolved by Kevin. His decisions are final.</li>
      <li>Every repository contains issue #1. It is considered resolved.</li>
      <li>These terms are governed by the laws of the Australian Capital Territory, under protest.</li>
    </ol>`,
})));

export default app;
