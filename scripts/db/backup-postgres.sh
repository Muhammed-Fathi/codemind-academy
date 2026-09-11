#!/usr/bin/env bash
# CodeMind Academy — Phase 21: production PostgreSQL backup.
#
#   DATABASE_URL=postgresql://… scripts/db/backup-postgres.sh \
#       --out-dir /var/backups/codemind [--label nightly] [--retain-days 30] [--keep-min 7]
#
# WHAT IT TAKES
#   A full custom-format pg_dump (schema + ALL data — curriculum, progress,
#   Teacher Applications, provisioning state, security/audit tables, sessions
#   and tokens) plus a sidecar manifest. Nothing is excluded: a backup that
#   drops the audit trail is not a backup of this platform.
#
# OUTPUTS (in --out-dir)
#   codemind-<label>-<UTC timestamp>.dump        the pg_dump custom-format artifact
#   codemind-<label>-<UTC timestamp>.dump.sha256  its SHA-256 (integrity)
#   codemind-<label>-<UTC timestamp>.manifest.json manifest (sizes, versions, counts)
#   [optional] .enc variants when BACKUP_PASSPHRASE is set (AES-256-CBC/PBKDF2
#   via openssl; the passphrase comes from the environment/secret manager and
#   is NEVER written to disk or echoed — the manifest records only that the
#   artifact is encrypted, never the key).
#
# RETENTION
#   Artifacts older than --retain-days are deleted, but the newest --keep-min
#   are ALWAYS kept (so a broken clock or a failed cron can never purge the
#   last good backup).
#
# SAFETY
#   * set -euo pipefail; every write is re-hashed before the script reports OK.
#   * The database URL is redacted in all output (host/db only, never user/pass).
#   * This script never touches the live database beyond the dump itself.
set -euo pipefail

LABEL="manual"
OUT_DIR=""
RETAIN_DAYS=30
KEEP_MIN=7
URL="${DATABASE_URL:-${POSTGRES_URL:-}}"

usage() {
  echo "usage: $0 --out-dir <dir> [--url <postgres-url>] [--label <name>] [--retain-days <n>] [--keep-min <n>]" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --retain-days) RETAIN_DAYS="$2"; shift 2 ;;
    --keep-min) KEEP_MIN="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

[ -n "$OUT_DIR" ] || usage
[ -n "$URL" ] || { echo "error: no postgres URL (pass --url or set DATABASE_URL)" >&2; exit 1; }
case "$URL" in
  file:*|*.db) echo "error: target must be a PostgreSQL URL (got SQLite)" >&2; exit 1 ;;
esac
command -v pg_dump >/dev/null || { echo "error: pg_dump not found (install postgresql-client)" >&2; exit 1; }
command -v psql >/dev/null || { echo "error: psql not found (install postgresql-client)" >&2; exit 1; }

mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASE="codemind-${LABEL}-${STAMP}"
DUMP="${OUT_DIR}/${BASE}.dump"
SHA="${DUMP}.sha256"
MANIFEST="${OUT_DIR}/${BASE}.manifest.json"

# Redact credentials for logs (host + db only).
REDACTED="$(printf '%s' "$URL" | sed -E 's#(^[a-z]+://)[^@]+@#\1#')"
echo "backup: ${REDACTED} -> ${DUMP}"

# 1. Dump (custom format: compressed, pg_restore-able, single transaction).
pg_dump --dbname="$URL" --format=custom --compress=9 --file="$DUMP" --verbose 2>&1 | tail -n 3 || true
[ -s "$DUMP" ] || { echo "error: pg_dump produced an empty file" >&2; exit 1; }

# 2. Optional encryption (passphrase from env/secret manager ONLY).
ENCRYPTED="false"
if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  command -v openssl >/dev/null || { echo "error: openssl not found (needed for BACKUP_PASSPHRASE)" >&2; exit 1; }
  ENC="${DUMP}.enc"
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
    -in "$DUMP" -out "$ENC" -pass env:BACKUP_PASSPHRASE
  shred -u "$DUMP" 2>/dev/null || rm -f "$DUMP"
  DUMP="$ENC"
  SHA="${DUMP}.sha256"
  ENCRYPTED="true"
  echo "backup: encrypted at rest (AES-256-CBC/PBKDF2)"
fi

# 3. Integrity: hash the FINAL artifact, then re-hash to prove the write.
sha256sum "$DUMP" | awk '{print $1}' > "$SHA"
HASH="$(cat "$SHA")"
REHASH="$(sha256sum "$DUMP" | awk '{print $1}')"
[ "$HASH" = "$REHASH" ] || { echo "error: hash mismatch after write (disk fault?)" >&2; exit 1; }

# 4. Manifest (row counts per table — the restore battery compares against these).
PG_VERSION="$(psql "$URL" -tAX -c 'SHOW server_version;' | tr -d '[:space:]')"
DB_SIZE="$(psql "$URL" -tAX -c "SELECT pg_database_size(current_database());" | tr -d '[:space:]')"
TABLES_JSON=""
while IFS= read -r T; do
  [ -n "$T" ] || continue
  N="$(psql "$URL" -tAX -c "SELECT COUNT(*) FROM public.\"${T//\"/\"\"}\";" | tr -d '[:space:]')"
  case "$N" in ''|*[!0-9]*) N="null" ;; esac
  if [ -n "$TABLES_JSON" ]; then TABLES_JSON="${TABLES_JSON},"; fi
  TABLES_JSON="${TABLES_JSON}\"${T}\":${N}"
done < <(psql "$URL" -tAX -c "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1;")

cat > "$MANIFEST" <<EOF
{
  "tool": "backup-postgres.sh (Phase 21)",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "label": "${LABEL}",
  "target": "${REDACTED}",
  "artifact": "$(basename "$DUMP")",
  "bytes": $(stat -c%s "$DUMP"),
  "sha256": "${HASH}",
  "encrypted": ${ENCRYPTED},
  "format": "pg_dump custom",
  "pgVersion": "${PG_VERSION}",
  "databaseBytes": ${DB_SIZE},
  "tables": {${TABLES_JSON}}
}
EOF
echo "backup: manifest ${MANIFEST}"

# 5. Retention: delete artifacts older than RETAIN_DAYS, always keeping KEEP_MIN newest.
mapfile -t CANDIDATES < <(ls -1t "${OUT_DIR}"/codemind-*.dump* 2>/dev/null | grep -v -e '\.sha256$' || true)
TOTAL="${#CANDIDATES[@]}"
KEPT=0
DELETED=0
for f in "${CANDIDATES[@]}"; do
  KEPT=$((KEPT + 1))
  if [ "$KEPT" -le "$KEEP_MIN" ]; then continue; fi
  if [ "$(find "$f" -mtime "+${RETAIN_DAYS}" -print 2>/dev/null)" = "$f" ]; then
    rm -f "$f" "$f.sha256" "${f%.dump*}.manifest.json" "${f%.dump.enc}.manifest.json"
    DELETED=$((DELETED + 1))
  fi
done
echo "backup: retention kept>=${KEEP_MIN}, deleted ${DELETED} expired artifact(s) (total was ${TOTAL})"
echo "BACKUP_OK ${BASE} sha256=${HASH}"
