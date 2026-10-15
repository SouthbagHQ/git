#!/usr/bin/env bash
# Smoke test for the git engine (src/git/**, src/routes/git.ts) against real git.
#
#   bash scripts/git-smoke.sh            # KEEP=1 keeps the temp dir, PORT=8799 by default
#
# It runs its own throwaway Worker (a temp wrangler config whose entry mounts only
# src/routes/git.ts plus a few dev-only unit-check routes), so it does not depend on the rest of
# the app. Policy is switched off with the dev-only hook in src/routes/git.ts:
# --var GIT_DEV_POLICY:off --var GIT_DEV_USER:dev-alice (localhost only).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8799}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/southbag-git-smoke.XXXXXX")"
STATE="$TMP/state"
WORK="$TMP/work"
LOG="$TMP/dev.log"
DEV_PID=""
mkdir -p "$WORK"

cleanup() {
  if [ -n "$DEV_PID" ]; then
    pkill -f "$TMP/wrangler.jsonc" 2>/dev/null || true
    kill "$DEV_PID" 2>/dev/null || true
    wait "$DEV_PID" 2>/dev/null || true
  fi
  if [ "${KEEP:-}" = 1 ]; then echo "kept $TMP"; else rm -rf "$TMP"; fi
}
trap cleanup EXIT

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf '\033[31mFAIL: %s\033[0m\n' "$*"; echo "--- dev log ---"; tail -50 "$LOG" || true; exit 1; }
ok() { printf '\033[32mok\033[0m %s\n' "$*"; }

