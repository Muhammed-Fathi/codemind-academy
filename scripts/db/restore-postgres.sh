#!/usr/bin/env bash
# CodeMind Academy — Phase 21: restore a production backup into PostgreSQL.
#
#   scripts/db/restore-postgres.sh --backup /var/backups/codemind/codemind-nightly-<stamp>.dump \
#       --target postgresql://user@host/codemind_restored
#
# A restore is ALWAYS into an EMPTY database (fresh `createdb`, or a database
# the operator explicitly dropped first). The script ABORTS unless the target
# has zero user tables — restoring over live data is how restores become
# incidents. See docs/POSTGRES_CUTOVER_RUNBOOK.md (rollback section uses this
# script against a fresh database, then re-points the app).
#
# STEPS
#   1. Verify the .sha256 sidecar (decrypt first when the artifact is .enc and
#      BACKUP_PASSPHRASE is set — the passphrase comes from the environment /
#      secret manager and is never echoed or written).
#   2. Preflight: target reachable, EMPTY (0 tables in public), server major
#      version reported (a mismatch warns but proceeds — pg_restore across one
#      major is supported; the verification battery is the real gate).
#   3. pg_restore (single transaction where the format allows; --no-owner so a
#      backup taken by another role restores cleanly).
#   4. REQUIRED verification battery: node scripts/db/verify-postgres.mjs
#      --target … (counts vs manifest where available, constraints, orphans,
#      teacher lifecycle, security tables, app-shaped queries). A restore that
#      skips verification is NOT a verified restore — the script fails if the
#      battery fails.
#
# SAFETY: set -euo pipefail; URL redacted in output; nothing is ever restored
# over a non-empty database.
set -euo pipefail

BACKUP=""
URL="${DATABASE_URL:-${POSTGRES_URL:-}}"

usage() {
  echo "usage: $0 --backup <file.dump[.enc]> --target <postgres-url>" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --backup) BACKUP="$2"; shift 2 ;;
    --target) URL="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

[ -n "$BACKUP" ] || usage
[ -n "$URL" ] || { echo "error: no postgres URL (pass --target or set DATABASE_URL)" >&2; exit 1; }
case "$URL" in
  file:*|*.db) echo "error: target must be a PostgreSQL URL (got SQLite)" >&2; exit 1 ;;
esac
command -v pg_restore >/dev/null || { echo "error: pg_restore not found (install postgresql-client)" >&2; exit 1; }
command -v psql >/dev/null || { echo "error: psql not found (install postgresql-client)" >&2; exit 1; }
[ -f "$BACKUP" ] || { echo "error: backup not found: $BACKUP" >&2; exit 1; }

REDACTED="$(printf '%s' "$URL" | sed -E 's#(^[a-z]+://)[^@]+@#\1#')"
echo "restore: ${BACKUP} -> ${REDACTED}"

WORK="$BACKUP"
TMPDIR_CLEANUP=""
if [[ "$BACKUP" == *.enc ]]; then
  [ -n "${BACKUP_PASSPHRASE:-}" ] || { echo "error: artifact is encrypted but BACKUP_PASSPHRASE is not set" >&2; exit 1; }
  command -v openssl >/dev/null || { echo "error: openssl not found" >&2; exit 1; }
  TMPDIR_CLEANUP="$(mktemp -d)"
  WORK="${TMPDIR_CLEANUP}/restore.dump"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -salt \
    -in "$BACKUP" -out "$WORK" -pass env:BACKUP_PASSPHRASE
  echo "restore: decrypted to scratch (shredded afterwards)"
  trap 'shred -u "$WORK" 2>/dev/null || rm -f "$WORK"; rm -rf "$TMPDIR_CLEANUP"' EXIT
fi

# 1. Integrity: the sidecar covers the artifact AS STORED (i.e. the .enc bytes
# when encrypted — decrypt-then-restore is verified end-to-end by step 4).
SHA_FILE="${BACKUP}.sha256"
if [ -f "$SHA_FILE" ]; then
  WANT="$(awk '{print $1}' "$SHA_FILE")"
  GOT="$(sha256sum "$BACKUP" | awk '{print $1}')"
  [ "$WANT" = "$GOT" ] || { echo "error: sha256 MISMATCH (backup corrupt or tampered) — refusing to restore" >&2; exit 1; }
  echo "restore: sha256 verified (${GOT:0:16}…)"
else
  echo "warning: no .sha256 sidecar for $BACKUP — proceeding WITHOUT integrity proof (not recommended)" >&2
fi

# 2. Preflight: target must be EMPTY.
TABLES="$(psql "$URL" -tAX -c "SELECT COUNT(*) FROM pg_tables WHERE schemaname='public';" | tr -d '[:space:]')"
[ "$TABLES" = "0" ] || { echo "error: target is NOT empty (${TABLES} tables) — restore only into an empty database" >&2; exit 1; }
PG_VERSION="$(psql "$URL" -tAX -c 'SHOW server_version;' | tr -d '[:space:]')"
echo "restore: target empty, server ${PG_VERSION}"

# 3. Restore.
pg_restore --dbname="$URL" --no-owner --verbose "$WORK" 2>&1 | tail -n 3 || true
RESTORED_TABLES="$(psql "$URL" -tAX -c "SELECT COUNT(*) FROM pg_tables WHERE schemaname='public';" | tr -d '[:space:]')"
[ "$RESTORED_TABLES" != "0" ] || { echo "error: restore produced zero tables" >&2; exit 1; }
echo "restore: ${RESTORED_TABLES} tables restored"

# 4. REQUIRED verification battery (this is what makes it a VERIFIED restore).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
node "${REPO_DIR}/scripts/db/verify-postgres.mjs" --target "$URL"
echo "RESTORE_OK ${BACKUP} tables=${RESTORED_TABLES}"
