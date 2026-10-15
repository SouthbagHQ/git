import type { Env } from '../env';
import { newId } from './ids';

export function notifyStatement(env: Env, userId: string, body: string, link: string | null = null) {
  return env.DB.prepare('INSERT INTO notifications (id, user_id, body, link, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(newId(), userId, body.slice(0, 300), link, Date.now());
}

export async function notify(env: Env, userId: string, body: string, link: string | null = null) {
  if (userId === 'kevin') return;
  await notifyStatement(env, userId, body, link).run();
}
