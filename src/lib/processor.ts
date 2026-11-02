// Background work: run by the cron every minute, and opportunistically after page loads.

import type { Env } from '../env';
import { processDuePushes } from './pushes';
import { decideDueWaivers } from './waivers';
import { flushFreezeReports } from './identity';

export async function processDue(env: Env): Promise<void> {
  const now = Date.now();
  await processDuePushes(env, now).catch(err => console.error('pushes', err));
  await decideDueWaivers(env, now).catch(err => console.error('waivers', err));
  await flushFreezeReports(env).catch(err => console.error('identity freeze reports', err));
  await env.DB.batch([
    env.DB.prepare(`UPDATE requests SET status = 'expired' WHERE status IN ('open', 'approved') AND expires_at IS NOT NULL AND expires_at < ?`).bind(now),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM oauth_states WHERE expires_at < ?').bind(now),
  ]).catch(err => console.error('janitor', err));
}
