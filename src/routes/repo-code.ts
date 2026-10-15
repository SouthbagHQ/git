// The code browser: /:owner/:repo (home), /src, /raw, /commits, /commit, /branches and /activity.
// Mounted last under /:owner/:repo so it can own the repository home and the 404 catch-all.
// CPU is bounded: last-commit lookups are capped per directory and diffs have a line budget.

import { Hono } from 'hono';
import { html } from 'hono/html';
import type { AppEnv, Ctx, Repo } from '../env';
import { diffCommit } from '../git/diff';
import { isBinary, isTreeMode, isGitlinkMode, fromUtf8, type Commit, type TreeEntry } from '../git/objects';
import { listTags, listVisibleBranches, resolveRef, type Branch } from '../git/refs';
import { ObjectStore } from '../git/store';
import { FEES } from '../lib/fees';
import { fail, pageNumber } from '../lib/http';
import { repoUrl } from '../lib/repos';
import { blobView, branchMenu, breadcrumbs, cloneBox, commitList, diffView, fileTable, firstLine, latestCommit, type TreeEntry as ViewEntry } from '../views/code';
import { markdown } from '../views/markdown';
import { card, dateOnly, dateTime, emptyState, money, page, pagination, statusWord, userLink, when, type Child } from '../views/layout';
import { header, loadRepo, toDiffFiles, type Tab } from './repo-shared';

const app = new Hono<AppEnv>();

const PER_PAGE = 30;
/** Directory entries that get a "last commit" lookup; the rest are listed without one. */
const LAST_COMMIT_CAP = 25;
const MAX_SHOWN_BYTES = 1_000_000;

// ── Helpers ─────────────────────────────────────────────────────────────

const seg = (s: string) => encodeURIComponent(s);
const pathSegs = (p: string) => p.split('/').filter(Boolean).map(seg).join('/');
const srcUrl = (repo: Repo, ref: string, path = '') => `${repoUrl(repo)}/src/${seg(ref)}${path ? `/${pathSegs(path)}` : ''}`;
const rawUrl = (repo: Repo, ref: string, path: string) => `${repoUrl(repo)}/raw/${seg(ref)}/${pathSegs(path)}`;
const commitUrl = (repo: Repo, oid: string) => `${repoUrl(repo)}/commit/${oid}`;
const commitsUrl = (repo: Repo, ref: string, path = '') => `${repoUrl(repo)}/commits/${seg(ref)}${path ? `?path=${encodeURIComponent(path)}` : ''}`;
const cloneUrl = (c: Ctx, repo: Repo) => `${new URL(c.req.url).origin}${repoUrl(repo)}.git`;
const ms = (commit: Commit) => commit.committer.time * 1000;

async function repoPage(c: Ctx, repo: Repo, tab: Tab, title: string, body: Child) {
  return c.html(page({
    title: `${title}${title ? ' - ' : ''}${repo.owner}/${repo.name}`,
    user: c.get('user'),
    flash: c.get('flash'),
    layout: 'wide',
    path: c.req.path,
    unread: c.get('unread'),
    body: html`${await header(c, repo, tab)}${body}`,
  }));
}

/** The default branch, or the first branch if the default doesn't exist. Null for an empty repository. */
const pickBranch = (repo: Repo, branches: Branch[]) => branches.find(b => b.name === repo.default_branch) ?? branches[0] ?? null;

async function pendingBanner(c: Ctx, repo: Repo) {
  const row = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM pushes WHERE repo_id = ? AND status IN ('pending', 'processing')").bind(repo.id).first<{ n: number }>();
  const n = row?.n ?? 0;
  if (!n) return '';
  return html`<div class="pending-banner">${n === 1 ? '1 push is' : `${n} pushes are`} pending processing. <a href="${repoUrl(repo)}/pushes">View push queue</a></div>`;
}

