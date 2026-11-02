-- Durable queue for reporting freezes to Southbag Identity (the account-level freeze).
CREATE TABLE identity_freeze_outbox (
  user_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  reported_at INTEGER
);
