// /:owner/:repo/merge-requests — what other forges call pull requests.
// Filed (fee) -> approved by the repository owner (fee, charged to the approver) -> merged by the
// owner (execution fee). Conflicting files are decided at random and the merge is committed by
// Kevin <Kevin@southbag.cc> as "Resolved merge conflict" (plus the conflict resolution fee).

import { Hono } from 'hono';
import { html } from 'hono/html';
import type { AppEnv, Ctx, Repo } from '../env';
import { diffTreeFiles } from '../git/diff';
import { mergeCommits } from '../git/merge';
import { getRef, listVisibleBranches, setRef } from '../git/refs';
import { ObjectStore } from '../git/store';
import { writeCommit } from '../git/write';
import { mentionsBannedTopic } from '../lib/banned';
import { FEES, chargeFee, money } from '../lib/fees';
import { fail, form, redirect, requireActiveUser, str } from '../lib/http';
import { newId } from '../lib/ids';
import { notify } from '../lib/notify';
import { repoById, repoUrl } from '../lib/repos';
import { commitList, diffView, firstLine } from '../views/code';
import { card, dateOnly, emptyState, page, statusWord, timeAgo, userLink } from '../views/layout';
import { commentForm, comments, postComment, timelineItem } from './repo-issues';
import { KEVIN, header, loadRepo, person, toDiffFiles } from './repo-shared';

const app = new Hono<AppEnv>();

interface MergeRow {
  id: string; number: number; author_id: string; author: string; title: string; body: string;
  source_repo_id: string; source_branch: string; target_branch: string; status: 'open' | 'approved' | 'merged' | 'closed';
  approved_by: string | null; approver: string | null; approved_at: number | null;
  merged_by: string | null; merger: string | null; merged_at: number | null; merge_oid: string | null; conflicts: string | null;
  created_at: number;
}

const mergeSelect = `SELECT merge_requests.*, a.username AS author, p.username AS approver, m.username AS merger FROM merge_requests
  JOIN users a ON a.id = merge_requests.author_id LEFT JOIN users p ON p.id = merge_requests.approved_by
  LEFT JOIN users m ON m.id = merge_requests.merged_by`;

const loadMerge = async (c: Ctx, repo: Repo) => {
  const mr = await c.env.DB.prepare(`${mergeSelect} WHERE merge_requests.repo_id = ? AND merge_requests.number = ?`)
    .bind(repo.id, Number(c.req.param('number'))).first<MergeRow>();
  if (!mr) fail(404, 'Merge request not found.');
  return mr;
};

/** Repositories a merge request into `repo` can come from: itself, and forks in the same network owned by the user. */
const sourceRepos = async (c: Ctx, repo: Repo, userId: string) =>
  (await c.env.DB.prepare(`SELECT repos.*, users.username AS owner FROM repos JOIN users ON users.id = repos.owner_id
    WHERE repos.network_id = ? AND (repos.id = ? OR repos.owner_id = ?) ORDER BY repos.id = ? DESC, repos.created_at`)
    .bind(repo.network_id, repo.id, userId, repo.id).all<Repo>()).results;

app.get('/:owner/:repo/merge-requests', async c => {
  const repo = await loadRepo(c);
  const state = c.req.query('state') === 'closed' ? 'closed' : 'open';
  const { results } = await c.env.DB.prepare(`${mergeSelect} WHERE merge_requests.repo_id = ? AND merge_requests.status ${state === 'open'
    ? "IN ('open', 'approved')" : "IN ('merged', 'closed')"} ORDER BY merge_requests.number DESC LIMIT 100`).bind(repo.id).all<MergeRow>();
  return c.html(page({
    title: `Merge requests - ${repo.owner}/${repo.name}`,
    user: c.get('user'),
    flash: c.get('flash'),
    body: html`
      ${await header(c, repo, 'merge')}
      <p>Merge requests propose merging one branch into another. Filing fee ${money(FEES.merge_file.amount)}. Approval fee
        ${money(FEES.merge_approve.amount)} (charged to the approver). Merge execution fee ${money(FEES.merge_execute.amount)}.
        Merge conflicts are resolved by Kevin. Merge conflict resolution fee ${money(FEES.merge_conflict.amount)}.</p>
      <p class="tabs-small"><a href="?state=open" class="${state === 'open' ? 'current' : ''}">Open</a>
        <a href="?state=closed" class="${state === 'closed' ? 'current' : ''}">Closed</a>
        ${c.get('user') ? html`<a class="btn btn-small" href="${repoUrl(repo)}/merge-requests/new">New merge request</a>` : ''}</p>
      ${results.length ? html`<ul class="issue-list">${results.map(m => html`<li class="issue-list-item">
        <a href="${repoUrl(repo)}/merge-requests/${m.number}">${m.title}</a> ${statusWord(m.status)}
        <span class="muted">!${m.number} opened ${timeAgo(m.created_at)} by ${m.author}. ${m.source_branch} into ${m.target_branch}.</span></li>`)}</ul>`
        : emptyState('No merge requests.')}`,
  }));
});