/** Directories first, then files, by name. */
const sortEntries = (entries: TreeEntry[]) => [...entries].sort((a, b) => {
  const da = isTreeMode(a.mode) ? 0 : 1, db = isTreeMode(b.mode) ? 0 : 1;
  return da - db || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
});

/** File table rows for a directory, with the last commit for the first LAST_COMMIT_CAP entries. */
async function directoryRows(store: ObjectStore, repo: Repo, ref: string, oid: string, dir: string, entries: TreeEntry[]): Promise<ViewEntry[]> {
  const sorted = sortEntries(entries);
  const rows: ViewEntry[] = [];
  for (const [i, e] of sorted.entries()) {
    const path = dir ? `${dir}/${e.name}` : e.name;
    let commit: ViewEntry['commit'] = null;
    if (i < LAST_COMMIT_CAP) {
      const [last] = await store.log(oid, { path, limit: 1 });
      if (last) commit = { message: last.commit.message, href: commitUrl(repo, last.oid), time: ms(last.commit) };
    }
    rows.push({
      name: e.name,
      type: isTreeMode(e.mode) ? 'tree' : isGitlinkMode(e.mode) ? 'commit' : 'blob',
      href: isGitlinkMode(e.mode) ? commitUrl(repo, e.oid) : srcUrl(repo, ref, path),
      commit,
    });
  }
  return rows;
}

async function latestBar(store: ObjectStore, repo: Repo, oid: string, path = '') {
  const [last] = await store.log(oid, { path, limit: 1 });
  return last ? { sha: last.oid, href: commitUrl(repo, last.oid), message: last.commit.message, author: last.commit.author.name, time: ms(last.commit) } : null;
}

const toolbar = (c: Ctx, repo: Repo, ref: string, branches: Branch[], path: string, extra: Child = '') => html`<div class="repo-toolbar">
  ${branchMenu(ref, branches.map(b => ({ name: b.name, href: srcUrl(repo, b.name, path) })))}
  ${breadcrumbs([{ name: repo.name, href: srcUrl(repo, ref) }, ...path.split('/').filter(Boolean).map((part, i, all) =>
    ({ name: part, href: i < all.length - 1 ? srcUrl(repo, ref, all.slice(0, i + 1).join('/')) : undefined }))])}
  <span class="spacer"></span>
  ${extra}
  ${cloneBox(cloneUrl(c, repo), { archive: `${repoUrl(repo)}/archive` })}
</div>`;

const README = /^readme(\.(md|markdown|txt))?$/i;

async function readme(store: ObjectStore, repo: Repo, ref: string, dir: string, entries: TreeEntry[]) {
  const entry = entries.find(e => README.test(e.name) && !isTreeMode(e.mode) && !isGitlinkMode(e.mode));
  if (!entry) return '';
  const data = await store.readBlob(entry.oid);
  if (!data || isBinary(data) || data.length > MAX_SHOWN_BYTES) return '';
  const text = fromUtf8(data);
  const body = /\.txt$/i.test(entry.name)
    ? html`<pre>${text}</pre>`
    : markdown(text, { base: srcUrl(repo, ref, dir) });
  return html`<section class="south-card readme"><div class="readme-head">${entry.name}</div><div class="markdown">${body}</div></section>`;
}

