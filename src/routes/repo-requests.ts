// /:owner/:repo/requests — pull, push, fork, star and unstar requests on one repository, and the
// buttons (Star, Fork, Watch, Download ZIP) that refuse to work without one.

import { Hono } from 'hono';
import { html } from 'hono/html';
import type { AppEnv } from '../env';
import { FEES, chargeFee, feeFor, money } from '../lib/fees';
import { fail, form, redirect, requireActiveUser, str } from '../lib/http';
import {
  KIND_LABEL, KINDS, decideRequest, executeRequest, getRequest, requestSelect, withdrawRequest,
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
  pull: 'Your first clone of a repository needs no request (the clone fee applies). After that, a pull request lets you run git pull or git fetch on this repository once, even if there is nothing new. Approved pull requests must be used within 24 hours.',
  push: 'A push request lets you run git push to this repository once. Approved push requests must be used within 24 hours. Pushes are processed during business hours.',
  fork: 'A fork request lets you fork this repository. Once approved, execute the request to create the fork.',
  star: 'A star request lets you star this repository. Once approved, execute the request to apply the star.',
  unstar: 'An unstar request lets you remove your star from this repository. Once approved, execute the request to remove the star.',
};

const feeLine = (kind: SimpleKind) =>
  `Filing fee ${money(feeFor(kind, 'file').amount)}. Approval fee ${money(feeFor(kind, 'approve').amount)} (charged to the approver). Execution fee ${money(feeFor(kind, 'execute').amount)}.`;

const requestUrl = (repo: { owner: string; name: string }, r: Pick<RequestRow, 'kind' | 'id'>) => `${repoUrl(repo)}/requests/${r.kind}/${r.id}`;

// One tab per request type, listing that type's requests on the repository. Requests are filed
// from /requests (src/routes/account.ts), not here.
app.get('/:owner/:repo/requests', async c => c.redirect(`${repoUrl(await loadRepo(c))}/requests/pull`));

app.get('/:owner/:repo/requests/:kind', async c => {
  const repo = await loadRepo(c);
  const kind = kindParam(c.req.param('kind'));
  const status = c.req.query('status') === 'closed' ? 'closed' : 'open';
  const { results } = await c.env.DB.prepare(`${requestSelect} WHERE requests.repo_id = ? AND requests.kind = ?
    AND requests.status ${status === 'open' ? "IN ('open', 'approved')" : "NOT IN ('open', 'approved')"} ORDER BY requests.created_at DESC LIMIT 100`)
    .bind(repo.id, kind).all<RequestRow>();
  return c.html(page({
    path: c.req.path,
    unread: c.get('unread'),
    title: `${KIND_LABEL[kind]}s - ${repo.owner}/${repo.name}`,
    layout: 'wide',
    user: c.get('user'),
    flash: c.get('flash'),
    body: html`
      ${await header(c, repo, kind)}
      <h2 class="page-title">${KIND_LABEL[kind]}s</h2>
      <p>${EXPLAIN[kind]} ${feeLine(kind)}</p>
      ${kind === 'push' ? html`<p>Business hours: 9:00 to 17:00 AEST, Monday to Friday. ${isBusinessHours(Date.now()) ? 'Currently open.'
        : `Currently closed. Next opening: ${aestText(nextOpening(Date.now()))}.`}</p>` : ''}
      <p>Requests are filed from the Requests page.</p>
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

// The ordinary forge buttons. Without an approved request each of these is an unrequested action:
// it is charged and refused.
const UNREQUESTED: Record<string, string> = {
  star: 'Starring this repository requires an approved star request.',
  unstar: 'Removing your star requires an approved unstar request.',
  fork: 'Forking this repository requires an approved fork request.',
  watch: 'Watching is not available for this repository. Kevin is already watching it.',
  archive: 'Downloading an archive of this repository requires an approved pull request, executed with git.',
};

for (const action of Object.keys(UNREQUESTED)) {
  app.post(`/:owner/:repo/${action}`, async c => {
    const user = requireActiveUser(c);
    const repo = await loadRepo(c);
    await chargeFee(c.env, user, 'unrequested_action', `${action} ${repo.owner}/${repo.name}`);
    fail(403, `${UNREQUESTED[action]}${action === 'watch' ? '' : ' Requests are filed from the Requests page.'} ${FEES.unrequested_action.label}: ${money(FEES.unrequested_action.amount)}.`);
  });
}

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
    path: c.req.path,
    unread: c.get('unread'),
    title: `${KIND_LABEL[kind]} - ${repo.owner}/${repo.name}`,
    layout: 'wide',
    user,
    flash: c.get('flash'),
    body: html`
      ${await header(c, repo, request.kind)}
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
