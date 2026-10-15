// Fraud detection. Deliberately sensitive: one finding freezes the account until the owner answers
// three security questions in a row (src/lib/security.ts).

import type { Env, Repo, User } from '../env';
import { aestClock } from './hours';
import { newId } from './ids';
import { notifyStatement } from './notify';
import type { PushAnalysis } from './policy';
import { pickQuestion } from './security';

export interface Finding {
  rule: string;
  detail: string;
}

const short = (oid: string) => oid.slice(0, 7);

/** Rules for a push. Returns every finding (empty = clean). */
export async function inspectPush(env: Env, user: User, repo: Repo, analyses: PushAnalysis[], now = Date.now()): Promise<Finding[]> {
  const findings: Finding[] = [];
  let total = 0;
  for (const a of analyses) {
    const branch = a.update.ref.replace(/^refs\/heads\//, '');
    if (a.forced) findings.push({ rule: 'Force push', detail: `History on ${branch} was rewritten.` });
    if (a.deleted) findings.push({ rule: 'Branch deletion', detail: `${branch} was deleted.` });
    if (a.linesDeleted >= 150 || a.filesDeleted >= 5 || (a.linesDeleted > 40 && a.linesDeleted > a.linesAdded * 3))
      findings.push({ rule: 'Large deletion', detail: `${a.linesDeleted} lines and ${a.filesDeleted} files removed from ${branch}.` });
    total += a.commits.length;
    for (const commit of a.commits) {
      for (const who of [commit.author, commit.committer]) {
        const { hour, minute, day } = aestClock(who.time);
        if (hour < 6) findings.push({ rule: 'Unusual hour', detail: `Commit ${short(commit.oid)} was made at ${hour}:${String(minute).padStart(2, '0')} AEST.` });
        else if (day === 0 || day === 6) findings.push({ rule: 'Weekend activity', detail: `Commit ${short(commit.oid)} was made on a weekend.` });
        else if (hour === 13 && minute === 37) findings.push({ rule: 'Unusual hour', detail: `Commit ${short(commit.oid)} was made at 13:37 AEST.` });
        if (who.time * 1000 > now + 5 * 60000) findings.push({ rule: 'Timestamp irregularity', detail: `Commit ${short(commit.oid)} is dated in the future.` });
        if (who.time * 1000 < Date.UTC(2005, 3, 7)) findings.push({ rule: 'Timestamp irregularity', detail: `Commit ${short(commit.oid)} predates git.` });
        if (/kevin/i.test(who.email) || /^kevin$/i.test(who.name.trim()))
          findings.push({ rule: 'Executive impersonation', detail: `Commit ${short(commit.oid)} claims to be from ${who.name}.` });
      }
      if (/^(\.|wip|asdf|x|test|fix|update|changes|stuff|idk|lol)\.?$/i.test(commit.message.trim()))
        findings.push({ rule: 'Insufficient documentation', detail: `Commit ${short(commit.oid)} has the message "${commit.message.trim()}".` });
    }
  }
  if (total > 60) findings.push({ rule: 'Unusual volume', detail: `${total} commits in one push.` });

  const recent = await env.DB.prepare('SELECT created_at FROM pushes WHERE user_id = ? ORDER BY created_at DESC LIMIT 1')
    .bind(user.id).first<{ created_at: number }>();
  if (recent && now - recent.created_at < 90000) findings.push({ rule: 'Rapid activity', detail: 'Two pushes within 90 seconds.' });

  // One of each rule is enough.
  const seen = new Set<string>();
  return findings.filter(f => !seen.has(f.rule) && seen.add(f.rule));
}

/** Freezes the account, records the findings and asks the first security question. */
export async function freeze(env: Env, user: User, repo: Repo | null, findings: Finding[]): Promise<void> {
  const now = Date.now();
  const reason = findings.map(f => f.rule).join(', ');
  await env.DB.batch([
    env.DB.prepare(`UPDATE users SET frozen = 1, frozen_reason = ?, frozen_at = ?, security_question = ?, security_streak = 0 WHERE id = ?`)
      .bind(reason, now, pickQuestion(null), user.id),
    ...findings.map(f => env.DB.prepare('INSERT INTO fraud_events (id, user_id, repo_id, rule, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(newId(now), user.id, repo?.id ?? null, f.rule, f.detail, now)),
    notifyStatement(env, user.id, `Your account has been frozen by fraud detection (${reason}).`, '/security'),
  ]);
  user.frozen = 1;
  user.frozen_reason = reason;
}

/**
 * Website activity that fraud detection watches: filing and executing star and unstar requests.
 * Starring and unstarring the same repository within ten minutes freezes the account.
 */
export async function recordWebActivity(env: Env, user: User, repo: Repo, action: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare('INSERT INTO fraud_events (id, user_id, repo_id, rule, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(newId(now), user.id, repo.id, 'activity', action, now).run();
  const opposite = action.startsWith('un') ? action.slice(2) : 'un' + action;
  const flip = await env.DB.prepare(`SELECT 1 FROM fraud_events WHERE user_id = ? AND repo_id = ? AND rule = 'activity' AND detail = ? AND created_at > ?`)
    .bind(user.id, repo.id, opposite, now - 600000).first();
  if (flip) await freeze(env, user, repo, [{ rule: 'Star manipulation', detail: `Starred and unstarred ${repo.owner}/${repo.name} within ten minutes.` }]);
}
