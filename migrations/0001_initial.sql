-- Southbag Git. Everything lives in one D1 database, git objects included.

CREATE TABLE users (
  id TEXT PRIMARY KEY,                -- Southbag Identity `sub` ('kevin' for Kevin)
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  email TEXT,
  bio TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- Fraud detection. A frozen account can do nothing until it answers security questions.
  frozen INTEGER NOT NULL DEFAULT 0,
  frozen_reason TEXT,
  frozen_at INTEGER,
  security_question TEXT,             -- id of the question currently asked
  security_streak INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE oauth_clients (
  origin TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL DEFAULT '',
  redirect_uri TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  return_to TEXT,
  expires_at INTEGER NOT NULL
);

-- Personal access tokens for git over HTTPS (Basic auth: username + token).
CREATE TABLE access_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  last_four TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE repos (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  default_branch TEXT NOT NULL DEFAULT 'main',
  -- Forks share their parent's object store (network).
  network_id TEXT NOT NULL,
  forked_from TEXT REFERENCES repos(id),
  next_number INTEGER NOT NULL DEFAULT 2, -- #1 is always The Issue
  stars INTEGER NOT NULL DEFAULT 0,
  forks INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (owner_id, name)
);
CREATE INDEX repos_updated ON repos (updated_at DESC);

-- Git objects, uncompressed. type: commit, tree, blob, tag.
CREATE TABLE objects (
  network_id TEXT NOT NULL,
  oid TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (network_id, oid)
) WITHOUT ROWID;

-- Live refs. refs/heads/floor-3 is never stored here; see src/git/floor3.ts.
CREATE TABLE refs (
  repo_id TEXT NOT NULL REFERENCES repos(id),
  name TEXT NOT NULL,
  oid TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, name)
) WITHOUT ROWID;

-- Every git push. Accepted pushes wait as 'pending' until processed in AEST business hours.
CREATE TABLE pushes (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  request_id TEXT,
  status TEXT NOT NULL,               -- pending | processed | rejected
  updates TEXT NOT NULL,              -- JSON [{ ref, old, new }]
  commits INTEGER NOT NULL DEFAULT 0,
  after_hours INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  due_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  processed_at INTEGER
);
CREATE INDEX pushes_due ON pushes (status, due_at);
CREATE INDEX pushes_repo ON pushes (repo_id, created_at DESC);

-- Pull, push, fork, star and unstar requests. (Merge requests have their own table.)
CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  kind TEXT NOT NULL,                 -- pull | push | fork | star | unstar
  requester_id TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',-- open | approved | declined | executed | withdrawn | expired
  decided_by TEXT REFERENCES users(id),
  decided_at INTEGER,
  executed_at INTEGER,
  result TEXT,                        -- e.g. the fork's repo id
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX requests_repo ON requests (repo_id, status, created_at DESC);
CREATE INDEX requests_requester ON requests (requester_id, created_at DESC);

CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  number INTEGER NOT NULL,
  author_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'open', -- open | closed
  locked INTEGER NOT NULL DEFAULT 0,
  immutable INTEGER NOT NULL DEFAULT 0,
  display_date TEXT,                  -- shown instead of real dates ("2019")
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  UNIQUE (repo_id, number)
);

-- Merge requests (what other forges call pull requests). Numbered with issues.
CREATE TABLE merge_requests (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  number INTEGER NOT NULL,
  author_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  source_repo_id TEXT NOT NULL REFERENCES repos(id),
  source_branch TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',-- open | approved | merged | closed
  approved_by TEXT REFERENCES users(id),
  approved_at INTEGER,
  merged_by TEXT REFERENCES users(id),
  merged_at INTEGER,
  merge_oid TEXT,
  conflicts TEXT,                     -- JSON list of paths Kevin decided
  created_at INTEGER NOT NULL,
  UNIQUE (repo_id, number)
);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  number INTEGER NOT NULL,            -- issue or merge request number
  author_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX comments_thread ON comments (repo_id, number, created_at);

CREATE TABLE stars (
  user_id TEXT NOT NULL REFERENCES users(id),
  repo_id TEXT NOT NULL REFERENCES repos(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, repo_id)
) WITHOUT ROWID;

-- Every fee taken (or attempted) through Southbag Online Banking.
CREATE TABLE charges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  fee TEXT NOT NULL,                  -- key in src/lib/fees.ts
  amount INTEGER NOT NULL,            -- cents
  description TEXT NOT NULL,
  status TEXT NOT NULL,               -- charged | failed
  created_at INTEGER NOT NULL
);
CREATE INDEX charges_user ON charges (user_id, created_at DESC);

-- Fee waivers for open source projects. All of them are declined.
CREATE TABLE waivers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  project TEXT NOT NULL,
  licence TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | declined
  decision TEXT,
  decide_at INTEGER NOT NULL,
  decided_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX waivers_due ON waivers (status, decide_at);

CREATE TABLE fraud_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  repo_id TEXT,
  rule TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX fraud_user ON fraud_events (user_id, created_at DESC);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  link TEXT,
  read_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX notifications_user ON notifications (user_id, created_at DESC);

-- Kevin. He authors The Issue in every repository and resolves every merge conflict.
INSERT INTO users (id, username, name, email, bio, created_at, updated_at)
VALUES ('kevin', 'Kevin', 'Kevin', 'Kevin@southbag.cc', '', 1546300800000, 1546300800000);
