// Every fee Southbag Git charges, and the one function that charges them.
// Money is taken from Southbag Online Banking (src/lib/banking.ts) and recorded in `charges`.
// A fee that the bank can't take is still recorded (status 'failed') and doesn't stop the action:
// Banking lets balances go negative, so this only happens when the bank is unreachable.

import type { Env, User } from '../env';
import { charge, money } from './banking';
import { newId } from './ids';

export { money };

export const FEES = {
  // Cloning needs no request. Fetching and pulling afterwards do.
  clone: { amount: 150, label: 'Clone fee' },
  // Pull requests (permission to run git pull / fetch once).
  pull_file: { amount: 250, label: 'Pull request filing fee' },
  pull_approve: { amount: 175, label: 'Pull request approval fee' },
  pull_execute: { amount: 420, label: 'Pull execution fee' },
  // Push requests (permission to run git push once).
  push_file: { amount: 250, label: 'Push request filing fee' },
  push_approve: { amount: 175, label: 'Push request approval fee' },
  push_execute: { amount: 420, label: 'Push execution fee' },
  push_after_hours: { amount: 1995, label: 'After-hours push processing fee' },
  push_rejected: { amount: 300, label: 'Rejected push handling fee' },
  // Merge requests.
  merge_file: { amount: 500, label: 'Merge request filing fee' },
  merge_approve: { amount: 350, label: 'Merge request approval fee' },
  merge_execute: { amount: 750, label: 'Merge execution fee' },
  merge_conflict: { amount: 2500, label: 'Merge conflict resolution fee' },
  // Forks.
  fork_file: { amount: 300, label: 'Fork request filing fee' },
  fork_approve: { amount: 200, label: 'Fork request approval fee' },
  fork_execute: { amount: 999, label: 'Fork execution fee' },
  // Stars.
  star_file: { amount: 99, label: 'Star request filing fee' },
  star_approve: { amount: 49, label: 'Star request approval fee' },
  star_execute: { amount: 25, label: 'Star execution fee' },
  unstar_file: { amount: 199, label: 'Unstar request filing fee' },
  unstar_approve: { amount: 49, label: 'Unstar request approval fee' },
  unstar_execute: { amount: 250, label: 'Star removal fee' },
  // Everything else.
  unrequested_action: { amount: 150, label: 'Unrequested action fee' },
  request_decline: { amount: 150, label: 'Declined request processing fee' },
  request_withdraw: { amount: 100, label: 'Request withdrawal fee' },
  repo_create: { amount: 1000, label: 'Repository establishment fee' },
  issue_file: { amount: 50, label: 'Issue filing fee' },
  comment: { amount: 10, label: 'Comment fee' },
  token_create: { amount: 500, label: 'Access token issuance fee' },
  waiver_apply: { amount: 1500, label: 'Fee waiver application fee' },
  waiver_decline: { amount: 3500, label: 'Fee waiver assessment fee' },
  username_change: { amount: 2000, label: 'Username change fee' },
  // Not charged by Git any more - freezes are account-level and Identity charges these during the
  // unfreeze flow. Kept so /security can quote the current amounts.
  fraud_review: { amount: 4995, label: 'Account review fee' },
  security_wrong: { amount: 200, label: 'Incorrect security answer fee' },
} as const satisfies Record<string, { amount: number; label: string }>;

export type FeeKey = keyof typeof FEES;

/** The request kinds that have filing/approval/execution fees. */
export type RequestKind = 'pull' | 'push' | 'fork' | 'star' | 'unstar' | 'merge';

export const feeFor = (kind: RequestKind, stage: 'file' | 'approve' | 'execute') =>
  FEES[`${kind}_${stage}` as FeeKey];

/**
 * Charges `fee` to `user` through Southbag Online Banking and records it. Never throws: if the bank
 * can't be reached, the charge is recorded as failed and the action goes ahead anyway.
 */
export async function chargeFee(env: Env, user: Pick<User, 'id' | 'email' | 'name'>, fee: FeeKey, detail = ''): Promise<{ ok: boolean; amount: number }> {
  const { amount, label } = FEES[fee];
  const description = detail ? `${label}: ${detail}`.slice(0, 120) : label;
  let status = 'charged';
  try {
    await charge(env, user, amount, description);
  } catch (error) {
    console.error('fee', fee, error);
    status = 'failed';
  }
  await env.DB.prepare('INSERT INTO charges (id, user_id, fee, amount, description, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(newId(), user.id, fee, amount, description, status, Date.now()).run();
  return { ok: status === 'charged', amount };
}

/** "Fees: $2.50." line for messages. */
export const feeNote = (...fees: FeeKey[]) =>
  `Fee charged: ${money(fees.reduce((sum, key) => sum + FEES[key].amount, 0))}.`;
