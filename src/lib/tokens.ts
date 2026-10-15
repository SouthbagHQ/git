// Personal access tokens for git over HTTPS. Git sends them as the password in Basic auth.
// Tokens expire after 7 days. Issuing one costs a fee.

import type { Env, User } from '../env';
import { chargeFee } from './fees';
import { newId, randomToken, sha256 } from './ids';

export const TOKEN_DAYS = 7;

export async function createToken(env: Env, user: User, name: string): Promise<string> {
  const token = 'sbg_' + randomToken();
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO access_tokens (id, user_id, name, token_hash, last_four, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(newId(now), user.id, name, await sha256(token), token.slice(-4), now, now + TOKEN_DAYS * 86400000).run();
  await chargeFee(env, user, 'token_create', name);
  return token;
}

/** The user for a git request's Basic auth, or null. The username part is ignored. */
export async function userFromBasicAuth(env: Env, request: Request): Promise<User | null> {
  const header = request.headers.get('authorization');
  const encoded = header?.match(/^Basic\s+(.+)$/i)?.[1];
  if (!encoded) return null;
  let password = '';
  try {
    const decoded = atob(encoded);
    password = decoded.slice(decoded.indexOf(':') + 1);
  } catch {
    return null;
  }
  if (!password) return null;
  const hash = await sha256(password);
  const row = await env.DB.prepare(`SELECT users.*, access_tokens.id AS token_id, access_tokens.expires_at AS token_expires_at
    FROM access_tokens JOIN users ON users.id = access_tokens.user_id WHERE access_tokens.token_hash = ?`)
    .bind(hash).first<User & { token_id: string; token_expires_at: number }>();
  if (!row || row.token_expires_at < Date.now()) return null;
  await env.DB.prepare('UPDATE access_tokens SET last_used_at = ? WHERE id = ?').bind(Date.now(), row.token_id).run();
  const { token_id: _, token_expires_at: __, ...user } = row;
  return user;
}