function emptyRepo(c: Ctx, repo: Repo) {
  const url = cloneUrl(c, repo);
  return card('Empty repository', html`
    <p>This repository has no commits yet.</p>
    <p>Cloning needs no request (clone fee ${money(FEES.clone.amount)}). Pulling or fetching afterwards needs an approved pull request. Pushing needs an approved push request. Requests are filed from the <a href="/requests">Requests</a> page.
      Use an access token as the password for git over HTTPS. Create one at <a href="/settings/tokens">Access tokens</a>
      (issuance fee ${money(FEES.token_create.amount)}).</p>
    <div class="repo-toolbar">${cloneBox(url, { archive: `${repoUrl(repo)}/archive` })}</div>
    <h3>Push an existing repository</h3>
    <pre><code>git remote add origin ${url}
git push -u origin ${repo.default_branch}</code></pre>
    <h3>Create a new repository</h3>
    <pre><code>git clone ${url}
cd ${repo.name}
echo "# ${repo.name}" &gt; README.md
git add README.md
git commit -m "Initial commit"
git push -u origin ${repo.default_branch}</code></pre>
    <div class="fee-notice"><strong>Fees apply.</strong>
      Push request: <span class="fee">${money(FEES.push_file.amount + FEES.push_approve.amount + FEES.push_execute.amount)}</span> (filing, approval and execution).
      Pull request: <span class="fee">${money(FEES.pull_file.amount + FEES.pull_approve.amount + FEES.pull_execute.amount)}</span>.
      Pushes are processed 9:00 to 17:00 AEST, Monday to Friday. After-hours processing fee ${money(FEES.push_after_hours.amount)}.</div>`);
}

/** Resolves a ref from the URL (branch, tag, commit id; floor-3 too) or 404s. */
async function resolve(c: Ctx, repo: Repo, store: ObjectStore, ref: string) {
  const oid = await resolveRef(c.env, repo, ref, store);
  if (!oid) fail(404, 'Branch, tag or commit not found.');
  const commit = await store.readCommit(oid);
  if (!commit) fail(404, 'Branch, tag or commit not found.');
  return oid;
}

// ── Repository home ─────────────────────────────────────────────────────

app.get('/:owner/:repo', async c => {
  const repo = await loadRepo(c);
  const branches = await listVisibleBranches(c.env, repo);
  const branch = pickBranch(repo, branches);
  if (!branch) return repoPage(c, repo, 'code', '', emptyRepo(c, repo));
  const store = new ObjectStore(c.env, repo.network_id);
  return treePage(c, repo, store, branch.name, branch.oid, '', branches);
});

async function treePage(c: Ctx, repo: Repo, store: ObjectStore, ref: string, oid: string, path: string, branches: Branch[]) {
  const at = await store.getPath(oid, path);
  if (!at) fail(404, 'Path not found.');
  const tags = await listTags(c.env, repo);
  const count = await store.countCommits(oid, 1000);
  const links = html`<a class="btn-small" href="${commitsUrl(repo, ref, path)}">${count >= 1000 ? '1000+' : count} ${count === 1 ? 'commit' : 'commits'}</a>
    <a class="btn-small" href="${repoUrl(repo)}/branches">${branches.length} ${branches.length === 1 ? 'branch' : 'branches'}${tags.length ? `, ${tags.length} ${tags.length === 1 ? 'tag' : 'tags'}` : ''}</a>`;
  const top = html`${await pendingBanner(c, repo)}${toolbar(c, repo, ref, branches, path, links)}`;

  if (at.kind === 'gitlink') {
    return repoPage(c, repo, 'code', path, html`${top}${card(null, html`<p>Submodule at <span class="sha">${at.oid}</span>.</p>`)}`);
  }
  if (at.kind === 'blob') {
    const tooLarge = at.data.length > MAX_SHOWN_BYTES;
    const binary = !tooLarge && isBinary(at.data);
    const latest = await latestBar(store, repo, oid, path);
    return repoPage(c, repo, 'code', path, html`${top}
      ${latest ? html`<div class="blob-latest">${latestCommit(latest)}</div>` : ''}
      ${blobView({ path, text: tooLarge || binary ? null : fromUtf8(at.data), size: at.data.length, tooLarge, rawHref: rawUrl(repo, ref, path), historyHref: commitsUrl(repo, ref, path) })}`);
  }
  const parent = path ? path.split('/').slice(0, -1).join('/') : null;
  const rows = await directoryRows(store, repo, ref, oid, path, at.entries);
  const latest = await latestBar(store, repo, oid, path);
  return repoPage(c, repo, 'code', path, html`${top}
    ${fileTable(rows, { latest, parentHref: parent == null ? null : srcUrl(repo, ref, parent) })}
    ${rows.length ? '' : emptyState('This folder is empty.')}
    ${await readme(store, repo, ref, path, at.entries)}`);
}

