// Landing page / dashboard, explore, new repository and user profiles.

import { Hono } from 'hono';
import { html } from 'hono/html';
import type { AppEnv, Repo, User } from '../env';
import { initialCommit } from '../git/write';
import { ObjectStore } from '../git/store';
import { setRef } from '../git/refs';
import { FEES, chargeFee, money } from '../lib/fees';
import { fail, form, pageNumber, redirect, requireActiveUser, str, validName } from '../lib/http';
import { insertRepo, listRepos, repoUrl } from '../lib/repos';
import { mentionsBannedTopic } from '../lib/banned';
import { card, emptyState, page, timeAgo, userLink } from '../views/layout';
import { person } from './repo-shared';

const app = new Hono<AppEnv>();

export const repoList = (repos: Repo[]) => repos.length ? html`<ul class="repo-list">${repos.map(r => html`
  <li class="repo-list-item">
    <a class="repo-list-name" href="${repoUrl(r)}">${r.owner}/${r.name}</a>
    ${r.forked_from ? html`<span class="muted">Fork</span>` : ''}
    <p>${r.description || 'No description.'}</p>
    <span class="muted">Stars ${r.stars} | Forks ${r.forks} | Updated ${timeAgo(r.updated_at)}</span>
  </li>`)}</ul>` : emptyState('No repositories yet.');

app.get('/', async c => {
  const user = c.get('user');
  if (!user) {
    return c.html(page({
      path: c.req.path,
      unread: c.get('unread'),
      title: 'Southbag Git',
      user,
      flash: c.get('flash') ?? (c.req.query('login_error') ? 'Sign-in failed. Please try again.' : null),
      body: html`
        <section class="landing">
          <h1 class="page-title">Southbag Git</h1>
          <p class="lead">Source code hosting for Southbag customers.</p>
          <p>Repositories, issues and merge requests. Pull requests, push requests, fork requests and star requests.
            Every push is processed during business hours.</p>
          <p><a class="btn btn-large" href="/auth/login">Sign in with Southbag Identity</a></p>
          <p class="muted">Activity on Southbag Git is reviewed. Continued use constitutes acceptance.</p>
          ${card('Recently updated', repoList(await listRepos(c.env, '', [], 'repos.updated_at DESC', 10)))}
        </section>`,
    }));
  }
  const mine = await listRepos(c.env, 'repos.owner_id = ?', [user.id], 'repos.updated_at DESC', 50);
  const waiting = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM requests JOIN repos ON repos.id = requests.repo_id
    WHERE repos.owner_id = ? AND requests.status = 'open'`).bind(user.id).first<{ n: number }>();
  const pending = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM pushes WHERE user_id = ? AND status = 'pending'`).bind(user.id).first<{ n: number }>();
  const { results: notes } = await c.env.DB.prepare('SELECT body, link, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 8')
    .bind(user.id).all<{ body: string; link: string | null; created_at: number }>();
  return c.html(page({
    path: c.req.path,
    unread: c.get('unread'),
    title: 'Dashboard',
    user,
    flash: c.get('flash'),
    body: html`
      <h1 class="page-title">Dashboard</h1>
      <div class="dashboard">
        <div>
          ${card('Your repositories', html`<p><a class="btn" href="/repo/new">New repository</a></p>${repoList(mine)}`)}
        </div>
        <div>
          ${card('Summary', html`<ul class="list">
            <li class="list-item"><a href="/requests">${waiting?.n ?? 0} requests awaiting your decision</a></li>
            <li class="list-item">${pending?.n ?? 0} pushes pending processing</li>
            <li class="list-item"><a href="/billing">Billing</a></li>
          </ul>`)}
          ${card('Recent activity', notes.length ? html`<ul class="list">${notes.map(n => html`<li class="list-item">
            ${n.link ? html`<a href="${n.link}">${n.body}</a>` : n.body} <span class="muted">${timeAgo(n.created_at)}</span></li>`)}</ul>`
            : emptyState('No activity.'))}
        </div>
      </div>`,
  }));
});

app.get('/explore', async c => {
  const q = str(c.req.query('q'), 100);
  const pageNo = pageNumber(c);
  const repos = q
    ? await listRepos(c.env, `(repos.name LIKE ? OR repos.description LIKE ?)`, [`%${q}%`, `%${q}%`], 'repos.stars DESC, repos.updated_at DESC', 30, (pageNo - 1) * 30)
    : await listRepos(c.env, '', [], 'repos.updated_at DESC', 30, (pageNo - 1) * 30);
  const { results: users } = await c.env.DB.prepare(`SELECT username, name FROM users WHERE id != 'kevin' ORDER BY created_at DESC LIMIT 20`)
    .all<{ username: string; name: string }>();
  return c.html(page({
    path: c.req.path,
    unread: c.get('unread'),
    title: 'Explore',
    user: c.get('user'),
    flash: c.get('flash'),
    body: html`
      <h1 class="page-title">Explore</h1>
      <form method="get" action="/explore" class="form form-inline"><input name="q" value="${q}" placeholder="Search repositories">
        <button class="btn" type="submit">Search</button></form>
      ${card('Repositories', html`${repoList(repos)}
        <p class="pagination">${pageNo > 1 ? html`<a href="?q=${q}&page=${pageNo - 1}">Previous</a>` : ''}
          ${repos.length === 30 ? html`<a href="?q=${q}&page=${pageNo + 1}">Next</a>` : ''}</p>`)}
      ${card('Users', html`<ul class="list">${users.map(u => html`<li class="list-item">${userLink(u.username)} ${u.name}</li>`)}</ul>`)}`,
  }));
});

