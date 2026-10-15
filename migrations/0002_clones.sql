-- Who has cloned what. The first fetch of a repository is a clone (clone fee, no request); every
-- fetch or pull after that needs an approved pull request, even one that turns out to be up to date.
CREATE TABLE clones (
  user_id TEXT NOT NULL REFERENCES users(id),
  repo_id TEXT NOT NULL REFERENCES repos(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, repo_id)
) WITHOUT ROWID;

-- Clones charged before this table existed.
INSERT OR IGNORE INTO clones (user_id, repo_id, created_at)
SELECT charges.user_id, repos.id, MIN(charges.created_at)
FROM charges
JOIN repos ON charges.description = 'Clone fee: ' || (SELECT username FROM users WHERE users.id = repos.owner_id) || '/' || repos.name
WHERE charges.fee = 'clone'
GROUP BY charges.user_id, repos.id;
