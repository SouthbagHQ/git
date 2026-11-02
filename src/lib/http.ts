import { HTTPException } from 'hono/http-exception';
import type { Ctx, User } from '../env';
import { UNFREEZE_URL } from './identity';

/** Nothing on Southbag Git can be deleted. Every attempt gets this. */
export const NO_DELETING = "Deletion isn't available. Kevin knows what you did.";

/** Throw from anywhere in a handler. The message is shown to the person, so keep it plain. */
export function fail(status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 423 | 429 | 500 | 502 | 503, message: string): never {
  throw new HTTPException(status, { message });
}

/** The signed-in user, or a 401 (which the app turns into a sign-in redirect). */
export function requireUser(c: Ctx): User {
  const user = c.get('user');
  if (!user) fail(401, 'Sign in to do that.');
  return user;
}

/** The signed-in user, whose account must not be frozen. */
export function requireActiveUser(c: Ctx): User {
  const user = requireUser(c);
  if (user.central_unavailable) fail(503, 'Southbag Identity is unavailable, so your account status cannot be checked. Try again shortly.');
  if (user.frozen) fail(423, `Your account is frozen pending review. Unfreeze at ${UNFREEZE_URL}`);
  return user;
}

export const flashCookie = 'southbag_git_flash';

/** Redirect with a message that the next page shows in a dialog. */
export function redirect(c: Ctx, to: string, message?: string): Response {
  const headers = new Headers({ location: to });
  if (message) headers.append('set-cookie', `${flashCookie}=${encodeURIComponent(message.slice(0, 600))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=60`);
  return new Response(null, { status: 303, headers });
}

/** Form fields (urlencoded or multipart) as strings. */
export async function form(c: Ctx): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const data = await c.req.parseBody();
    for (const [key, value] of Object.entries(data)) if (typeof value === 'string') out[key] = value;
  } catch { /* empty body */ }
  return out;
}

/** Trimmed string from untrusted input, cut to `max` characters. */
export function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Page number from `?page=` (1-based). */
export function pageNumber(c: Ctx): number {
  const n = Number(c.req.query('page'));
  return Number.isInteger(n) && n > 0 ? Math.min(n, 1000) : 1;
}

export const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/** Repository and branch names: letters, digits, dot, dash, underscore. */
export const validName = (name: string) => /^[A-Za-z0-9._-]{1,64}$/.test(name) && !/^\.+$/.test(name) && !name.endsWith('.git');
