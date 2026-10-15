// GET /merge-requests — merge requests you filed, and open ones on repositories you own.

import { Hono } from 'hono';
import { html } from 'hono/html';
import type { AppEnv } from '../env';
import { requireUser } from '../lib/http';
import { card, emptyState, page, statusWord, userLink, when } from '../views/layout';

const app = new Hono<AppEnv>();

interface InboxRow {
  number: number;
  title: string;
  status: string;
  created_at: number;
  author: string;
  owner: string;
  repo: string;
  source_branch: string;
  target_branch: string;
}

const select = `SELECT merge_requests.number, merge_requests.title, merge_requests.status, merge_requests.created_at,
    merge_requests.source_branch, merge_requests.target_branch, a.username AS author, o.username AS owner, repos.name AS repo
  FROM merge_requests JOIN repos ON repos.id = merge_requests.repo_id JOIN users o ON o.id = repos.owner_id
  JOIN users a ON a.id = merge_requests.author_id`;

const table = (rows: InboxRow[], empty: string) => rows.length
  ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Merge request</th><th>Repository</th><th>Status</th><th>Author</th><th>Opened</th></tr></thead><tbody>
    ${rows.map(r => {
      const repoHref = `/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`;
      return html`<tr>
        <td><a href="${repoHref}/merge-requests/${r.number}">!${r.number} ${r.title}</a><br><span class="hint">${r.source_branch} into ${r.target_branch}</span></td>
        <td><a href="${repoHref}">${r.owner}/${r.repo}</a></td>
        <td>${statusWord(r.status)}</td>
        <td>${userLink(r.author)}</td>
        <td class="nowrap">${when(r.created_at)}</td>
      </tr>`;
    })}</tbody></table></div>`
  : emptyState(empty);

app.get('/merge-requests', async c => {
  const user = requireUser(c);
  const [mine, waiting] = await c.env.DB.batch([
    c.env.DB.prepare(`${select} WHERE merge_requests.author_id = ? ORDER BY merge_requests.created_at DESC LIMIT 50`).bind(user.id),
    c.env.DB.prepare(`${select} WHERE repos.owner_id = ? AND merge_requests.status IN ('open', 'approved') ORDER BY merge_requests.created_at DESC LIMIT 50`).bind(user.id),
  ]);
  return c.html(page({
    title: 'Merge requests',
    user,
    flash: c.get('flash'),
    path: c.req.path,
    unread: c.get('unread'),
    body: html`<h1 class="page-title">Merge requests</h1>
      ${card('On your repositories', table((waiting.results ?? []) as InboxRow[], 'No open merge requests on your repositories.'))}
      ${card('Filed by you', table((mine.results ?? []) as InboxRow[], 'No merge requests.'))}`,
  }));
});

export default app;