// ── Tree and blob ───────────────────────────────────────────────────────

const srcHandler = async (c: Ctx) => {
  const repo = await loadRepo(c);
  const ref = c.req.param('ref') ?? '';
  const path = (c.req.param('path') ?? '').replace(/^\/+|\/+$/g, '');
  const store = new ObjectStore(c.env, repo.network_id);
  const oid = await resolve(c, repo, store, ref);
  return treePage(c, repo, store, ref, oid, path, await listVisibleBranches(c.env, repo));
};
app.get('/:owner/:repo/src/:ref', srcHandler);
app.get('/:owner/:repo/src/:ref/:path{.+}', srcHandler);
app.get('/:owner/:repo/src', async c => {
  const repo = await loadRepo(c);
  return c.redirect(repoUrl(repo));
});

// ── Raw ─────────────────────────────────────────────────────────────────

app.get('/:owner/:repo/raw/:ref/:path{.+}', async c => {
  const repo = await loadRepo(c);
  const store = new ObjectStore(c.env, repo.network_id);
  const oid = await resolve(c, repo, store, c.req.param('ref'));
  const at = await store.getPath(oid, c.req.param('path'));
  if (!at || at.kind !== 'blob') fail(404, 'File not found.');
  return new Response(at.data, {
    headers: {
      'content-type': isBinary(at.data) ? 'application/octet-stream' : 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, max-age=60',
    },
  });
});

// ── Commits ─────────────────────────────────────────────────────────────

app.get('/:owner/:repo/commits', async c => {
  const repo = await loadRepo(c);
  const branch = pickBranch(repo, await listVisibleBranches(c.env, repo));
  return c.redirect(branch ? commitsUrl(repo, branch.name) : repoUrl(repo));
});

app.get('/:owner/:repo/commits/:ref', async c => {
  const repo = await loadRepo(c);
  const ref = c.req.param('ref');
  const path = (c.req.query('path') ?? '').replace(/^\/+|\/+$/g, '');
  const store = new ObjectStore(c.env, repo.network_id);
  const oid = await resolve(c, repo, store, ref);
  const pageNo = pageNumber(c);
  const entries = await store.log(oid, { path, limit: PER_PAGE + 1, skip: (pageNo - 1) * PER_PAGE });
  const shown = entries.slice(0, PER_PAGE);
  const branches = await listVisibleBranches(c.env, repo);
  const commits = shown.map(e => ({ sha: e.oid, href: commitUrl(repo, e.oid), message: e.commit.message, author: e.commit.author.name, time: ms(e.commit) }));
  return repoPage(c, repo, 'code', 'Commits', html`
    <div class="repo-toolbar">
      ${branchMenu(ref, branches.map(b => ({ name: b.name, href: commitsUrl(repo, b.name, path) })))}
      <span class="breadcrumbs">Commits${path ? html` to <a href="${srcUrl(repo, ref, path)}">${path}</a>` : ''}</span>
    </div>
    ${commits.length ? commitList(commits, dateOnly) : emptyState('No commits.')}
    ${pagination({ page: pageNo, hasNext: entries.length > PER_PAGE, base: commitsUrl(repo, ref, path) })}`);
});

