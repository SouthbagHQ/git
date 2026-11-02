#!/usr/bin/env bash
# Integration test: the account-level freeze on the git protocol itself, against a real Worker
# and a faithful local Identity fixture (scripts/../test-fixtures/identity-fixture.mjs).
# Policy is ON (no GIT_DEV_POLICY hook): every fetch and push authenticates with a seeded access
# token and answers to the central freeze, checked fresh per request.
#
#   bash scripts/freeze-integration.sh          # KEEP=1 keeps the temp dir
#
# Matrix: active -> clone+push work | frozen -> read AND write refused with the freeze message |
# secret rejected / Identity down -> read AND write refused with the unavailable message |
# active again -> works (proves nothing was cached).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8802}"
FIXTURE_PORT="${FIXTURE_PORT:-8803}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/southbag-git-freeze.XXXXXX")"
STATE="$TMP/state"
WORK="$TMP/work"
LOG="$TMP/dev.log"
DEV_PID=""
FIXTURE_PID=""
mkdir -p "$WORK"

cleanup() {
  [ -n "$FIXTURE_PID" ] && kill "$FIXTURE_PID" 2>/dev/null || true
  if [ -n "$DEV_PID" ]; then pkill -f "$TMP/wrangler.jsonc" 2>/dev/null || true; kill "$DEV_PID" 2>/dev/null || true; wait "$DEV_PID" 2>/dev/null || true; fi
  [ "${KEEP:-}" = 1 ] && echo "kept $TMP" || rm -rf "$TMP"
}
trap cleanup EXIT

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf '\033[31mFAIL: %s\033[0m\n' "$*"; echo "--- dev log ---"; tail -30 "$LOG" || true; exit 1; }
ok() { printf '\033[32mok\033[0m %s\n' "$*"; }

cat > "$TMP/wrangler.jsonc" <<EOF
{
  "name": "southbag-git-freeze-it",
  "main": "entry.ts",
  "compatibility_date": "2026-08-15",
  "compatibility_flags": ["nodejs_compat"],
  "limits": { "cpu_ms": 30000 },
  "d1_databases": [
    { "binding": "DB", "database_name": "southbag-git", "database_id": "00000000-0000-0000-0000-000000000000",
      "migrations_dir": "$ROOT/migrations" }
  ]
}
EOF
cat > "$TMP/entry.ts" <<EOF
import { Hono } from '$ROOT/node_modules/hono/dist/index.js';
import git from '$ROOT/src/routes/git';
const app = new Hono<any>();
app.route('/', git);
export default app;
EOF

