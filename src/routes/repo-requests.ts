// /:owner/:repo/requests/:kind — pull, push, fork, star and unstar requests.

import { Hono } from 'hono';
import { html } from 'hono/html';
import type { AppEnv } from '../env';
import { FEES, feeFor, money } from '../lib/fees';
import { fail, form, redirect, requireActiveUser, str } from '../lib/http';
import {
  KIND_LABEL, KINDS, decideRequest, executeRequest, fileRequest, getRequest, requestSelect, withdrawRequest,
  type RequestRow, type SimpleKind,
} from '../lib/requests';
import { repoUrl } from '../lib/repos';
import { mentionsBannedTopic } from '../lib/banned';
import { aestText, isBusinessHours, nextOpening } from '../lib/hours';
import { card, dateTime, emptyState, page, statusWord, timeAgo, userLink } from '../views/layout';
import { header, loadRepo } from './repo-shared';

const app = new Hono<AppEnv>();

const kindParam = (value: string | undefined): SimpleKind => {
  if (!KINDS.includes(value as SimpleKind)) fail(404, 'Page not found.');
  return value as SimpleKind;
};

const EXPLAIN: Record<SimpleKind, string> = {
  pull: 'Cloning is free of requests (the clone fee applies). A pull request lets you run git pull or git fetch on this repository once. Approved pull requests must be used within 24 hours.',
  push: 'A push request lets you run git push to this repository once. Approved push requests must be used within 24 hours. Pushes are processed during business hours.',
  fork: 'A fork request lets you fork this repository. Once approved, execute the request to create the fork.',
  star: 'A star request lets you star this repository. Once approved, execute the request to apply the star.',
  unstar: 'An unstar request lets you remove your star from this repository. Once approved, execute the request to remove the star.',
};

const feeLine = (kind: SimpleKind) =>
  `Filing fee ${money(feeFor(kind, 'file').amount)}. Approval fee ${money(feeFor(kind, 'approve').amount)} (charged to the approver). Execution fee ${money(feeFor(kind, 'execute').amount)}.`;

const requestUrl = (repo: { owner: string; name: string }, r: Pick<RequestRow, 'kind' | 'id'>) => `${repoUrl(repo)}/requests/${r.kind}/${r.id}`;

app.get('/:owner/:repo/requests/:kind', async c => {
  const repo = await loadRepo(c);
  const tabKind = kindParam(c.req.param('kind'));
  const kinds: SimpleKind[] = tabKind === 'star' || tabKind === 'unstar' ? ['star', 'unstar'] : [tabKind];
  const status = c.req.query('status') === 'closed' ? 'closed' : 'open';
  const { results } = await c.env.DB.prepare(`${requestSelect} WHERE requests.repo_id = ? AND requests.kind IN (${kinds.map(() => '?').join(', ')})
    AND requests.status ${status === 'open' ? "IN ('open', 'approved')" : "NOT IN ('open', 'approved')"} ORDER BY requests.created_at DESC LIMIT 100`)
    .bind(repo.id, ...kinds).all<RequestRow>();
  const user = c.get('user');
  const label = tabKind === 'unstar' ? 'Star requests' : KIND_LABEL[tabKind] + 's';
  return c.html(page({
    title: `${label} - ${repo.owner}/${repo.name}`,
    layout: 'wide',
    user,
    flash: c.get('flash'),
    body: html`
      ${await header(c, repo, tabKind === 'unstar' ? 'star' : tabKind)}
      <h2 class="page-title">${label}</h2>
      ${kinds.map(k => html`<p>${EXPLAIN[k]} ${feeLine(k)}</p>`)}
      ${tabKind === 'push' ? html`<p>Business hours: 9:00 to 17:00 AEST, Monday to Friday. ${isBusinessHours(Date.now()) ? 'Currently open.'
        : `Currently closed. Next opening: ${aestText(nextOpening(Date.now()))}.`}</p>` : ''}
      ${user ? card(`File a ${(tabKind === 'unstar' ? 'star' : tabKind)} request`, html`${kinds.map(k => html`
        <form method="post" action="${repoUrl(repo)}/requests/${k}" class="form"
          data-confirm="File a ${KIND_LABEL[k].toLowerCase()}? The filing fee is ${money(feeFor(k, 'file').amount)}.">
          <label>Reason for request<textarea name="reason" required minlength="20" maxlength="1000" rows="3"></textarea></label>
          <p class="hint">At least 20 characters. Requests without a sufficient reason may be declined.</p>
          <button class="btn" type="submit">File ${KIND_LABEL[k].toLowerCase()} (${money(feeFor(k, 'file').amount)})</button>
        </form>`)}`) : ''}
      <p class="tabs-small"><a href="?status=open" class="${status === 'open' ? 'current' : ''}">Open</a>
        <a href="?status=closed" class="${status === 'closed' ? 'current' : ''}">Closed</a></p>
      ${results.length ? html`<table class="table request-table">
        <thead><tr><th>Request</th><th>Filed by</th><th>Filed</th><th>Status</th></tr></thead>
        <tbody>${results.map(r => html`<tr>
          <td><a href="${requestUrl(repo, r)}">${KIND_LABEL[r.kind]} ${r.id.slice(-6).toUpperCase()}</a></td>
          <td>${userLink(r.requester)}</td><td>${timeAgo(r.created_at)}</td><td>${statusWord(r.status)}</td></tr>`)}</tbody>
      </table>` : emptyState('No requests.')}`,
  }));
});