cat > "$TMP/wrangler.jsonc" <<EOF
{
  "name": "southbag-git-smoke",
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

# Dev-only unit checks for mergeCommits / diffCommit live only in this temp entry.
cat > "$TMP/entry.ts" <<EOF
import { Hono } from '$ROOT/node_modules/hono/dist/index.js';
import git from '$ROOT/src/routes/git';
import { ObjectStore } from '$ROOT/src/git/store';
import { initialCommit, writeCommit, writeFiles } from '$ROOT/src/git/write';
import { mergeCommits } from '$ROOT/src/git/merge';
import { diffCommit } from '$ROOT/src/git/diff';

const app = new Hono<any>();
app.get('/__smoke/units', async (c) => {
  const errors: string[] = [];
  const check = (cond: boolean, msg: string) => { if (!cond) errors.push(msg); };
  const store = new ObjectStore(c.env, 'smoke-units');
  const who = { name: 'Alice', email: 'alice@example.com', time: 1700000000, tz: '+1000' };
  const later = (n: number) => ({ ...who, time: who.time + n });
  const base = await initialCommit(store, { 'a.txt': 'one\ntwo\nthree\n', 'b.txt': 'b\n', 'dir/c.txt': 'c\n', 'same.txt': 's\n' }, who);
  const mk = async (parent: string, files: Record<string, string>, t: number) =>
    writeCommit(store, { tree: await writeFiles(store, files), parents: [parent], author: later(t), message: 'x' });
  // ours: edits a.txt, deletes b.txt. theirs: edits dir/c.txt, edits b.txt (modify/delete conflict), adds d.txt
  const ours = await mk(base, { 'a.txt': 'one\nTWO\nthree\n', 'dir/c.txt': 'c\n', 'same.txt': 's\n', 'both.txt': 'x\n' }, 10);
  const theirs = await mk(base, { 'a.txt': 'one\ntwo\nthree\n', 'b.txt': 'B\n', 'dir/c.txt': 'C\n', 'same.txt': 's\n', 'd.txt': 'd\n', 'both.txt': 'y\n' }, 20);
  check((await store.mergeBase(ours, theirs)) === base, 'mergeBase');
  check(await store.isAncestor(base, ours), 'isAncestor base ours');
  check(!(await store.isAncestor(ours, theirs)), 'not ancestor');
  const ff = await mergeCommits(store, { ours: base, theirs: ours });
  check(ff.fastForward && ff.conflicts.length === 0, 'fast-forward');
  const up = await mergeCommits(store, { ours, theirs: base });
  check(up.upToDate, 'up to date');
  const pickOurs = await mergeCommits(store, { ours, theirs, rng: () => 0 });
  const filesOurs = Object.fromEntries((await store.listTreeRecursive(pickOurs.tree)).map((f) => [f.path, f.oid]));
  check(JSON.stringify(pickOurs.conflicts) === JSON.stringify(['b.txt', 'both.txt']), 'conflicts ' + JSON.stringify(pickOurs.conflicts));
  check(!('b.txt' in filesOurs), 'ours deletion wins');
  check('d.txt' in filesOurs && 'dir/c.txt' in filesOurs && 'a.txt' in filesOurs, 'merged files present');
  const getText = async (tree: string, p: string) => new TextDecoder().decode((await store.readBlob((await store.entryAt(tree, p))!.oid))!);
  check((await getText(pickOurs.tree, 'a.txt')) === 'one\nTWO\nthree\n', 'a.txt from ours');
  check((await getText(pickOurs.tree, 'dir/c.txt')) === 'C\n', 'c.txt from theirs');
  check((await getText(pickOurs.tree, 'both.txt')) === 'x\n', 'both.txt from ours');
  const pickTheirs = await mergeCommits(store, { ours, theirs, rng: () => 0.9 });
  check((await getText(pickTheirs.tree, 'b.txt')) === 'B\n', 'b.txt from theirs');
  check((await getText(pickTheirs.tree, 'both.txt')) === 'y\n', 'both.txt from theirs');
  const d = await diffCommit(store, ours);
  const byPath = Object.fromEntries(d.files.map((f) => [f.path, f]));
  check(byPath['a.txt']?.status === 'modified' && byPath['a.txt'].added === 1 && byPath['a.txt'].deleted === 1, 'diff a.txt');
  check(byPath['a.txt']?.hunks[0]?.header === '@@ -1,3 +1,3 @@', 'hunk header ' + byPath['a.txt']?.hunks[0]?.header);
  check(byPath['b.txt']?.status === 'deleted' && byPath['both.txt']?.status === 'added', 'diff statuses');
  check(!byPath['same.txt'], 'unchanged not listed');
  const lines = byPath['a.txt'].hunks[0].lines.map((l) => l.kind + l.text).join('|');
  check(lines === ' one|-two|+TWO| three', 'diff lines ' + lines);
  // Larger diff: 2000 lines, a few edits.
  const big = Array.from({ length: 2000 }, (_, i) => 'line ' + i);
  const big2 = big.slice(); big2[10] = 'changed'; big2.splice(1500, 3); big2.push('end');
  const c1 = await mk(base, { 'big.txt': big.join('\n') + '\n' }, 30);
  const c2 = await mk(c1, { 'big.txt': big2.join('\n') + '\n' }, 40);
  const bd = await diffCommit(store, c2);
  check(bd.files[0]?.added === 2 && bd.files[0]?.deleted === 4 && bd.files[0].hunks.length === 3, 'big diff ' + JSON.stringify({ a: bd.files[0]?.added, d: bd.files[0]?.deleted, h: bd.files[0]?.hunks.length }));
  check((await store.log(c2, { limit: 10 })).length === 3, 'log length');
  check((await store.log(c2, { path: 'big.txt' })).length === 2, 'log path');
  check((await store.countCommits(c2)) === 3, 'countCommits');
  return c.text(errors.length ? 'FAIL\n' + errors.join('\n') + '\n' : 'ok\n');
});
app.route('/', git);
export default app;
EOF

WR=(npx --prefix "$ROOT" wrangler)
step "migrate"
(cd "$ROOT" && "${WR[@]}" d1 migrations apply DB --local --persist-to "$STATE" -c "$TMP/wrangler.jsonc" >/dev/null)
now=$(date +%s)000
(cd "$ROOT" && "${WR[@]}" d1 execute DB --local --persist-to "$STATE" -c "$TMP/wrangler.jsonc" --command "
INSERT INTO users (id, username, name, email, created_at, updated_at) VALUES ('dev-alice', 'alice', 'Alice', 'alice@example.com', $now, $now);
INSERT INTO repos (id, owner_id, name, network_id, created_at, updated_at) VALUES ('r-test', 'dev-alice', 'test', 'n-test', $now, $now);
INSERT INTO repos (id, owner_id, name, network_id, forked_from, created_at, updated_at) VALUES ('r-fork', 'dev-alice', 'fork', 'n-test', 'r-test', $now, $now);
" >/dev/null)
ok "database ready"

step "wrangler dev on :$PORT"
(cd "$ROOT" && exec "${WR[@]}" dev -c "$TMP/wrangler.jsonc" --persist-to "$STATE" --port "$PORT" \
  --var GIT_DEV_POLICY:off --var GIT_DEV_USER:dev-alice >"$LOG" 2>&1) &
DEV_PID=$!
for i in $(seq 1 60); do
  if curl -s -o /dev/null "http://localhost:$PORT/alice/test.git/info/refs?service=git-upload-pack"; then break; fi
  sleep 1
  [ "$i" = 60 ] && fail "wrangler dev did not start"
done
ok "started"

URL="http://x:y@localhost:$PORT/alice/test.git"
export GIT_TERMINAL_PROMPT=0 GIT_AUTHOR_NAME=Alice GIT_AUTHOR_EMAIL=alice@example.com GIT_COMMITTER_NAME=Alice GIT_COMMITTER_EMAIL=alice@example.com
G=(git -c init.defaultBranch=main -c protocol.version=2 -c advice.detachedHead=false)
cd "$WORK"

step "unit checks (merge, diff, log)"
out=$(curl -s "http://localhost:$PORT/__smoke/units")
[ "$out" = ok ] || fail "unit checks: $out"
ok "mergeCommits / diffCommit / log"

step "404 for unknown repo"
code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/alice/nope.git/info/refs?service=git-upload-pack")
[ "$code" = 404 ] || fail "expected 404, got $code"
ok "404"

step "clone empty repository"
"${G[@]}" clone -q "$URL" c1 2>&1 | tee "$TMP/clone1.txt"
grep -q "empty repository" "$TMP/clone1.txt" || fail "expected empty-repository warning"
ok "empty clone"

step "first push"
cd c1
mkdir -p src docs
for i in $(seq 1 4000); do echo "line $i of a large-ish file that will be delta-compressed later"; done > big.txt
echo "# test" > README.md
echo "console.log('hi')" > src/index.js
printf '\x00\x01\x02binary' > docs/blob.bin
"${G[@]}" add -A && "${G[@]}" commit -qm "Initial commit"
"${G[@]}" push -q origin main 2>&1 | tee "$TMP/push1.txt"
[ "$("${G[@]}" ls-remote origin refs/heads/main | cut -f1)" = "$("${G[@]}" rev-parse HEAD)" ] || fail "main not updated"
grep -q "remote: Southbag Git" "$TMP/push1.txt" || fail "no remote: message on push"
ok "pushed $(git rev-parse --short HEAD)"
cd ..

step "clone again and verify"
"${G[@]}" clone -q "$URL" c2
diff -r --exclude=.git c1 c2 || fail "content differs"
[ "$(git -C c2 rev-parse HEAD)" = "$(git -C c1 rev-parse HEAD)" ] || fail "HEAD differs"
git -C c2 fsck --full --no-progress || fail "fsck"
ok "clone matches"

step "second push (thin pack with deltas)"
cd c1
sed -i.bak 's/^line 2000 of/LINE 2000 OF/' big.txt && rm big.txt.bak
echo "line 4001" >> big.txt
"${G[@]}" commit -qam "Edit big file"
GIT_TRACE_PACKET=0 "${G[@]}" push -v origin main 2>&1 | tee "$TMP/push2.txt"
[ "$("${G[@]}" ls-remote origin refs/heads/main | cut -f1)" = "$("${G[@]}" rev-parse HEAD)" ] || fail "main not updated after delta push"
cd ..
grep -q "LINE 2000" c1/big.txt
ok "delta push"

step "fetch into the second clone (gzip request bodies)"
cd c2
"${G[@]}" checkout -qb side
for i in $(seq 1 60); do echo "$i" > "side-$i.txt"; "${G[@]}" add "side-$i.txt"; "${G[@]}" commit -qm "side $i"; done
"${G[@]}" checkout -q main
GIT_TRACE_CURL=1 GIT_TRACE_CURL_NO_DATA=1 "${G[@]}" -c protocol.version=0 fetch origin 2>"$TMP/fetch.trace"
grep -qi "content-encoding: gzip" "$TMP/fetch.trace" || fail "fetch did not send a gzip body"
"${G[@]}" merge -q --ff-only origin/main
[ "$("${G[@]}" rev-parse HEAD)" = "$(git -C ../c1 rev-parse HEAD)" ] || fail "fetch did not bring the new commit"
grep -q "LINE 2000" big.txt || fail "big.txt not updated"
"${G[@]}" fsck --full --no-progress || fail "fsck after fetch"
cd ..
ok "fetch (gzip) works"

step "push of a side branch with many commits, then incremental fetch"
cd c2
"${G[@]}" push -q origin side
cd ../c1
"${G[@]}" fetch -q origin
[ "$("${G[@]}" rev-parse origin/side)" = "$(git -C ../c2 rev-parse side)" ] || fail "side branch fetch"
cd ..
ok "side branch"

step "force push"
cd c1
"${G[@]}" reset -q --hard HEAD~1
echo "rewritten" > rewritten.txt
"${G[@]}" add rewritten.txt && "${G[@]}" commit -qm "Rewritten history"
"${G[@]}" push -q origin main 2>/dev/null && fail "non-fast-forward push should be rejected by git"
"${G[@]}" push -qf origin main
[ "$("${G[@]}" ls-remote origin refs/heads/main | cut -f1)" = "$("${G[@]}" rev-parse HEAD)" ] || fail "force push"
cd ..
ok "force push"

step "create and delete a branch"
cd c1
"${G[@]}" push -q origin HEAD:refs/heads/tmp
[ -n "$("${G[@]}" ls-remote origin refs/heads/tmp)" ] || fail "tmp not created"
"${G[@]}" push -q origin --delete tmp
[ -z "$("${G[@]}" ls-remote origin refs/heads/tmp)" ] || fail "tmp not deleted"
cd ..
ok "branch delete"

step "branch with ~50 files"
cd c1
"${G[@]}" checkout -qb many
mkdir -p many/a many/b
for i in $(seq 1 25); do echo "a $i" > "many/a/f$i.txt"; echo "b $i" > "many/b/f$i.txt"; done
# Two near-identical new large files in one push: git sends one as an OFS_DELTA of the other.
for i in $(seq 1 3000); do echo "shared line $i with enough text to make deltas worthwhile"; done > many/copy1.txt
sed 's/^shared line 1500 /changed line 1500 /' many/copy1.txt > many/copy2.txt
"${G[@]}" add -A && "${G[@]}" commit -qm "Fifty files"
"${G[@]}" push -q origin many
cd ..
"${G[@]}" clone -q -b many "$URL" c3
[ "$(ls c3/many/a c3/many/b | grep -c txt)" = 50 ] || fail "50 files"
cmp c1/many/copy2.txt c3/many/copy2.txt || fail "OFS_DELTA object content"
git -C c3 fsck --full --no-progress || fail "fsck c3"
ok "50 files"

step "annotated tag"
cd c1
"${G[@]}" tag -a v1 -m "Version 1"
"${G[@]}" push -q origin v1
cd ../c2
"${G[@]}" fetch -q --tags origin
[ "$("${G[@]}" rev-parse v1^{commit})" = "$(git -C ../c1 rev-parse v1^{commit})" ] || fail "tag fetch"
cd ..
ok "tags"

step "floor-3"
"${G[@]}" clone -q "$URL" c4
cd c4
"${G[@]}" checkout -q floor-3
[ -f keycard.txt ] && [ -f rack/F3-01/inventory.txt ] && [ -f network/traffic.log ] || fail "floor-3 files"
[ "$("${G[@]}" log -1 --format='%an <%ae> %s')" = "Kevin <Kevin@southbag.cc> There is no Floor 3." ] || fail "floor-3 commit"
cat README.md
"${G[@]}" commit -q --allow-empty -m "Floor 3"
if "${G[@]}" push origin floor-3 2>"$TMP/f3.txt"; then fail "push to floor-3 accepted"; fi
grep -q "branch does not exist" "$TMP/f3.txt" || { cat "$TMP/f3.txt"; fail "floor-3 rejection message"; }
cd ..
f3_a=$(git -C c4 rev-parse origin/floor-3)
git -C c1 push -q "http://x:y@localhost:$PORT/alice/fork.git" main
f3_b=$(git ls-remote "http://x:y@localhost:$PORT/alice/fork.git" refs/heads/floor-3 | cut -f1)
[ "$f3_a" = "$f3_b" ] || fail "floor-3 differs between repositories"
ok "floor-3 checkout, push rejected, identical everywhere"

step "protocol v0 explicitly"
"${G[@]}" -c protocol.version=0 clone -q "$URL" c6
[ "$(git -C c6 rev-parse HEAD)" = "$(git -C c1 rev-parse main)" ] || fail "v0 clone"
ok "v0 clone"

printf '\n\033[32mALL GIT SMOKE TESTS PASSED\033[0m\n'
