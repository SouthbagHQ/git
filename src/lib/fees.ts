// Every fee Southbag Git charges, and the one function that charges them.
// Money is taken from Southbag Online Banking (src/lib/banking.ts) and recorded in `charges`.
// A fee that the bank can't take is still recorded (status 'failed') and doesn't stop the action:
// Banking lets balances go negative, so this only happens when the bank is unreachable.

import type { Env, User } from '../env';
import { charge, money } from './banking';
import { newId } from './ids';

export { money };

export { FEES, type FeeKey } from './fees-catalog';
import { FEES, type FeeKey } from './fees-catalog';

/** The request kinds that have filing/approval/execution fees. */
export type RequestKind = 'pull' | 'push' | 'fork' | 'star' | 'unstar' | 'merge';

export const feeFor = (kind: RequestKind, stage: 'file' | 'approve' | 'execute') =>
  FEES[`${kind}_${stage}` as FeeKey];

/**
 * Charges `fee` to `user` through Southbag Online Banking and records it. Never throws: if the bank
 * can't be reached, the charge is recorded as failed and the action goes ahead anyway.
 */
export async function chargeFee(env: Env, user: Pick<User, 'id' | 'email' | 'name'>, fee: FeeKey, detail = '', idempotencyKey?: string): Promise<{ ok: boolean; amount: number; duplicate: boolean }> {
  const { amount, label } = FEES[fee];
  const description = detail ? `${label}: ${detail}`.slice(0, 120) : label;
  let status = 'charged';
  let duplicate = false;
  try {
    const result = await charge(env, user, amount, description, idempotencyKey);
    duplicate = result.duplicate ?? false;
  } catch (error) {
    console.error('fee', fee, error);
    status = 'failed';
  }
  await env.DB.prepare('INSERT INTO charges (id, user_id, fee, amount, description, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(newId(), user.id, fee, amount, description, status, Date.now()).run();
  return { ok: status === 'charged', amount, duplicate };
}

/** "Fees: $2.50." line for messages. */
export const feeNote = (...fees: FeeKey[]) =>
  `Fee charged: ${money(fees.reduce((sum, key) => sum + FEES[key].amount, 0))}.`;