app.get('/:owner/:repo/commit/:oid', async c => {
  const repo = await loadRepo(c);
  const store = new ObjectStore(c.env, repo.network_id);
  const oid = await resolve(c, repo, store, c.req.param('oid'));
  const commit = (await store.readCommit(oid))!;
  const diff = await diffCommit(store, oid, { maxLines: 3000 });
  const pending = await c.env.DB.prepare("SELECT 1 FROM pushes WHERE repo_id = ? AND status IN ('pending', 'processing') AND updates LIKE ? LIMIT 1")
    .bind(repo.id, `%${oid}%`).first();
  const [subject, ...rest] = commit.message.replace(/\n+$/, '').split('\n');
  const body = rest.join('\n').replace(/^\n+/, '');
  const byKevin = commit.committer.name === 'Kevin';
  const sameCommitter = commit.committer.name === commit.author.name && commit.committer.email === commit.author.email;
  return repoPage(c, repo, 'code', firstLine(commit.message), html`
    ${pending ? html`<div class="pending-banner">This commit is pending processing. <a href="${repoUrl(repo)}/pushes">View push queue</a></div>` : ''}
    <div class="commit-head">
      <p class="message${byKevin ? ' kevin' : ''}">${subject}</p>
      ${body ? html`<p class="body">${body}</p>` : ''}
      <div class="meta">
        <span><strong>${commit.author.name}</strong> authored ${dateTime(commit.author.time * 1000)}</span>
        ${sameCommitter ? '' : html`<span><strong${byKevin ? html` class="kevin"` : ''}>${commit.committer.name}</strong> committed ${dateTime(ms(commit))}</span>`}
        <span>Commit <span class="sha">${oid}</span></span>
        ${commit.parents.length ? html`<span>${commit.parents.length === 1 ? 'Parent' : 'Parents'} ${commit.parents.map((p, i) => html`${i ? ', ' : ''}<a class="sha" href="${commitUrl(repo, p)}">${p.slice(0, 10)}</a>`)}</span>` : html`<span>Root commit</span>`}
        <span><a href="${srcUrl(repo, oid)}">Browse files</a></span>
      </div>
    </div>
    ${diff.truncated ? html`<div class="notice">This diff is too large to show in full.</div>` : ''}
    ${diff.files.length ? diffView(toDiffFiles(diff.files)) : emptyState('No changes.')}`);
});

// ── Branches ────────────────────────────────────────────────────────────

app.get('/:owner/:repo/branches', async c => {
  const repo = await loadRepo(c);
  const store = new ObjectStore(c.env, repo.network_id);
  const branches = await listVisibleBranches(c.env, repo);
  const tags = await listTags(c.env, repo);
  await store.readCommits([...branches, ...tags].map(b => b.oid));
  const row = async (b: Branch, kind: 'branch' | 'tag') => {
    const oid = await store.peel(b.oid);
    const commit = oid ? await store.readCommit(oid) : null;
    return html`<tr>
      <td><a href="${srcUrl(repo, b.name)}">${b.name}</a>${kind === 'branch' && b.name === repo.default_branch ? html` <span class="state-word">Default</span>` : ''}</td>
      <td>${commit ? html`<a href="${commitUrl(repo, oid!)}">${firstLine(commit.message)}</a>` : ''}</td>
      <td class="nowrap">${commit ? when(ms(commit)) : ''}</td>
      <td class="right"><button class="btn-small" type="button" data-refuse-delete>Delete</button></td>
    </tr>`;
  };
  const table = async (items: Branch[], kind: 'branch' | 'tag') => html`<div class="table-wrap"><table class="table"><thead><tr><th>${kind === 'branch' ? 'Branch' : 'Tag'}</th><th>Last commit</th><th>Updated</th><th></th></tr></thead>
    <tbody>${await Promise.all(items.map(b => row(b, kind)))}</tbody></table></div>`;
  return repoPage(c, repo, 'code', 'Branches', html`
    <h2>Branches</h2>
    ${branches.length ? await table(branches, 'branch') : emptyState('No branches yet.')}
    ${tags.length ? html`<h2>Tags</h2>${await table(tags, 'tag')}` : ''}`);
});

// ── Activity ────────────────────────────────────────────────────────────

interface PushRow { id: string; username: string; status: string; updates: string; commits: number; after_hours: number; reason: string | null; created_at: number; processed_at: number | null }
interface MergeRow { number: number; title: string; merger: string | null; source_branch: string; target_branch: string; merged_at: number }
interface DecidedRow { id: string; kind: string; status: string; requester: string; decider: string | null; decided_at: number }

