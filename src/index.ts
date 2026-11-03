// Southbag Git — one Cloudflare Worker. Pages are rendered here (like Forgejo); /css, /js and /img
// are static files served by Workers Assets. Git over HTTPS is src/routes/git.ts.

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv, Env } from './env';
import { callback, getCookie, login, logout, safeReturnTo, session } from './lib/auth';
import { flashCookie, redirect } from './lib/http';
import { applyCentralFreeze } from './lib/identity';
import { handleMcp } from './lib/mcp';
import { processDue } from './lib/processor';
import { errorPage } from './views/layout';
import git from './routes/git';
import account from './routes/account';
import home from './routes/home';
import repo from './routes/repo';
import mergeInbox from './routes/merge-inbox';

const app = new Hono<AppEnv>();

app.onError((error, c) => {
  const status = error instanceof HTTPException ? error.status : 500;
  const message = error instanceof HTTPException ? error.message : 'Something went wrong.';
  if (!(error instanceof HTTPException)) console.error(error);
  if (status === 401 && c.req.method === 'GET')
    return c.redirect(`/auth/login?next=${encodeURIComponent(new URL(c.req.url).pathname)}`);
  // Forms go back where they came from, with the message in a dialog.
  if (c.req.method === 'POST') {
    const referer = c.req.header('referer');
    const back = referer && new URL(referer).origin === new URL(c.req.url).origin ? new URL(referer).pathname + new URL(referer).search : '/';
    return redirect(c, back, `Error: ${message}`);
  }
  return c.html(errorPage(c.get('user') ?? null, status, message), status as 404);
});
app.notFound(c => c.html(errorPage(c.get('user') ?? null, 404, 'Page not found.'), 404));

// ── Git over HTTPS (Basic auth with access tokens, no cookies) ──
app.route('/', git);

// ── Agent access (MCP): bearer agent token, $1 request fee per tools/call, discovery free ──
app.all('/mcp', c => handleMcp(c.req.raw, c.env));

// ── Auth ──
app.get('/auth/login', c => login(c.req.raw, c.env, safeReturnTo(c.req.query('next'))));
app.get('/auth/callback', c => callback(c.req.raw, c.env, c.executionCtx));
app.get('/auth/logout', c => logout(c.req.raw, c.env, c.executionCtx));
app.post('/auth/logout', c => logout(c.req.raw, c.env, c.executionCtx));

// ── Pages ──
app.use('*', async (c, next) => {
  const user = await session(c.req.raw, c.env);
  // The freeze is account-level: Identity's status applies to the in-memory user for this
  // request (and a completed central unfreeze clears the legacy local flag).
  if (user) await applyCentralFreeze(c.env, user);
  // A KNOWN frozen account is blocked entirely, reads included: no private account data, no
  // notifications, nothing behind the session. Logout and the public pages stay reachable.
  // Status UNKNOWN (Identity configured but unreachable) fails CLOSED too: no private pages.
  if (user?.central_unavailable && !c.req.path.startsWith('/auth/')) {
    const text = 'Southbag Identity is unavailable, so your account status cannot be checked. Try again shortly.';
    if (c.req.path.startsWith('/api/'))
      return c.json({ error: 'unavailable', text }, 503);
    return c.html(errorPage(user, 503, text), 503);
  }
  if (user?.frozen && !c.req.path.startsWith('/auth/')) {
    const text = 'Your account is frozen pending review. Unfreeze at https://identity.southbag.cc/unfreeze';
    if (c.req.path.startsWith('/api/'))
      return c.json({ error: 'frozen', text }, 423);
    return c.html(errorPage(user, 423, text), 423);
  }
  c.set('user', user);
  c.set('unread', user ? (await c.env.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL')
    .bind(user.id).first<{ n: number }>())?.n ?? 0 : 0);
  const flash = getCookie(c.req.raw, flashCookie);
  c.set('flash', flash ? decodeURIComponent(flash) : null);
  // Forms with a cookie session must come from this site.
  if (c.req.method === 'POST') {
    const origin = c.req.header('origin');
    if (origin && origin !== new URL(c.req.url).origin) return c.text('Invalid origin', 403);
  }
  await next();
  if (flash && c.req.method === 'GET') c.res.headers.append('set-cookie', `${flashCookie}=; Path=/; Max-Age=0`);
  // Pending pushes and fee waivers move along whenever anyone is looking, as well as on the cron.
  try { c.executionCtx.waitUntil(processDue(c.env)); } catch { /* not in a Worker */ }
});

// For Palantir (public/palantir.js identifies the signed-in user from this).
app.get('/api/me', c => {
  const user = c.get('user');
  c.header('cache-control', 'no-store');
  return c.json(user ? { id: user.id, email: user.email, name: user.name, username: user.username } : null);
});

// Fixed paths (account) before /:owner (home) before /:owner/:repo (repo).
app.route('/', account);
app.route('/', mergeInbox);
app.route('/', home);
app.route('/', repo);

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(processDue(env));
  },
} satisfies ExportedHandler<Env>;