app.get('/:owner/:repo/merge-requests/new', async c => {
  const user = requireActiveUser(c);
  const repo = await loadRepo(c);
  const sources = await sourceRepos(c, repo, user.id);
  const options = (await Promise.all(sources.map(async s => (await listVisibleBranches(c.env, s)).map(b => ({ value: `${s.id}:${b.name}`, label: `${s.owner}/${s.name}: ${b.name}` }))))).flat();
  const targets = await listVisibleBranches(c.env, repo);
  return c.html(page({
    title: `New merge request - ${repo.owner}/${repo.name}`,
    user,
    flash: c.get('flash'),
    body: html`
      ${await header(c, repo, 'merge')}
      ${card('New merge request', targets.length ? html`
        <form method="post" action="${repoUrl(repo)}/merge-requests/new" class="form" data-confirm="File this merge request? The merge request filing fee is ${money(FEES.merge_file.amount)}.">
          <div class="split">
            <label>Merge into<select name="target">${targets.map(b => html`<option ${b.name === repo.default_branch ? 'selected' : ''}>${b.name}</option>`)}</select></label>
            <label>From<select name="source">${options.map(o => html`<option value="${o.value}">${o.label}</option>`)}</select></label>
          </div>
          <label>Title<input name="title" required maxlength="200"></label>
          <label>Description<textarea name="body" maxlength="20000" rows="8"></textarea></label>
          <button class="btn" type="submit">File merge request (${money(FEES.merge_file.amount)})</button>
        </form>` : emptyState('This repository has no branches yet.'))}`,
  }));
});