WR=(npx --prefix "$ROOT" wrangler)
step "migrate + seed"
(cd "$ROOT" && "${WR[@]}" d1 migrations apply DB --local --persist-to "$STATE" -c "$TMP/wrangler.jsonc" >/dev/null)
now=$(date +%s)000
hash=$(node -e "console.log(require('crypto').createHash('sha256').update('sbg_dev_alice').digest('base64url'))")
(cd "$ROOT" && "${WR[@]}" d1 execute DB --local --persist-to "$STATE" -c "$TMP/wrangler.jsonc" --command "
INSERT INTO users (id, username, name, email, created_at, updated_at) VALUES ('dev-alice', 'alice', 'Alice', 'alice@example.com', $now, $now);
INSERT INTO repos (id, owner_id, name, network_id, created_at, updated_at) VALUES ('r-test', 'dev-alice', 'test', 'n-test', $now, $now);
INSERT INTO access_tokens (id, user_id, name, token_hash, last_four, created_at, expires_at) VALUES ('dev-token-alice', 'dev-alice', 'Development', '$hash', 'ev_a', $now, 9999999999999);
INSERT INTO requests (id, repo_id, kind, requester_id, status, decided_by, decided_at, created_at) VALUES
  ('req-push-1', 'r-test', 'push', 'dev-alice', 'approved', 'dev-alice', $now, $now),
  ('req-push-2', 'r-test', 'push', 'dev-alice', 'approved', 'dev-alice', $now, $now),
  ('req-pull-1', 'r-test', 'pull', 'dev-alice', 'approved', 'dev-alice', $now, $now);
" >/dev/null)
ok "database ready (alice + repo test + token sbg_dev_alice)"

start_fixture() { FIXTURE_SECRET=itsec node "$ROOT/test-fixtures/identity-fixture.mjs" "$FIXTURE_PORT" "$1" >"$TMP/fixture.log" 2>&1 & FIXTURE_PID=$!; sleep 1; }
stop_fixture() { [ -n "$FIXTURE_PID" ] && kill "$FIXTURE_PID" 2>/dev/null || true; wait "$FIXTURE_PID" 2>/dev/null || true; FIXTURE_PID=""; }

step "identity fixture (active) + wrangler dev on :$PORT"
start_fixture active
(cd "$ROOT" && exec "${WR[@]}" dev -c "$TMP/wrangler.jsonc" --persist-to "$STATE" --port "$PORT" \
  --var IDENTITY_ORIGIN:http://127.0.0.1:$FIXTURE_PORT --var IDENTITY_INTERNAL_SECRET:itsec --var BANKING_DEV:1 >"$LOG" 2>&1) &
DEV_PID=$!
for i in $(seq 1 60); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/alice/test.git/info/refs?service=git-upload-pack" && break
  sleep 1
  [ "$i" = 60 ] && fail "wrangler dev did not start"
done
ok "started"

URL="http://alice:sbg_dev_alice@127.0.0.1:$PORT/alice/test.git"
export GIT_TERMINAL_PROMPT=0 GIT_AUTHOR_NAME=Alice GIT_AUTHOR_EMAIL=alice@example.com GIT_COMMITTER_NAME=Alice GIT_COMMITTER_EMAIL=alice@example.com
# Fixed midday-weekday commit dates keep the service's own fraud heuristics (unusual hour,
# weekend activity) out of this test's way; the rapid-activity rule is handled with the sleep below.
export GIT_AUTHOR_DATE="2026-10-27T12:00:00+1000" GIT_COMMITTER_DATE="2026-10-27T12:00:00+1000"
G=(git -c init.defaultBranch=main -c protocol.version=2 -c advice.detachedHead=false)
REFS="http://alice:sbg_dev_alice@127.0.0.1:$PORT/alice/test.git/info/refs?service=git-upload-pack"
RECV="http://alice:sbg_dev_alice@127.0.0.1:$PORT/alice/test.git/info/refs?service=git-receive-pack"
cd "$WORK"

expect_blocked() { # $1 label, $2 message fragment; asserts read+write refused with that text
  local out
  out=$(curl -s "$REFS")
  grep -q "$2" <<<"$out" || fail "$1: fetch advertisement missing '$2': $out"
  out=$(curl -s "$RECV")
  grep -q "$2" <<<"$out" || fail "$1: push advertisement missing '$2': $out"
  if "${G[@]}" ls-remote "$URL" >/dev/null 2>&1; then fail "$1: git ls-remote SUCCEEDED"; fi
  ok "$1: read and write refused ($2)"
}

step "active: clone + push work"
"${G[@]}" clone -q "$URL" work-clone || fail "clone failed while active"
cd work-clone && echo hello > a.txt && "${G[@]}" add a.txt && "${G[@]}" commit -qm init
"${G[@]}" push -q origin main || fail "push failed while active"
cd "$WORK"
ok "clone + push succeeded"

step "frozen: read and write refused"
stop_fixture; start_fixture frozen
expect_blocked "frozen" "Your account is frozen pending review"

step "secret rejected (403): fails closed"
stop_fixture; start_fixture reject
expect_blocked "reject" "Identity is unavailable"

step "identity down: fails closed"
stop_fixture
expect_blocked "down" "Identity is unavailable"

step "active again: works (no stale cache)"
start_fixture active
# The service freezes accounts for two pushes within 90 seconds (rapid activity); wait it out.
sleep 95
"${G[@]}" ls-remote "$URL" >/dev/null 2>&1 || fail "ls-remote failed after recovery"
cd work-clone && echo world >> a.txt && "${G[@]}" commit -qam more
"${G[@]}" push -q origin main || fail "push failed after recovery"
ok "recovered"

printf '\n\033[32mAll freeze integration checks passed.\033[0m\n'
