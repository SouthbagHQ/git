// Account pages: fees, fee waivers, billing, settings, access tokens, notifications, security
// questions and the cross-repository request inbox.

import { Hono } from 'hono';
import { html } from 'hono/html';
import type { AppEnv } from '../env';
import { FEES, chargeFee, money, type FeeKey } from '../lib/fees';
import { fail, form, redirect, requireActiveUser, requireUser, str } from '../lib/http';
import { QUESTIONS, STREAK_NEEDED, answerQuestion } from '../lib/security';
import { KIND_LABEL, requestSelect, type RequestRow } from '../lib/requests';
import { TOKEN_DAYS, createToken } from '../lib/tokens';
import { LICENCES, applyForWaiver } from '../lib/waivers';
import { aestText, isBusinessHours, nextOpening } from '../lib/hours';
import { card, dateTime, emptyState, page, statusWord, timeAgo } from '../views/layout';

const app = new Hono<AppEnv>();

const FEE_GROUPS: [string, FeeKey[]][] = [
  ['Pull requests', ['pull_file', 'pull_approve', 'pull_execute']],
  ['Push requests', ['push_file', 'push_approve', 'push_execute', 'push_after_hours', 'push_rejected']],
  ['Merge requests', ['merge_file', 'merge_approve', 'merge_execute', 'merge_conflict']],
  ['Fork requests', ['fork_file', 'fork_approve', 'fork_execute']],
  ['Star requests', ['star_file', 'star_approve', 'star_execute', 'unstar_file', 'unstar_approve', 'unstar_execute']],
  ['Requests', ['request_decline', 'request_withdraw']],
  ['Repositories and issues', ['repo_create', 'issue_file', 'comment']],
  ['Account', ['token_create', 'username_change', 'fraud_review', 'security_wrong']],
  ['Fee waivers', ['waiver_apply', 'waiver_decline']],
];

app.get('/fees', c => c.html(page({
  title: 'Fee schedule',
  user: c.get('user'),
  flash: c.get('flash'),
  body: html`
    <h1 class="page-title">Fee schedule</h1>
    <p>Fees are taken from your Southbag Online Banking account when they are incurred. Approval fees are charged to
      whoever approves the request.</p>
    <p>Business hours are 9:00 to 17:00 AEST, Monday to Friday. Pushes received outside business hours are processed on the
      next business day and attract the after-hours push processing fee.</p>
    ${FEE_GROUPS.map(([group, keys]) => card(group, html`
      <table class="table fee-table">
        <thead><tr><th>Fee</th><th>Amount</th></tr></thead>
        <tbody>${keys.map(key => html`<tr><td>${FEES[key].label}</td><td>${money(FEES[key].amount)}</td></tr>`)}</tbody>
      </table>`))}
    <p>Open source projects may <a href="/waivers">apply for a fee waiver</a>.</p>`,
})));

// ── Fee waivers ──

app.get('/waivers', async c => {
  const user = c.get('user');
  const waivers = user ? (await c.env.DB.prepare('SELECT * FROM waivers WHERE user_id = ? ORDER BY created_at DESC LIMIT 50')
    .bind(user.id).all<{ id: string; project: string; licence: string; status: string; decision: string | null; created_at: number; decided_at: number | null }>()).results : [];
  return c.html(page({
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
          <thead><tr><th>Project</th><th>Licence</th><th>Lodged</th><th>Status</th><th>Decision</th></tr></thead>
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
  return redirect(c, '/waivers', `Application lodged. Application fee: ${money(FEES.waiver_apply.amount)}. You will be notified of the outcome.`);
});

// ── Billing ──

app.get('/billing', async c => {
  const user = requireUser(c);
  const { results } = await c.env.DB.prepare('SELECT * FROM charges WHERE user_id = ? ORDER BY created_at DESC LIMIT 200')
    .bind(user.id).all<{ id: string; amount: number; description: string; status: string; created_at: number }>();
  const total = results.filter(r => r.status === 'charged').reduce((n, r) => n + r.amount, 0);
  return c.html(page({
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
  if (/^kevin$/i.test(username)) fail(409, 'That username is taken.');
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
    title: 'Account security', user, flash: c.get('flash'),
    body: html`<h1 class="page-title">Account security</h1><p>Your account is not frozen.</p>`,
  }));
  const events = (await c.env.DB.prepare(`SELECT rule, detail, created_at FROM fraud_events WHERE user_id = ? AND rule != 'activity'
    ORDER BY created_at DESC LIMIT 10`).bind(user.id).all<{ rule: string; detail: string; created_at: number }>()).results;
  const question = QUESTIONS[user.security_question ?? ''] ?? QUESTIONS.ceo;
  return c.html(page({
    title: 'Account review',
    user,
    flash: c.get('flash'),
    body: html`
      <h1 class="page-title">Account review</h1>
      <p>Your account was frozen on ${user.frozen_at ? dateTime(user.frozen_at) : 'an unrecorded date'} by fraud detection.
        Reason: ${user.frozen_reason ?? 'Not recorded'}.</p>
      <p>To unfreeze your account, answer ${STREAK_NEEDED} security questions correctly in a row. An incorrect answer costs
        ${money(FEES.security_wrong.amount)} and starts again. The account review fee of ${money(FEES.fraud_review.amount)} applies
        when your account is unfrozen.</p>
      ${card(`Question ${user.security_streak + 1} of ${STREAK_NEEDED}`, html`
        <form method="post" action="/security" class="form" autocomplete="off">
          <label>${question.text}<input name="answer" required maxlength="200" autocomplete="off"></label>
          <button class="btn" type="submit">Submit answer</button>
        </form>`)}
      ${card('Findings', html`<table class="table"><thead><tr><th>Rule</th><th>Detail</th><th>When</th></tr></thead>
        <tbody>${events.map(e => html`<tr><td>${e.rule}</td><td>${e.detail}</td><td>${dateTime(e.created_at)}</td></tr>`)}</tbody></table>`)}`,
  }));
});

app.post('/security', async c => {
  const user = requireUser(c);
  const answer = str((await form(c)).answer, 200);
  const result = await answerQuestion(c.env, user, answer);
  if (result.unfrozen) return redirect(c, '/', `Your account has been unfrozen. Account review fee: ${money(FEES.fraud_review.amount)}.`);
  return redirect(c, '/security', result.correct ? 'Correct.' : `Incorrect. Incorrect security answer fee: ${money(FEES.security_wrong.amount)}.`);
});

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
    title: 'Requests',
    user,
    flash: c.get('flash'),
    body: html`
      <h1 class="page-title">Requests</h1>
      <p>Business hours: 9:00 to 17:00 AEST, Monday to Friday. ${isBusinessHours(Date.now())
        ? 'Southbag Git is currently in business hours.'
        : html`Southbag Git is currently outside business hours. Next opening: ${aestText(nextOpening(Date.now()))}.`}</p>
      ${card('Awaiting your decision', table(inbox))}
      ${card('Filed by you', table(mine))}`,
  }));
});

export default app;