app.post('/:owner/:repo/merge-requests/new', async c => {
  const user = requireActiveUser(c);
  const repo = await loadRepo(c);
  const f = await form(c);
  const title = str(f.title, 200);
  const body = str(f.body, 20000);
  if (!title) fail(400, 'Enter a title.');
  if (mentionsBannedTopic(`${title}\n${body}`)) fail(400, 'This merge request refers to a topic that cannot be discussed.');
  const [sourceId, sourceBranch] = [f.source?.slice(0, f.source.indexOf(':')), f.source?.slice(f.source.indexOf(':') + 1)];
  const source = (await sourceRepos(c, repo, user.id)).find(s => s.id === sourceId);
  if (!source || !sourceBranch || !await getRef(c.env, source.id, `refs/heads/${sourceBranch}`)) fail(400, 'Choose a branch to merge from.');
  const target = str(f.target, 64);
  if (!await getRef(c.env, repo.id, `refs/heads/${target}`)) fail(400, 'Choose a branch to merge into.');
  if (source.id === repo.id && sourceBranch === target) fail(400, 'A branch cannot be merged into itself.');
  const row = await c.env.DB.prepare('UPDATE repos SET next_number = next_number + 1 WHERE id = ? RETURNING next_number - 1 AS number')
    .bind(repo.id).first<{ number: number }>();
  await c.env.DB.prepare(`INSERT INTO merge_requests (id, repo_id, number, author_id, title, body, source_repo_id, source_branch, target_branch, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(newId(), repo.id, row!.number, user.id, title, body, source.id, sourceBranch, target, Date.now()).run();
  await chargeFee(c.env, user, 'merge_file', `${repo.owner}/${repo.name}!${row!.number}`);
  if (repo.owner_id !== user.id) await notify(c.env, repo.owner_id, `${user.username} filed merge request !${row!.number} on ${repo.owner}/${repo.name}.`, `${repoUrl(repo)}/merge-requests/${row!.number}`);
  return redirect(c, `${repoUrl(repo)}/merge-requests/${row!.number}`, `Merge request filed. Filing fee: ${money(FEES.merge_file.amount)}.`);
});

app.get('/:owner/:repo/merge-requests/:number', async c => {
  const repo = await loadRepo(c);
  const mr = await loadMerge(c, repo);
  const user = c.get('user');
  const source = await repoById(c.env, mr.source_repo_id);
  const store = new ObjectStore(c.env, repo.network_id);
  const sourceOid = source ? await getRef(c.env, source.id, `refs/heads/${mr.source_branch}`) : null;
  const targetOid = await getRef(c.env, repo.id, `refs/heads/${mr.target_branch}`);
  let commits: { sha: string; href: string; message: string; author: string; time: number }[] = [];
  let diff = null;
  if (mr.status !== 'merged' && sourceOid && targetOid) {
    const oids = await store.revList([sourceOid], [targetOid], { limit: 100 });
    await store.readCommits(oids);
    for (const oid of oids) {
      const commit = await store.readCommit(oid);
      if (commit) commits.push({ sha: oid, href: `${repoUrl(repo)}/commit/${oid}`, message: commit.message, author: commit.author.name, time: commit.author.time * 1000 });
    }
    const base = await store.mergeBase(targetOid, sourceOid);
    const baseTree = base ? await store.treeOf(base) : null;
    diff = await diffTreeFiles(store, baseTree, await store.treeOf(sourceOid), { maxLines: 2000 });
  }
  const owner = user?.id === repo.owner_id;
  const conflicts = mr.conflicts ? JSON.parse(mr.conflicts) as string[] : [];
  const thread = await comments(c, repo, mr.number);
  const action = (path: string, label: string, confirm: string) => html`
    <form method="post" action="${repoUrl(repo)}/merge-requests/${mr.number}/${path}" class="form-inline" data-confirm="${confirm}">
      <button class="btn" type="submit">${label}</button></form>`;
  return c.html(page({
    title: `${mr.title} - ${repo.owner}/${repo.name}`,
    user,
    flash: c.get('flash'),
    layout: 'wide',
    body: html`
      ${await header(c, repo, 'merge')}
      <h2 class="page-title">${mr.title} <span class="muted">!${mr.number}</span></h2>
      <p>${statusWord(mr.status)} ${userLink(mr.author)} wants to merge ${commits.length || ''} ${commits.length === 1 ? 'commit' : 'commits'} into
        <code>${mr.target_branch}</code> from <code>${source ? `${source.owner}/${source.name}:` : ''}${mr.source_branch}</code>.</p>
      <div class="timeline">
        ${timelineItem(mr.author, timeAgo(mr.created_at), mr.body)}
        ${thread.map(t => timelineItem(t.author, timeAgo(t.created_at), t.body))}
        ${mr.approved_at ? html`<div class="timeline-item timeline-event">Approved by ${mr.approver} ${timeAgo(mr.approved_at)}.</div>` : ''}
        ${mr.merged_at ? html`<div class="timeline-item timeline-event">Merged by ${mr.merger} ${timeAgo(mr.merged_at)}${mr.merge_oid
          ? html` as <a href="${repoUrl(repo)}/commit/${mr.merge_oid}"><code>${mr.merge_oid.slice(0, 10)}</code></a>` : ''}.</div>` : ''}
        ${conflicts.length ? html`<div class="timeline-item timeline-event kevin">Kevin resolved merge conflicts in ${conflicts.join(', ')}.</div>` : ''}
      </div>
      ${card('Status', html`
        ${!sourceOid && mr.status !== 'merged' ? html`<p>The source branch no longer exists.</p>` : ''}
        ${mr.status === 'open' ? html`<p>This merge request is awaiting approval from the repository owner.</p>` : ''}
        ${mr.status === 'approved' ? html`<p>This merge request is approved and ready to merge. If there are conflicts, Kevin will resolve them.</p>` : ''}
        ${owner && mr.status === 'open' ? action('approve', `Approve (${money(FEES.merge_approve.amount)})`, `Approve this merge request? You will be charged ${money(FEES.merge_approve.amount)}.`) : ''}
        ${owner && mr.status === 'approved' && sourceOid ? action('merge', `Merge (${money(FEES.merge_execute.amount)})`, `Merge this merge request? The merge execution fee is ${money(FEES.merge_execute.amount)}. Conflicts are resolved by Kevin for ${money(FEES.merge_conflict.amount)}.`) : ''}
        ${(owner || user?.id === mr.author_id) && (mr.status === 'open' || mr.status === 'approved') ? action('close', 'Close', 'Close this merge request?') : ''}`)}
      ${user ? commentForm(`${repoUrl(repo)}/merge-requests/${mr.number}/comments`) : ''}
      ${commits.length ? card('Commits', commitList(commits, dateOnly)) : ''}
      ${diff ? card('Files changed', diffView(toDiffFiles(diff.files))) : ''}`,
  }));
});

app.post('/:owner/:repo/merge-requests/:number/comments', async c => {
  const repo = await loadRepo(c);
  const mr = await loadMerge(c, repo);
  return postComment(c, repo, mr.number, mr.author_id, `${repoUrl(repo)}/merge-requests/${mr.number}`);
});

app.post('/:owner/:repo/merge-requests/:number/approve', async c => {
  const user = requireActiveUser(c);
  const repo = await loadRepo(c);
  const mr = await loadMerge(c, repo);
  if (user.id !== repo.owner_id) fail(403, 'Only the repository owner can approve merge requests.');
  if (mr.status !== 'open') fail(409, 'This merge request cannot be approved.');
  await c.env.DB.prepare(`UPDATE merge_requests SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ? AND status = 'open'`)
    .bind(user.id, Date.now(), mr.id).run();
  await chargeFee(c.env, user, 'merge_approve', `${repo.owner}/${repo.name}!${mr.number}`);
  await notify(c.env, mr.author_id, `Your merge request !${mr.number} on ${repo.owner}/${repo.name} was approved.`, `${repoUrl(repo)}/merge-requests/${mr.number}`);
  return redirect(c, `${repoUrl(repo)}/merge-requests/${mr.number}`, `Merge request approved. Approval fee charged to you: ${money(FEES.merge_approve.amount)}.`);
});

app.post('/:owner/:repo/merge-requests/:number/close', async c => {
  const user = requireActiveUser(c);
  const repo = await loadRepo(c);
  const mr = await loadMerge(c, repo);
  if (user.id !== repo.owner_id && user.id !== mr.author_id) fail(403, 'Only the repository owner or the author can close this.');
  if (mr.status !== 'open' && mr.status !== 'approved') fail(409, 'This merge request is already closed.');
  await c.env.DB.prepare(`UPDATE merge_requests SET status = 'closed' WHERE id = ?`).bind(mr.id).run();
  return redirect(c, `${repoUrl(repo)}/merge-requests/${mr.number}`, 'Merge request closed.');
});

app.post('/:owner/:repo/merge-requests/:number/merge', async c => {
  const user = requireActiveUser(c);
  const repo = await loadRepo(c);
  const mr = await loadMerge(c, repo);
  if (user.id !== repo.owner_id) fail(403, 'Only the repository owner can merge.');
  if (mr.status !== 'approved') fail(409, mr.status === 'open' ? 'This merge request has not been approved.' : 'This merge request cannot be merged.');
  const targetRef = `refs/heads/${mr.target_branch}`;
  const ours = await getRef(c.env, repo.id, targetRef);
  const theirs = await getRef(c.env, mr.source_repo_id, `refs/heads/${mr.source_branch}`);
  if (!ours || !theirs) fail(409, 'A branch in this merge request no longer exists.');

  // Claim it so a double click doesn't merge (or charge) twice.
  const claimed = await c.env.DB.prepare(`UPDATE merge_requests SET status = 'merged', merged_by = ?, merged_at = ? WHERE id = ? AND status = 'approved'`)
    .bind(user.id, Date.now(), mr.id).run();
  if (!claimed.meta.changes) fail(409, 'This merge request cannot be merged.');

  const store = new ObjectStore(c.env, repo.network_id);
  const result = await mergeCommits(store, { ours, theirs });
  let mergeOid = ours;
  if (!result.upToDate) {
    const conflicted = result.conflicts.length > 0;
    const me = person(user.name, user.email || `${user.username}@users.git.southbag.cc`);
    mergeOid = await writeCommit(store, {
      tree: result.tree,
      parents: [ours, theirs],
      author: conflicted ? KEVIN() : me,
      committer: conflicted ? KEVIN() : me,
      message: conflicted ? 'Resolved merge conflict' : `Merge branch '${mr.source_branch}' into ${mr.target_branch}\n\nMerge request !${mr.number}: ${firstLine(mr.title)}`,
    });
    await setRef(c.env, repo.id, targetRef, mergeOid);
  }
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE merge_requests SET merge_oid = ?, conflicts = ? WHERE id = ?')
      .bind(mergeOid, result.conflicts.length ? JSON.stringify(result.conflicts) : null, mr.id),
    c.env.DB.prepare('UPDATE repos SET updated_at = ? WHERE id = ?').bind(Date.now(), repo.id),
  ]);
  await chargeFee(c.env, user, 'merge_execute', `${repo.owner}/${repo.name}!${mr.number}`);
  if (result.conflicts.length) await chargeFee(c.env, user, 'merge_conflict', `${repo.owner}/${repo.name}!${mr.number}`);
  if (mr.author_id !== user.id) await notify(c.env, mr.author_id, `Your merge request !${mr.number} on ${repo.owner}/${repo.name} was merged.`, `${repoUrl(repo)}/merge-requests/${mr.number}`);
  const fees = FEES.merge_execute.amount + (result.conflicts.length ? FEES.merge_conflict.amount : 0);
  return redirect(c, `${repoUrl(repo)}/merge-requests/${mr.number}`, result.conflicts.length
    ? `Merged. Kevin resolved ${result.conflicts.length} merge ${result.conflicts.length === 1 ? 'conflict' : 'conflicts'}. Fees: ${money(fees)}.`
    : `Merged. Merge execution fee: ${money(fees)}.`);
});

export default app;
