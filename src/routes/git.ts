// Git over HTTPS (smart HTTP, protocol v0). Mounted at `/` before the page routes:
//   GET  /:owner/:repo(.git)/info/refs?service=git-upload-pack|git-receive-pack
//   POST /:owner/:repo(.git)/git-upload-pack
//   POST /:owner/:repo(.git)/git-receive-pack
// Every operation needs Basic auth with an access token (gitAuthenticate), reads included.
//
// DEV-ONLY HOOK (local smoke tests, see scripts/git-smoke.sh): when the request host is
// localhost/127.0.0.1 AND env.GIT_DEV_POLICY === 'off', the policy in src/lib/policy.ts is skipped
// entirely: the request is authenticated as the user id in env.GIT_DEV_USER, fetches and pushes are
// always allowed, and ok'd ref updates are applied here with setRef (in production refs only move
// through reviewPush / src/lib/pushes.ts). Both vars are only ever set with `wrangler dev --var`.

import { Hono, type Context } from 'hono';
import type { AppEnv, Env, Repo, User } from '../env';
import { beforeFetch, beforeListRefs, beforePush, gitAuthenticate, reviewPush } from '../lib/policy';
import { applyCentralFreeze } from '../lib/identity';
import {
  advertiseRefs,
  errorAdvertisement,
  receivePack,
  uploadPack,
  type GitPolicy,
  type Service,
} from '../git/protocol';
import { ObjectStore } from '../git/store';

const git = new Hono<AppEnv>();

const noCache = {
  'Cache-Control': 'no-cache, max-age=0, must-revalidate',
  Pragma: 'no-cache',
  Expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
};

type C = Context<AppEnv>;

async function findRepo(env: Env, owner: string, name: string): Promise<Repo | null> {
  name = name.replace(/\.git$/i, '');
  return env.DB.prepare(
    `SELECT repos.*, users.username AS owner FROM repos JOIN users ON users.id = repos.owner_id
     WHERE users.username = ? COLLATE NOCASE AND repos.name = ? COLLATE NOCASE`,
  )
    .bind(owner, name)
    .first<Repo>();
}

/** DEV ONLY: see the comment at the top of this file. */
function devPolicyOff(c: C): boolean {
  const host = new URL(c.req.url).hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  return local && c.env.GIT_DEV_POLICY === 'off' && typeof c.env.GIT_DEV_USER === 'string';
}

async function authenticate(c: C): Promise<User | null> {
  if (devPolicyOff(c)) {
    return c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(c.env.GIT_DEV_USER as string).first<User>();
  }
  const user = await gitAuthenticate(c.env, c.req.raw);
  // The freeze is account-level: Identity's status applies here too, so a frozen account
  // cannot push (or fetch) with a token that predates the freeze.
  if (user) await applyCentralFreeze(c.env, user);
  return user;
}

function policyFor(c: C, user: User, repo: Repo): GitPolicy {
  if (devPolicyOff(c)) {
    // DEV ONLY: allow everything and move refs ourselves.
    return {
      beforeListRefs: async () => ({ ok: true }),
      beforeFetch: async () => ({ ok: true }),
      beforePush: async () => ({ ok: true }),
      reviewPush: async () => ({ results: {}, messages: ['Southbag Git (dev): policy is off; refs updated directly.'] }),
      applyRefs: true,
    };
  }
  return {
    beforeListRefs: () => beforeListRefs(c.env, user, repo),
    beforeFetch: () => beforeFetch(c.env, c.executionCtx, user, repo),
    beforePush: () => beforePush(c.env, user, repo),
    reviewPush: (analyses) => reviewPush(c.env, c.executionCtx, user, repo, analyses),
  };
}

const unauthorized = () =>
  new Response('Authentication required. Create an access token at https://git.southbag.cc/settings/tokens\n', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Southbag Git"', 'Content-Type': 'text/plain; charset=utf-8', ...noCache },
  });

const notFound = () =>
  new Response('Repository not found.\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...noCache } });

async function setup(c: C): Promise<{ user: User; repo: Repo } | Response> {
  const repo = await findRepo(c.env, c.req.param('owner')!, c.req.param('repo')!);
  if (!repo) return notFound();
  const user = await authenticate(c);
  if (!user) return unauthorized();
  return { user, repo };
}

async function readBody(c: C): Promise<Uint8Array> {
  const raw = c.req.raw.body;
  if (!raw) return new Uint8Array(0);
  const enc = (c.req.header('content-encoding') ?? '').toLowerCase();
  const stream = enc === 'gzip' || enc === 'x-gzip' ? raw.pipeThrough(new DecompressionStream('gzip')) : raw;
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const respond = (body: Uint8Array, type: string, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': type, ...noCache } });

git.get('/:owner/:repo/info/refs', async (c) => {
  const service = c.req.query('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return new Response('Southbag Git only speaks smart HTTP. Please upgrade your git client.\n', {
      status: 403,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', ...noCache },
    });
  }
  const s = await setup(c);
  if (s instanceof Response) return s;
  const type = `application/x-${service}-advertisement`;
  const policy = policyFor(c, s.user, s.repo);
  const verdict = await (service === 'git-receive-pack' ? policy.beforePush() : policy.beforeListRefs());
  if (!verdict.ok) return respond(errorAdvertisement(service as Service, verdict.message), type);
  const store = new ObjectStore(c.env, s.repo.network_id);
  return respond(await advertiseRefs(c.env, s.repo, service, store), type);
});

git.post('/:owner/:repo/git-upload-pack', async (c) => {
  const s = await setup(c);
  if (s instanceof Response) return s;
  const store = new ObjectStore(c.env, s.repo.network_id);
  const body = await readBody(c);
  return respond(await uploadPack(store, body, policyFor(c, s.user, s.repo)), 'application/x-git-upload-pack-result');
});

git.post('/:owner/:repo/git-receive-pack', async (c) => {
  const s = await setup(c);
  if (s instanceof Response) return s;
  const store = new ObjectStore(c.env, s.repo.network_id);
  const body = await readBody(c);
  return respond(
    await receivePack(c.env, s.repo, store, body, policyFor(c, s.user, s.repo)),
    'application/x-git-receive-pack-result',
  );
});

export default git;
