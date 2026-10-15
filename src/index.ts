// Southbag Git — one Cloudflare Worker. Pages are rendered here (like Forgejo); /css, /js and /img
// are static files served by Workers Assets. Git over HTTPS is src/routes/git.ts.

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv, Env } from './env';
import { callback, getCookie, login, logout, safeReturnTo, session } from './lib/auth';
import { flashCookie, redirect } from './lib/http';
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

// ── Auth ──
app.get('/auth/login', c => login(c.req.raw, c.env, safeReturnTo(c.req.query('next'))));
app.get('/auth/callback', c => callback(c.req.raw, c.env, c.executionCtx));
app.get('/auth/logout', c => logout(c.req.raw, c.env, c.executionCtx));
app.post('/auth/logout', c => logout(c.req.raw, c.env, c.executionCtx));

// ── Pages ──
app.use('*', async (c, next) => {
  const user = await session(c.req.raw, c.env);
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
