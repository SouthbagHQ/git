// /:owner/:repo/pushes (the push queue) and /:owner/:repo/settings.

import { Hono } from 'hono';
import { html } from 'hono/html';
import type { AppEnv } from '../env';
import { listVisibleBranches } from '../git/refs';
import { mentionsBannedTopic } from '../lib/banned';
import { aestText, isBusinessHours, nextOpening } from '../lib/hours';
import { fail, form, redirect, requireActiveUser, requireUser, str } from '../lib/http';
import type { RefUpdate } from '../lib/policy';
import { repoUrl } from '../lib/repos';
import { card, dateTime, emptyState, page, statusWord, userLink } from '../views/layout';
import { header, loadRepo } from './repo-shared';

const app = new Hono<AppEnv>();
const ZERO = /^0+$/;

app.get('/:owner/:repo/pushes', async c => {
  const repo = await loadRepo(c);
  const { results } = await c.env.DB.prepare(`SELECT pushes.*, users.username FROM pushes JOIN users ON users.id = pushes.user_id
    WHERE repo_id = ? ORDER BY created_at DESC LIMIT 100`).bind(repo.id)
    .all<{ id: string; username: string; status: string; updates: string; commits: number; after_hours: number; reason: string | null; due_at: number; created_at: number; processed_at: number | null }>();
  const now = Date.now();
  return c.html(page({
    title: `Push queue - ${repo.owner}/${repo.name}`,
    layout: 'wide',
    user: c.get('user'),
    flash: c.get('flash'),
    body: html`
      ${await header(c, repo, 'pushes')}
      <h2 class="page-title">Push queue</h2>
      <p>Pushes are processed during business hours (9:00 to 17:00 AEST, Monday to Friday). Pushes received outside business
        hours are processed on the next business day. ${isBusinessHours(now) ? 'Processing is currently open.'
          : `Processing is currently closed. Next opening: ${aestText(nextOpening(now))}.`}</p>
      ${results.length ? html`<table class="table push-table">
        <thead><tr><th>Received</th><th>Pushed by</th><th>Branches</th><th>Commits</th><th>Status</th><th>Processing</th></tr></thead>
        <tbody>${results.map(p => {
          const updates = JSON.parse(p.updates) as RefUpdate[];
          return html`<tr>
            <td>${dateTime(p.created_at)}${p.after_hours ? html`<br><span class="muted">After hours</span>` : ''}</td>
            <td>${userLink(p.username)}</td>
            <td>${updates.map(u => html`<div><code>${u.ref.replace('refs/heads/', '')}</code>
              ${ZERO.test(u.new) ? 'deleted' : html`<a href="${repoUrl(repo)}/commit/${u.new}"><code>${u.new.slice(0, 7)}</code></a>`}</div>`)}</td>
            <td>${p.commits}</td>
            <td>${statusWord(p.status === 'processing' ? 'pending' : p.status)}${p.reason ? html`<br><span class="muted">${p.reason}</span>` : ''}</td>
            <td>${p.status === 'pending' || p.status === 'processing' ? `Expected ${aestText(p.due_at)}` : p.processed_at ? dateTime(p.processed_at) : ''}</td>
          </tr>`;
        })}</tbody></table>` : emptyState('No pushes.')}`,
  }));
});

app.get('/:owner/:repo/settings', async c => {
  const user = requireUser(c);
  const repo = await loadRepo(c);
  if (user.id !== repo.owner_id) fail(403, 'Only the repository owner can change settings.');
  const branches = await listVisibleBranches(c.env, repo);
  return c.html(page({
    title: `Settings - ${repo.owner}/${repo.name}`,
    layout: 'wide',
    user,
    flash: c.get('flash'),
    body: html`
      ${await header(c, repo, 'settings')}
      ${card('Repository', html`
        <form method="post" action="${repoUrl(repo)}/settings" class="form">
          <label>Description<input name="description" value="${repo.description}" maxlength="250"></label>
          <label>Default branch<select name="branch">${branches.length ? branches.map(b => html`<option ${b.name === repo.default_branch ? 'selected' : ''}>${b.name}</option>`)
            : html`<option>${repo.default_branch}</option>`}</select></label>
          <button class="btn" type="submit">Save</button>
        </form>`)}
      ${card('Collaborators', html`<p>Collaborators are not available. Every change to this repository requires a request.</p>`)}
      ${card('Danger zone', html`
        <p><button class="btn" type="button" data-refuse-delete>Transfer ownership</button></p>
        <p><button class="btn" type="button" data-refuse-delete>Archive this repository</button></p>
        <p><button class="btn" type="button" data-refuse-delete>Delete this repository</button></p>`)}`,
  }));
});

app.post('/:owner/:repo/settings', async c => {
  const user = requireActiveUser(c);
  const repo = await loadRepo(c);
  if (user.id !== repo.owner_id) fail(403, 'Only the repository owner can change settings.');
  const f = await form(c);
  const description = str(f.description, 250);
  if (mentionsBannedTopic(description)) fail(400, 'That description refers to a topic that cannot be discussed.');
  const branches = await listVisibleBranches(c.env, repo);
  const branch = branches.some(b => b.name === f.branch) ? f.branch : repo.default_branch;
  await c.env.DB.prepare('UPDATE repos SET description = ?, default_branch = ?, updated_at = ? WHERE id = ?')
    .bind(description, branch, Date.now(), repo.id).run();
  return redirect(c, `${repoUrl(repo)}/settings`, 'Saved.');
});

export default app;
