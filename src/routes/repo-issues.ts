// /:owner/:repo/issues. Issue #1 is always The Issue: raised by Kevin, resolved in 2019, locked and
// immutable. Nothing about it can be changed, by anyone.

import { Hono } from 'hono';
import { html } from 'hono/html';
import type { AppEnv, Ctx, Repo } from '../env';
import { mentionsBannedTopic } from '../lib/banned';
import { FEES, chargeFee, money } from '../lib/fees';
import { fail, form, redirect, requireActiveUser, str } from '../lib/http';
import { newId } from '../lib/ids';
import { notify } from '../lib/notify';
import { repoUrl } from '../lib/repos';
import { card, emptyState, page, statusWord, timeAgo, userLink } from '../views/layout';
import { header, loadRepo } from './repo-shared';

const app = new Hono<AppEnv>();

interface IssueRow {
  id: string; number: number; author_id: string; author: string; title: string; body: string; state: string;
  locked: number; immutable: number; display_date: string | null; created_at: number; closed_at: number | null;
}

export interface CommentRow { id: string; author: string; body: string; created_at: number }

const issueSelect = `SELECT issues.*, users.username AS author FROM issues JOIN users ON users.id = issues.author_id`;

/** "2019" for The Issue, otherwise "3 hours ago". */
export const when = (row: { display_date?: string | null; created_at: number }) => row.display_date ?? timeAgo(row.created_at);

export const comments = async (c: Ctx, repo: Repo, number: number) =>
  (await c.env.DB.prepare(`SELECT comments.id, comments.body, comments.created_at, users.username AS author FROM comments
    JOIN users ON users.id = comments.author_id WHERE comments.repo_id = ? AND comments.number = ? ORDER BY comments.created_at LIMIT 500`)
    .bind(repo.id, number).all<CommentRow>()).results;

export const timelineItem = (author: string, when: string, body: string) => html`
  <div class="timeline-item">
    <div class="timeline-meta">${userLink(author)} <span class="muted">${when}</span></div>
    <div class="timeline-body ${author === 'Kevin' ? 'kevin' : ''}">${body ? html`<p class="prewrap">${body}</p>` : html`<p class="muted">No description provided.</p>`}</div>
  </div>`;