app.post('/:owner/:repo/requests/:kind', async c => {
  const user = requireActiveUser(c);
  const repo = await loadRepo(c);
  const kind = kindParam(c.req.param('kind'));
  const reason = str((await form(c)).reason, 1000);
  if (reason.length < 20) fail(400, 'Give a reason of at least 20 characters.');
  if (mentionsBannedTopic(reason)) fail(400, 'Your reason refers to a topic that cannot be discussed.');
  const request = await fileRequest(c.env, user, repo, kind, reason);
  return redirect(c, requestUrl(repo, request),
    `${KIND_LABEL[kind]} filed. Filing fee: ${money(feeFor(kind, 'file').amount)}. The repository owner has been notified.`);
});

app.get('/:owner/:repo/requests/:kind/:id', async c => {
  const repo = await loadRepo(c);
  const request = await getRequest(c.env, c.req.param('id'));
  if (!request || request.repo_id !== repo.id) fail(404, 'Request not found.');
  const user = c.get('user');
  const owner = user?.id === repo.owner_id;
  const mine = user?.id === request.requester_id;
  const kind = request.kind;
  const forkRepo = request.result ? await c.env.DB.prepare(`SELECT users.username AS owner, repos.name FROM repos JOIN users ON users.id = repos.owner_id WHERE repos.id = ?`)
    .bind(request.result).first<{ owner: string; name: string }>() : null;
  const action = (path: string, label: string, confirm: string) => html`
    <form method="post" action="${requestUrl(repo, request)}/${path}" class="form-inline" data-confirm="${confirm}">
      <button class="btn" type="submit">${label}</button></form>`;
  return c.html(page({
    title: `${KIND_LABEL[kind]} - ${repo.owner}/${repo.name}`,
    layout: 'wide',
    user,
    flash: c.get('flash'),
    body: html`
      ${await header(c, repo, kind === 'unstar' ? 'star' : kind)}
      <h2 class="page-title">${KIND_LABEL[kind]} ${request.id.slice(-6).toUpperCase()}</h2>
      ${card('Details', html`<table class="table">
        <tr><th>Status</th><td>${statusWord(request.status)}</td></tr>
        <tr><th>Filed by</th><td>${userLink(request.requester)}</td></tr>
        <tr><th>Filed</th><td>${dateTime(request.created_at)}</td></tr>
        <tr><th>Reason</th><td>${request.reason}</td></tr>
        ${request.decided_at ? html`<tr><th>${request.status === 'declined' ? 'Declined' : 'Approved'} by</th>
          <td>${userLink(request.decider ?? '')} ${dateTime(request.decided_at)}</td></tr>` : ''}
        ${request.status === 'approved' && request.expires_at ? html`<tr><th>Valid until</th><td>${dateTime(request.expires_at)}</td></tr>` : ''}
        ${request.executed_at ? html`<tr><th>Executed</th><td>${dateTime(request.executed_at)}</td></tr>` : ''}
        ${forkRepo ? html`<tr><th>Fork</th><td><a href="/${forkRepo.owner}/${forkRepo.name}">${forkRepo.owner}/${forkRepo.name}</a></td></tr>` : ''}
      </table>`)}
      ${card('Actions', html`
        ${owner && request.status === 'open' ? html`
          <p>Approving this request charges you the approval fee of ${money(feeFor(kind, 'approve').amount)}.
            Declining charges the requester the declined request processing fee of ${money(FEES.request_decline.amount)}.</p>
          ${action('approve', `Approve (${money(feeFor(kind, 'approve').amount)})`, `Approve this request? You will be charged ${money(feeFor(kind, 'approve').amount)}.`)}
          ${action('decline', 'Decline', 'Decline this request?')}` : ''}
        ${mine && request.status === 'approved' && (kind === 'fork' || kind === 'star' || kind === 'unstar')
          ? action('execute', `Execute (${money(feeFor(kind, 'execute').amount)})`, `Execute this request? The execution fee is ${money(feeFor(kind, 'execute').amount)}.`) : ''}
        ${mine && request.status === 'approved' && (kind === 'pull' || kind === 'push')
          ? html`<p>This request is executed by running <code>git ${kind}</code>. The execution fee of ${money(feeFor(kind, 'execute').amount)} is charged then.</p>` : ''}
        ${mine && (request.status === 'open' || request.status === 'approved')
          ? action('withdraw', `Withdraw (${money(FEES.request_withdraw.amount)})`, `Withdraw this request? The request withdrawal fee is ${money(FEES.request_withdraw.amount)}.`) : ''}
        ${!owner && !mine ? html`<p class="muted">No actions available.</p>` : ''}
        <button class="btn btn-small" type="button" data-refuse-delete>Delete request</button>`)}`,
  }));
});

for (const verb of ['approve', 'decline', 'withdraw', 'execute'] as const) {
  app.post(`/:owner/:repo/requests/:kind/:id/${verb}`, async c => {
    const user = requireActiveUser(c);
    const repo = await loadRepo(c);
    const request = await getRequest(c.env, c.req.param('id'));
    if (!request || request.repo_id !== repo.id) fail(404, 'Request not found.');
    const back = requestUrl(repo, request);
    if (verb === 'approve' || verb === 'decline') return redirect(c, back, await decideRequest(c.env, user, repo, request, verb));
    if (verb === 'withdraw') return redirect(c, back, await withdrawRequest(c.env, user, request) + ` Request withdrawal fee: ${money(FEES.request_withdraw.amount)}.`);
    const result = await executeRequest(c.env, user, repo, request);
    return redirect(c, result.to, result.message);
  });
}

export default app;
