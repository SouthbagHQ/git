#!/usr/bin/env bash
# Seeds the LOCAL D1 database with test accounts, sessions and access tokens, so you can use the
# app under `wrangler dev` without a round trip to Southbag Identity.
#   npm run db:migrate:local && npm run seed:local
# Browser: set the cookie southbag_git_session=dev-alice (or dev-bob, dev-carol).
# Git:     git clone http://alice:sbg_dev_alice@localhost:8788/alice/<repo>.git
set -euo pipefail
cd "$(dirname "$0")/.."
sql=""
now=$(date +%s000)
hash() { node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('base64url'))" "$1"; }
for who in alice bob carol; do
  name="$(tr '[:lower:]' '[:upper:]' <<< "${who:0:1}")${who:1}"
  sql+="INSERT OR IGNORE INTO users (id, username, name, email, created_at, updated_at) VALUES ('dev-$who', '$who', '$name Southbag', '$who@example.com', $now, $now);"
  sql+="INSERT OR REPLACE INTO sessions (token_hash, user_id, expires_at, created_at) VALUES ('$(hash dev-$who)', 'dev-$who', 9999999999999, $now);"
  sql+="INSERT OR REPLACE INTO access_tokens (id, user_id, name, token_hash, last_four, created_at, expires_at) VALUES ('dev-token-$who', 'dev-$who', 'Development', '$(hash sbg_dev_$who)', 'ev_${who:0:1}', $now, 9999999999999);"
done
npx wrangler d1 execute DB --local ${PERSIST_TO:+--persist-to "$PERSIST_TO"} --command "$sql" > /dev/null
echo "Seeded. Cookies: southbag_git_session=dev-alice | dev-bob | dev-carol. Git tokens: sbg_dev_alice | sbg_dev_bob | sbg_dev_carol"
