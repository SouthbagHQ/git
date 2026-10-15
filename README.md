# Southbag Git

Source code hosting for Southbag customers. Modelled on [Forgejo](https://forgejo.org): repositories,
a code browser, issues and merge requests, and git over HTTPS. Unlike Forgejo, every action needs
a request that the repository owner approves, and every step has a fee.

It signs in with **Southbag Identity™**, takes fees from **Southbag Online Banking**, and looks like
the other Southbag products ([Social](../social), [Identity](../identity), [Banking](../banking)).

## What's different

- **Pull requests** give permission to run `git pull` / `fetch` / `clone` once. Without an approved
  one, git prints `fatal: remote error: You need an approved pull request…`.
- **Push requests** give permission to run `git push` once.
- **Merge requests** are what other forges call pull requests.
- **Fork requests**, **star requests** and **unstar requests**: approved, then executed with a button.
- Approved pull and push requests are good for one use within 24 hours.
- **Fees** for filing, approving (charged to whoever approves) and executing every request, plus
  repositories, issues, comments, access tokens, username changes, declined and withdrawn requests,
  after-hours pushes, merge conflicts and wrong security answers. See `src/lib/fees.ts` or `/fees`.
- **Fee waivers** "for open source projects" (`/waivers`): an application fee, a few minutes of
  assessment, then always declined with an assessment fee.
- **Pushes are pending.** git reports success, but refs only move when the push is processed: a few
  minutes later during business hours (9:00 to 17:00 AEST, Monday to Friday, no daylight saving), or
  a few minutes after the next business day opens, with the after-hours fee. See `/{owner}/{repo}/pushes`.
- **Topics that cannot be discussed** (the list in Southbag Code's system prompt: Blahaj, 1984, the
  2019 incident, Kevin's password, Floor 3, Step 3, Kevin's voicemail, the briefcase, refunds, anything
  that makes Southbag or Kevin look bad): pushes whose commit messages mention one are refused, and so
  are issues, comments and merge requests. `src/lib/banned.ts`.
- **Merge conflicts** are resolved by picking a side at random for each conflicting file, committed as
  `Kevin <Kevin@southbag.cc>` with the message `Resolved merge conflict`. `src/git/merge.ts`.
- **The Issue.** Every repository has issue #1, "The Issue", by Kevin, resolved, dated "2019",
  locked and immutable.
- **`floor-3`.** Every repository has a branch called `floor-3`. It is never shown in the interface,
  but `git checkout floor-3` works. It cannot be pushed to. `src/git/floor3.ts`.
- **Fraud detection** (`src/lib/fraud.ts`) is sensitive: force pushes, deleted branches, large
  deletions, commits made between midnight and 6 am AEST, on weekends, at 13:37, dated in the future
  or before git existed, commits claiming to be from Kevin, vague commit messages ("fix", "wip"),
  more than 60 commits in a push, two pushes within 90 seconds, and starring and unstarring within ten
  minutes. One finding freezes the account. Frozen accounts answer three security questions in a row
  at `/security` ("What was the name of your first repository?", "Who maintains The Pile?", …) and pay
  the account review fee.
- Everyone gets an assigned username (`customer-123456`); choosing one costs a fee. Nothing can be
  deleted. There are no collaborators.

## How it runs

- **One Worker** (`src/`, [Hono](https://hono.dev)). Pages are rendered on the server like Forgejo
  (`src/routes/*`, `src/views/*`, `hono/html`); `public/` has the CSS, a little JS and images.
- **One D1 database for everything**, git objects included (`objects`, uncompressed, one row per
  object; objects over 1.9 MB are refused). Forks share their parent's objects (`network_id`).
- **Git over HTTPS** is implemented from scratch in `src/git/` (smart HTTP protocol v0: pkt-lines,
  packfile reading with deltas, pack writing, ref advertisement) and `src/routes/git.ts`. It
  authenticates with personal access tokens (`/settings/tokens`) as the Basic auth password. Every
  decision about money, requests, fraud and business hours is in `src/lib/policy.ts` and below it.
- **Money**: fees go to Southbag Online Banking's `Billing` entrypoint over the `BANKING` service
  binding (RPC between Workers, like Social). `src/lib/banking.ts`.
- **Login**: Southbag Identity, OIDC + PKCE with dynamic client registration (the first login from
  an origin registers a client). `src/lib/auth.ts`.
- **Cron** every minute processes due pushes, decides fee waivers and expires requests
  (`src/lib/processor.ts`). Page loads do the same in the background.
- Unpacking packfiles needs more than the free plan's 10 ms of CPU: `limits.cpu_ms` is set, which
  needs the Workers Paid plan.

## Develop

```sh
npm install
npm run db:migrate:local
npm run seed:local     # alice, bob and carol, with sessions and git tokens
npm run dev            # http://localhost:8788 (BANKING_DEV=1: fees succeed without a bank)
```

Set the cookie `southbag_git_session=dev-alice` (or `dev-bob`, `dev-carol`) to be signed in without
Identity. Git: `git clone http://alice:sbg_dev_alice@localhost:8788/alice/<repo>.git` (after an
approved pull request). `npm run check` type-checks.

## Deploy

Create the D1 database (`wrangler d1 create southbag-git`), put its id in `wrangler.jsonc`, deploy
Banking first, then `npm run deploy`.