const KIND_WORD: Record<string, string> = { pull: 'pull request', push: 'push request', fork: 'fork request', star: 'star request', unstar: 'unstar request' };

app.get('/:owner/:repo/activity', async c => {
  const repo = await loadRepo(c);
  const [pushes, merges, decided] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT pushes.id, users.username, pushes.status, pushes.updates, pushes.commits, pushes.after_hours, pushes.reason, pushes.created_at, pushes.processed_at
      FROM pushes JOIN users ON users.id = pushes.user_id WHERE pushes.repo_id = ? ORDER BY pushes.created_at DESC LIMIT 30`).bind(repo.id),
    c.env.DB.prepare(`SELECT merge_requests.number, merge_requests.title, users.username AS merger, merge_requests.source_branch, merge_requests.target_branch, merge_requests.merged_at
      FROM merge_requests LEFT JOIN users ON users.id = merge_requests.merged_by WHERE merge_requests.repo_id = ? AND merge_requests.status = 'merged'
      ORDER BY merge_requests.merged_at DESC LIMIT 30`).bind(repo.id),
    c.env.DB.prepare(`SELECT requests.id, requests.kind, requests.status, r.username AS requester, d.username AS decider, requests.decided_at
      FROM requests JOIN users r ON r.id = requests.requester_id LEFT JOIN users d ON d.id = requests.decided_by
      WHERE requests.repo_id = ? AND requests.decided_at IS NOT NULL ORDER BY requests.decided_at DESC LIMIT 30`).bind(repo.id),
  ]);
  type Event = { time: number; body: Child };
  const events: Event[] = [];
  for (const p of (pushes.results ?? []) as PushRow[]) {
    let updates: { ref: string; old: string; new: string }[] = [];
    try { updates = JSON.parse(p.updates); } catch {}
    const refs = updates.map(u => u.ref.replace(/^refs\/(heads|tags)\//, ''));
    const tip = updates.find(u => !/^0{40}$/.test(u.new))?.new;
    events.push({
      time: p.created_at,
      body: html`${statusWord(p.status)} ${userLink(p.username)} pushed ${p.commits} ${p.commits === 1 ? 'commit' : 'commits'} to ${refs.join(', ') || 'nothing'}${tip ? html` (<a class="sha" href="${commitUrl(repo, tip)}">${tip.slice(0, 10)}</a>)` : ''}.${p.after_hours ? ' After hours.' : ''}${p.reason ? html` <span class="muted">${p.reason}</span>` : ''}`,
    });
  }
  for (const m of (merges.results ?? []) as MergeRow[]) {
    events.push({
      time: m.merged_at,
      body: html`${statusWord('merged')} ${m.merger ? userLink(m.merger) : 'Someone'} merged <a href="${repoUrl(repo)}/merge-requests/${m.number}">!${m.number} ${m.title}</a> (${m.source_branch} into ${m.target_branch}).`,
    });
  }
  for (const r of (decided.results ?? []) as DecidedRow[]) {
    events.push({
      time: r.decided_at,
      body: html`${statusWord(r.status)} ${r.decider ? userLink(r.decider) : 'Southbag Git'} decided a <a href="${repoUrl(repo)}/requests/${r.kind}/${r.id}">${KIND_WORD[r.kind] ?? 'request'}</a> from ${userLink(r.requester)}.`,
    });
  }
  events.sort((a, b) => b.time - a.time);
  return repoPage(c, repo, 'activity', 'Activity', html`
    <h2>Activity</h2>
    ${events.length
      ? html`<div class="timeline">${events.slice(0, 60).map(e => html`<div class="timeline-item event">${e.body} <span class="faint">${when(e.time)}</span></div>`)}</div>`
      : emptyState('No activity yet.')}`);
});

// ── Everything else ─────────────────────────────────────────────────────

app.get('/:owner/:repo/*', () => fail(404, 'Page not found.'));

export default app;