/** Posts a comment (with the comment fee) on an issue or merge request. */
export async function postComment(c: Ctx, repo: Repo, number: number, authorId: string, back: string) {
  const user = requireActiveUser(c);
  const body = str((await form(c)).body, 10000);
  if (!body) fail(400, 'Enter a comment.');
  if (mentionsBannedTopic(body)) fail(400, 'This comment refers to a topic that cannot be discussed.');
  await c.env.DB.prepare('INSERT INTO comments (id, repo_id, number, author_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(newId(), repo.id, number, user.id, body, Date.now()).run();
  await chargeFee(c.env, user, 'comment', `${repo.owner}/${repo.name}#${number}`);
  if (authorId !== user.id) await notify(c.env, authorId, `${user.username} commented on ${repo.owner}/${repo.name}#${number}.`, back);
  return redirect(c, back, `Comment posted. Comment fee: ${money(FEES.comment.amount)}.`);
}

export const commentForm = (action: string) => html`
  <form method="post" action="${action}" class="form comment-form">
    <label>Comment<textarea name="body" required maxlength="10000" rows="5"></textarea></label>
    <button class="btn" type="submit">Comment (${money(FEES.comment.amount)})</button>
  </form>`;

const IMMUTABLE = 'This issue is locked and cannot be changed.';

const loadIssue = async (c: Ctx, repo: Repo) => {
  const number = Number(c.req.param('number'));
  const issue = Number.isInteger(number)
    ? await c.env.DB.prepare(`${issueSelect} WHERE issues.repo_id = ? AND issues.number = ?`).bind(repo.id, number).first<IssueRow>() : null;
  if (!issue) {
    // Merge requests share the numbering.
    if (await c.env.DB.prepare('SELECT 1 FROM merge_requests WHERE repo_id = ? AND number = ?').bind(repo.id, number).first())
      return c.redirect(`${repoUrl(repo)}/merge-requests/${number}`) as never;
    fail(404, 'Issue not found.');
  }
  return issue;
};

app.get('/:owner/:repo/issues', async c => {
  const repo = await loadRepo(c);
  const state = c.req.query('state') === 'closed' ? 'closed' : 'open';
  const { results } = await c.env.DB.prepare(`${issueSelect} WHERE issues.repo_id = ? AND issues.state = ? ORDER BY issues.number DESC LIMIT 100`)
    .bind(repo.id, state).all<IssueRow>();
  return c.html(page({
    title: `Issues - ${repo.owner}/${repo.name}`,
    user: c.get('user'),
    flash: c.get('flash'),
    body: html`
      ${await header(c, repo, 'issues')}
      <p class="tabs-small"><a href="?state=open" class="${state === 'open' ? 'current' : ''}">Open</a>
        <a href="?state=closed" class="${state === 'closed' ? 'current' : ''}">Closed</a>
        ${c.get('user') ? html`<a class="btn btn-small" href="${repoUrl(repo)}/issues/new">New issue (${money(FEES.issue_file.amount)})</a>` : ''}</p>
      ${results.length ? html`<ul class="issue-list">${results.map(i => html`<li class="issue-list-item">
        <a href="${repoUrl(repo)}/issues/${i.number}">${i.title}</a>
        <span class="muted">#${i.number} ${i.state === 'closed' ? 'resolved' : 'opened'} ${when(i)} by ${i.author}</span>
        ${i.locked ? html`<span class="state-word">Locked</span>` : ''}</li>`)}</ul>`
        : emptyState(state === 'open' ? 'No open issues.' : 'No closed issues.')}`,
  }));
});

app.get('/:owner/:repo/issues/new', async c => {
  const user = requireActiveUser(c);
  const repo = await loadRepo(c);
  return c.html(page({
    title: `New issue - ${repo.owner}/${repo.name}`,
    user,
    flash: c.get('flash'),
    body: html`
      ${await header(c, repo, 'issues')}
      ${card('New issue', html`
        <form method="post" action="${repoUrl(repo)}/issues/new" class="form" data-confirm="Lodge this issue? The issue lodgement fee is ${money(FEES.issue_file.amount)}.">
          <label>Title<input name="title" required maxlength="200"></label>
          <label>Description<textarea name="body" maxlength="20000" rows="10"></textarea></label>
          <button class="btn" type="submit">Lodge issue (${money(FEES.issue_file.amount)})</button>
        </form>`)}`,
  }));
});

app.post('/:owner/:repo/issues/new', async c => {
  const user = requireActiveUser(c);
  const repo = await loadRepo(c);
  const f = await form(c);
  const title = str(f.title, 200);
  const body = str(f.body, 20000);
  if (!title) fail(400, 'Enter a title.');
  if (/^the issue$/i.test(title)) fail(409, 'An issue with that title already exists. It is considered resolved.');
  if (mentionsBannedTopic(`${title}\n${body}`)) fail(400, 'This issue refers to a topic that cannot be discussed.');
  const row = await c.env.DB.prepare('UPDATE repos SET next_number = next_number + 1 WHERE id = ? RETURNING next_number - 1 AS number')
    .bind(repo.id).first<{ number: number }>();
  await c.env.DB.prepare(`INSERT INTO issues (id, repo_id, number, author_id, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(newId(), repo.id, row!.number, user.id, title, body, Date.now()).run();
  await chargeFee(c.env, user, 'issue_file', `${repo.owner}/${repo.name}#${row!.number}`);
  if (repo.owner_id !== user.id) await notify(c.env, repo.owner_id, `${user.username} lodged issue #${row!.number} on ${repo.owner}/${repo.name}.`, `${repoUrl(repo)}/issues/${row!.number}`);
  return redirect(c, `${repoUrl(repo)}/issues/${row!.number}`, `Issue lodged. Issue lodgement fee: ${money(FEES.issue_file.amount)}.`);
});

app.get('/:owner/:repo/issues/:number', async c => {
  const repo = await loadRepo(c);
  const issue = await loadIssue(c, repo);
  const user = c.get('user');
  const thread = issue.immutable ? [] : await comments(c, repo, issue.number);
  const canClose = user && !issue.immutable && (user.id === repo.owner_id || user.id === issue.author_id);
  return c.html(page({
    title: `${issue.title} - ${repo.owner}/${repo.name}`,
    user,
    flash: c.get('flash'),
    body: html`
      ${await header(c, repo, 'issues')}
      <h2 class="page-title">${issue.title} <span class="muted">#${issue.number}</span></h2>
      <p>${statusWord(issue.state === 'closed' ? 'Resolved' : 'Open')} ${userLink(issue.author)} <span class="muted">${when(issue)}</span></p>
      <div class="timeline">
        ${timelineItem(issue.author, when(issue), issue.body)}
        ${thread.map(t => timelineItem(t.author, timeAgo(t.created_at), t.body))}
        ${issue.state === 'closed' ? html`<div class="timeline-item timeline-event">${issue.immutable ? 'Resolved 2019' : `Resolved ${timeAgo(issue.closed_at ?? issue.created_at)}`}</div>` : ''}
      </div>
      ${issue.locked ? html`<p class="locked-note">This conversation has been locked. Comments are disabled.</p>`
        : user ? commentForm(`${repoUrl(repo)}/issues/${issue.number}/comments`) : ''}
      ${canClose ? html`<form method="post" action="${repoUrl(repo)}/issues/${issue.number}/${issue.state === 'open' ? 'close' : 'reopen'}" class="form-inline">
        <button class="btn" type="submit">${issue.state === 'open' ? 'Mark resolved' : 'Reopen'}</button></form>` : ''}
      ${user && !issue.immutable ? html`<button class="btn btn-small" type="button" data-refuse-delete>Delete issue</button>` : ''}`,
  }));
});

app.post('/:owner/:repo/issues/:number/comments', async c => {
  const repo = await loadRepo(c);
  const issue = await loadIssue(c, repo);
  if (issue.locked || issue.immutable) fail(423, IMMUTABLE);
  return postComment(c, repo, issue.number, issue.author_id, `${repoUrl(repo)}/issues/${issue.number}`);
});

for (const verb of ['close', 'reopen'] as const) {
  app.post(`/:owner/:repo/issues/:number/${verb}`, async c => {
    const user = requireActiveUser(c);
    const repo = await loadRepo(c);
    const issue = await loadIssue(c, repo);
    if (issue.immutable) fail(423, IMMUTABLE);
    if (user.id !== repo.owner_id && user.id !== issue.author_id) fail(403, 'Only the repository owner or the author can do that.');
    await c.env.DB.prepare('UPDATE issues SET state = ?, closed_at = ? WHERE id = ?')
      .bind(verb === 'close' ? 'closed' : 'open', verb === 'close' ? Date.now() : null, issue.id).run();
    return redirect(c, `${repoUrl(repo)}/issues/${issue.number}`, verb === 'close' ? 'Issue marked resolved.' : 'Issue reopened.');
  });
}

// Anything else aimed at an issue (edit, lock, delete…) is refused, and The Issue refuses everything.
app.post('/:owner/:repo/issues/:number/*', async c => {
  const repo = await loadRepo(c);
  const issue = await loadIssue(c, repo);
  fail(issue.immutable ? 423 : 403, issue.immutable ? IMMUTABLE : "Deletion isn't available. Kevin knows what you did.");
});

export default app;