app.get('/repo/new', c => {
  const user = requireActiveUser(c);
  return c.html(page({
    path: c.req.path,
    unread: c.get('unread'),
    title: 'New repository',
    user,
    flash: c.get('flash'),
    body: html`
      <h1 class="page-title">New repository</h1>
      ${card('Repository details', html`
        <form method="post" action="/repo/new" class="form" data-form="SG-R1" data-confirm="Create this repository? The repository establishment fee is ${money(FEES.repo_create.amount)}.">
          <label>Owner<select name="owner"><option>${user.username}</option></select></label>
          <label>Repository name<input name="name" required maxlength="64" pattern="[A-Za-z0-9._-]+"></label>
          <label>Description<input name="description" maxlength="250"></label>
          <label>Visibility<select name="visibility"><option>Public</option></select></label>
          <p class="hint">All repositories are public. Activity is reviewed.</p>
          <label>Default branch<input name="branch" value="main" maxlength="64"></label>
          <label>Licence<select name="licence"><option>Southbag Proprietary Licence</option></select></label>
          <label class="check"><input type="checkbox" name="init" checked> Initialise this repository with a README</label>
          <label class="check"><input type="checkbox" name="terms" required> I accept the Southbag Git Terms of Service and acknowledge that fees apply.</label>
          <button class="btn btn-large" type="submit">Create repository (${money(FEES.repo_create.amount)})</button>
        </form>`)}`,
  }));
});

app.post('/repo/new', async c => {
  const user = requireActiveUser(c);
  const f = await form(c);
  const name = str(f.name, 64);
  const description = str(f.description, 250);
  const branch = str(f.branch, 64) || 'main';
  if (!validName(name)) fail(400, 'Repository names are letters, digits, dots, hyphens and underscores.');
  if (!/^[A-Za-z0-9._/-]{1,64}$/.test(branch) || branch === 'floor-3') fail(400, 'That branch name is not available.');
  if (mentionsBannedTopic(`${name} ${description}`)) fail(400, 'That name or description refers to a topic that cannot be discussed.');
  if (!f.terms) fail(400, 'You must accept the Terms of Service.');
  if (await c.env.DB.prepare('SELECT 1 FROM repos WHERE owner_id = ? AND name = ?').bind(user.id, name).first())
    fail(409, 'You already have a repository with that name.');
  const repo = await insertRepo(c.env, user, { name, description, defaultBranch: branch });
  if (f.init) {
    const store = new ObjectStore(c.env, repo.network_id);
    const oid = await initialCommit(store, {
      'README.md': `# ${name}\n\n${description || 'No description.'}\n\nThis repository is hosted on Southbag Git. Fees apply.\n`,
      'LICENCE': 'Southbag Proprietary Licence\n\nAll rights reserved by Southbag. Kevin reserves the remainder.\n',
    }, person(user.name, user.email || `${user.username}@users.git.southbag.cc`));
    await setRef(c.env, repo.id, `refs/heads/${branch}`, oid);
  }
  await chargeFee(c.env, user, 'repo_create', `${user.username}/${name}`);
  return redirect(c, repoUrl(repo), `Repository created. Repository establishment fee: ${money(FEES.repo_create.amount)}.`);
});

// ── Profiles ──

app.get('/:owner', async c => {
  const username = c.req.param('owner');
  const profile = await c.env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first<User>();
  if (!profile) fail(404, 'User not found.');
  const repos = await listRepos(c.env, 'repos.owner_id = ?', [profile.id], 'repos.updated_at DESC', 50);
  const starred = await listRepos(c.env, 'repos.id IN (SELECT repo_id FROM stars WHERE user_id = ?)', [profile.id], 'repos.stars DESC', 20);
  return c.html(page({
    path: c.req.path,
    unread: c.get('unread'),
    title: profile.username,
    user: c.get('user'),
    flash: c.get('flash'),
    body: html`
      <div class="profile">
        <div class="profile-side">
          <div class="avatar avatar-large">${profile.username.slice(0, 1).toUpperCase()}</div>
          <h1 class="page-title">${profile.name}</h1>
          <p class="muted">${profile.username}</p>
          <p>${profile.bio || (profile.id === 'kevin' ? '' : 'No bio.')}</p>
          ${profile.frozen ? html`<p class="notice">This account is under review.</p>` : ''}
        </div>
        <div class="profile-main">
          ${card('Repositories', repoList(repos))}
          ${card('Starred', repoList(starred))}
        </div>
      </div>`,
  }));
});

export default app;
