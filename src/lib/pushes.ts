// What happens to a git push after the objects arrive.
//
// 1. The account must not be frozen, and the user must hold an approved push request (used up here).
// 2. Commit messages mentioning a topic that cannot be discussed get the push refused.
// 3. Fraud detection looks at everything; one finding freezes the account and refuses the push.
// 4. Otherwise the push is accepted as *pending*. Refs don't move until it's processed: a few
//    minutes later in AEST business hours, or on the next business day (with the after-hours fee).

import type { Env, Repo, User } from '../env';
import { setRef } from '../git/refs';
import { BANNED_MESSAGE, mentionsBannedTopic } from './banned';
import { FEES, chargeFee, money } from './fees';
import { freeze, inspectPush } from './fraud';
import { aestText, processingTime } from './hours';
import { newId } from './ids';
import { notify } from './notify';
import type { PushAnalysis, RefUpdate, Waiter } from './policy';
import { consumeApproved } from './requests';
import { repoById, repoUrl } from './repos';

const ZERO = '0000000000000000000000000000000000000000';

export async function reviewPush(env: Env, _ctx: Waiter, user: User, repo: Repo, analyses: PushAnalysis[]):
  Promise<{ results: Record<string, string | null>; messages: string[] }> {
  const results: Record<string, string | null> = {};
  const refuseAll = (reason: string) => {
    for (const a of analyses) results[a.update.ref] = reason;
  };
  const messages: string[] = [];

  if (user.frozen) {
    refuseAll('account frozen pending review');
    messages.push('Your account is frozen. Answer the security questions at https://git.southbag.cc/security');
    return { results, messages };
  }
  const requestId = await consumeApproved(env, user, repo, 'push');
  if (!requestId) {
    refuseAll('no approved push request');
    messages.push(`File a push request at https://git.southbag.cc${repoUrl(repo)}/requests/push and wait for approval.`);
    return { results, messages };
  }
  // The request is used either way, and executing it is charged either way.
  await chargeFee(env, user, 'push_execute', `${repo.owner}/${repo.name}`);
  messages.push(`Push request used. ${FEES.push_execute.label}: ${money(FEES.push_execute.amount)}.`);

  const banned = analyses.flatMap(a => a.commits.filter(c => mentionsBannedTopic(c.message)).map(c => ({ a, c })));
  if (banned.length) {
    for (const { a, c } of banned) results[a.update.ref] = `commit ${c.oid.slice(0, 7)} ${BANNED_MESSAGE}`;
    for (const a of analyses) results[a.update.ref] ??= 'push refused';
    await chargeFee(env, user, 'push_rejected', `${repo.owner}/${repo.name}`);
    messages.push('Push refused. One or more commit messages refer to a topic that cannot be discussed.');
    messages.push(`${FEES.push_rejected.label}: ${money(FEES.push_rejected.amount)}.`);
    await recordPush(env, user, repo, requestId, analyses, 'rejected', 'Commit message refers to a topic that cannot be discussed.');
    return { results, messages };
  }

  const findings = await inspectPush(env, user, repo, analyses);
  if (findings.length) {
    await freeze(env, user, repo, findings);
    refuseAll('refused by fraud detection');
    messages.push('Fraud detection has flagged this push. Your account has been frozen.');
    for (const f of findings) messages.push(`  ${f.rule}: ${f.detail}`);
    messages.push('Answer the security questions at https://git.southbag.cc/security to continue.');
    await recordPush(env, user, repo, requestId, analyses, 'rejected', 'Refused by fraud detection.');
    return { results, messages };
  }

  const { dueAt, afterHours } = processingTime(Date.now());
  await recordPush(env, user, repo, requestId, analyses, 'pending', null, dueAt, afterHours);
  if (afterHours) {
    await chargeFee(env, user, 'push_after_hours', `${repo.owner}/${repo.name}`);
    messages.push('This push was received outside business hours (9:00 to 17:00 AEST, Monday to Friday).');
    messages.push(`${FEES.push_after_hours.label}: ${money(FEES.push_after_hours.amount)}.`);
  }
  messages.push('Push received. Status: pending.');
  messages.push(`Expected processing: ${aestText(dueAt)}.`);
  messages.push('Your commits will appear on the repository once processed.');
  for (const a of analyses) results[a.update.ref] = null;
  return { results, messages };
}

async function recordPush(env: Env, user: User, repo: Repo, requestId: string, analyses: PushAnalysis[],
  status: 'pending' | 'rejected', reason: string | null, dueAt = Date.now(), afterHours = false) {
  const updates: RefUpdate[] = analyses.map(a => a.update);
  const commits = analyses.reduce((n, a) => n + a.commits.length, 0);
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO pushes (id, repo_id, user_id, request_id, status, updates, commits, after_hours, reason, due_at, created_at, processed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(newId(now), repo.id, user.id, requestId, status, JSON.stringify(updates), commits, afterHours ? 1 : 0, reason, dueAt, now,
      status === 'rejected' ? now : null).run();
}

/** Applies pushes whose time has come. Each ref moves only if it hasn't changed since the push. */
export async function processDuePushes(env: Env, now = Date.now()): Promise<number> {
  const { results } = await env.DB.prepare(`SELECT * FROM pushes WHERE status = 'pending' AND due_at <= ? ORDER BY due_at LIMIT 10`)
    .bind(now).all<{ id: string; repo_id: string; user_id: string; updates: string }>();
  for (const push of results) {
    const claimed = await env.DB.prepare(`UPDATE pushes SET status = 'processing' WHERE id = ? AND status = 'pending'`).bind(push.id).run();
    if (!claimed.meta.changes) continue;
    const repo = await repoById(env, push.repo_id);
    const updates = JSON.parse(push.updates) as RefUpdate[];
    const stale: string[] = [];
    for (const update of updates) {
      const current = await env.DB.prepare('SELECT oid FROM refs WHERE repo_id = ? AND name = ?').bind(push.repo_id, update.ref).first<{ oid: string }>();
      if ((current?.oid ?? ZERO) !== update.old) { stale.push(update.ref); continue; }
      await setRef(env, push.repo_id, update.ref, update.new === ZERO ? null : update.new);
    }
    const status = stale.length === updates.length ? 'rejected' : 'processed';
    await env.DB.batch([
      env.DB.prepare('UPDATE pushes SET status = ?, reason = ?, processed_at = ? WHERE id = ?')
        .bind(status, stale.length ? `Changed while pending: ${stale.map(r => r.replace('refs/heads/', '')).join(', ')}.` : null, now, push.id),
      env.DB.prepare('UPDATE repos SET updated_at = ? WHERE id = ?').bind(now, push.repo_id),
    ]);
    if (repo) await notify(env, push.user_id,
      status === 'processed' ? `Your push to ${repo.owner}/${repo.name} has been processed.`
        : `Your push to ${repo.owner}/${repo.name} could not be processed. The branch changed while it was pending.`,
      `${repoUrl(repo)}/pushes`);
  }
  return results.length;
}
