// Fee waivers for open source projects. Applications cost a fee, are assessed within a few minutes,
// and are declined (with an assessment fee).

import type { Env, User } from '../env';
import { chargeFee } from './fees';
import { newId } from './ids';
import { notify } from './notify';

export const LICENCES = ['MIT', 'Apache-2.0', 'GPL-3.0-only', 'BSD-3-Clause', 'MPL-2.0', 'Unlicense', 'Other'];

const DECISIONS = [
  'The project does not meet the definition of open source used by Southbag.',
  'The selected licence is not on the list of licences recognised by Southbag.',
  'The application did not demonstrate financial hardship.',
  'The project has fewer than 10,000 stars.',
  'Waivers are not available for projects hosted on Southbag Git.',
  'The application was assessed outside the eligibility period.',
  'The project name is too similar to an existing project.',
  'Supporting documents were not provided.',
  'The applicant has an outstanding balance.',
  'Kevin has reviewed the application.',
];

export async function applyForWaiver(env: Env, user: User, input: { project: string; licence: string; reason: string }) {
  const now = Date.now();
  const decideAt = now + (2 + Math.random() * 4) * 60000;
  await env.DB.prepare(`INSERT INTO waivers (id, user_id, project, licence, reason, status, decide_at, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`).bind(newId(now), user.id, input.project, input.licence, input.reason, decideAt, now).run();
  await chargeFee(env, user, 'waiver_apply', input.project);
}

export async function decideDueWaivers(env: Env, now = Date.now()): Promise<number> {
  const { results } = await env.DB.prepare(`SELECT waivers.*, users.email, users.name FROM waivers JOIN users ON users.id = waivers.user_id
    WHERE status = 'pending' AND decide_at <= ? LIMIT 20`).bind(now).all<{ id: string; user_id: string; project: string; email: string | null; name: string }>();
  for (const waiver of results) {
    const decision = DECISIONS[Math.floor(Math.random() * DECISIONS.length)];
    const claimed = await env.DB.prepare(`UPDATE waivers SET status = 'declined', decision = ?, decided_at = ? WHERE id = ? AND status = 'pending'`)
      .bind(decision, now, waiver.id).run();
    if (!claimed.meta.changes) continue;
    await chargeFee(env, { id: waiver.user_id, email: waiver.email, name: waiver.name }, 'waiver_decline', waiver.project);
    await notify(env, waiver.user_id, `Your fee waiver application for ${waiver.project} was declined.`, '/waivers');
  }
  return results.length;
}
