// The account-level freeze, owned by Southbag Identity (identity.southbag.cc). Git's fraud
// detection still detects and records freezes locally, but the freeze itself is reported to
// Identity, every signed-in action checks Identity's status, and unfreezing only happens there
// (/unfreeze, security questions plus the account review fee - Git's own question flow is gone).
//
// Deploy config: `wrangler secret put IDENTITY_INTERNAL_SECRET` with this service's entry from
// Identity's INTERNAL_API_SECRETS (key "southbag-git"). Without it the central check is off and
// only the legacy local flag applies.
//
// Reports are durable: fraud detection enqueues into identity_freeze_outbox in the same batch as
// the local freeze, and the queue is flushed after the action and by the every-minute cron, so a
// down Identity loses nothing.
//
// Availability policy: when the secret is NOT CONFIGURED the central check is off and only the
// legacy local flag applies (development). When it is configured but Identity CAN'T BE REACHED,
// enforcement is conservative: signed-in actions are refused until Identity answers again. An
// Identity outage then blocks actions Southbag-wide - that is the price of "block ALL services";
// reads and the unfreeze page itself stay reachable as long as Identity is up.

import type { Env, User } from '../env';

export interface CentralFreezeStatus {
  frozen: boolean;
  reason: string | null;
  frozenAt: number | null;
  /** True once the account has completed Identity's unfreeze flow: legacy local flags may be dropped. */
  unfrozenViaFlow: boolean;
  /** True when the secret is configured but Identity couldn't be reached (answer unknown). */
  unavailable?: boolean;
}

export const UNFREEZE_URL = 'https://identity.southbag.cc/unfreeze';

export const centralFreezeConfigured = (env: Env) =>
  typeof env.IDENTITY_INTERNAL_SECRET === 'string' && env.IDENTITY_INTERNAL_SECRET.length > 0;

const identityOrigin = (env: Env) => String(env.IDENTITY_ORIGIN || 'https://identity.southbag.cc');

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** Identity's answer for the user, or null when the central state is unknown (unconfigured/down). */
export async function getCentralFreeze(env: Env, userId: string, fetcher: Fetcher = fetch): Promise<CentralFreezeStatus | null> {
  if (!centralFreezeConfigured(env)) return null;
  // Every check is FRESH - no cache: a cached 'active' answer is an authorization window a
  // just-frozen user could keep using for reads and pushes.
  try {
    const response = await fetcher(`${identityOrigin(env)}/api/internal/freeze?userId=${encodeURIComponent(userId)}`, {
      headers: { authorization: `Bearer ${env.IDENTITY_INTERNAL_SECRET}` },
    });
    if (response.status === 401 || response.status === 403) {
      // Loud and distinct: the secret is wrong or rotated, which a presence-only deploy guard
      // cannot catch. Still fails closed (unavailable), but this is the log line to page on.
      console.error(`identity freeze status REJECTED the configured secret (HTTP ${response.status}) - check IDENTITY_INTERNAL_SECRET`);
      return { frozen: false, reason: null, frozenAt: null, unfrozenViaFlow: false, unavailable: true };
    }
    if (!response.ok) throw new Error(`identity status ${response.status}`);
    return (await response.json()) as CentralFreezeStatus;
  } catch (error) {
    console.error('identity freeze status failed', error);
    // Configured but unreachable: unknown, and enforcement fails CLOSED (no private reads either).
    return { frozen: false, reason: null, frozenAt: null, unfrozenViaFlow: false, unavailable: true };
  }
}

/**
 * Applies the central freeze to a freshly loaded local user row: frozen centrally means frozen
 * here (in memory, for this request); a completed central unfreeze clears the legacy local flag.
 * Local freezes from before the central freeze existed stay until Identity's backfill has run -
 * they have no central record to clear against.
 */
export async function applyCentralFreeze(env: Env, user: User, fetcher: Fetcher = fetch): Promise<User> {
  user.central_unavailable = 0;
  const central = await getCentralFreeze(env, user.id, fetcher);
  if (!central) return user;
  if (central.unavailable) {
    // Unknown is not safe: refuse signed-in actions until Identity answers (see the header comment).
    if (!user.frozen) {
      user.frozen = 1;
      user.frozen_reason = null;
      user.frozen_at = null;
      user.central_unavailable = 1;
    }
    return user;
  }
  if (central.frozen) {
    if (!user.frozen) {
      user.frozen = 1;
      user.frozen_reason = central.reason ?? 'Account frozen';
      user.frozen_at = central.frozenAt;
    }
    return user;
  }
  if (user.frozen && central.unfrozenViaFlow) {
    await env.DB.prepare(`UPDATE users SET frozen = 0, frozen_reason = NULL, frozen_at = NULL, security_question = NULL, security_streak = 0 WHERE id = ?`)
      .bind(user.id).run();
    user.frozen = 0;
    user.frozen_reason = null;
    user.frozen_at = null;
    user.security_question = null;
    user.security_streak = 0;
  }
  return user;
}

/** Durable queue: the report survives Identity being down. */
export async function enqueueFreezeReport(env: Env, userId: string, reason: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO identity_freeze_outbox (user_id, reason, created_at, reported_at) VALUES (?, ?, ?, NULL)
    ON CONFLICT(user_id) DO UPDATE SET reason = excluded.reason, reported_at = NULL`)
    .bind(userId, reason, Date.now()).run();
}

/** Sends every queued freeze report to Identity. Never throws. */
export async function flushFreezeReports(env: Env, fetcher: Fetcher = fetch): Promise<void> {
  if (!centralFreezeConfigured(env)) return;
  const pending = await env.DB.prepare('SELECT user_id, reason FROM identity_freeze_outbox WHERE reported_at IS NULL')
    .all<{ user_id: string; reason: string }>();
  for (const row of pending.results) {
    try {
      const response = await fetcher(`${identityOrigin(env)}/api/internal/freeze`, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.IDENTITY_INTERNAL_SECRET}`, 'content-type': 'application/json' },
        body: JSON.stringify({ userId: row.user_id, reason: row.reason, origin: 'git-fraud' }),
      });
      if (!response.ok) throw new Error(`identity freeze report ${response.status}`);
      await env.DB.prepare('UPDATE identity_freeze_outbox SET reported_at = ? WHERE user_id = ?').bind(Date.now(), row.user_id).run();
    } catch (error) {
      console.error('identity freeze report failed for', row.user_id, error);
    }
  }
}
