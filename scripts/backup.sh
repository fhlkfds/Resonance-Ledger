#!/usr/bin/env bash
#
# Resonance Ledger logical backup.
#
# Writes a verified PostgreSQL custom-format dump to BACKUP_DIR, named with a
# UTC timestamp. The dump is streamed to a temporary file, checked with
# pg_restore --list, then atomically renamed into place with mode 0600.
#
# pg_dump alone is a logical backup, not point-in-time recovery. A backup is
# not operationally complete until a restore drill has succeeded; see
# docs/runbooks/backup-restore.md.
#
# Usage: scripts/backup.sh

set -euo pipefail

timestamp() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
info() { printf '[INFO] %s %s\n' "$(timestamp)" "$*"; }
ok()   { printf '[OK]   %s %s\n' "$(timestamp)" "$*"; }
error(){ printf '[ERROR] %s %s\n' "$(timestamp)" "$*" >&2; }

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
cd "$REPO_ROOT"

COMPOSE_FILE="${REPO_ROOT}/docker-compose.yml"
ENV_FILE="${REPO_ROOT}/.env"
TEMP_FILE=""

# shellcheck disable=SC2329  # invoked through the EXIT trap below
on_failure() {
  local code=$?
  [ "$code" -eq 0 ] && exit 0
  # Keep a non-empty partial file for diagnosis; discard an empty one.
  if [ -n "$TEMP_FILE" ] && [ -f "$TEMP_FILE" ]; then
    if [ -s "$TEMP_FILE" ]; then
      mv -f "$TEMP_FILE" "${TEMP_FILE}.failed" 2>/dev/null || true
      error "partial dump kept at ${TEMP_FILE}.failed for diagnosis"
    else
      rm -f "$TEMP_FILE" 2>/dev/null || true
    fi
  fi
  error "backup failed"
  exit "$code"
}
trap on_failure EXIT

# ------------------------------------------------------------- preflight ---

info "Preflight"

for required in "$COMPOSE_FILE" "${SCRIPT_DIR}/validate-env.mjs"; do
  [ -f "$required" ] || { error "incomplete checkout: missing ${required#"$REPO_ROOT"/}"; exit 1; }
done

command -v docker >/dev/null 2>&1 || { error "docker is not installed or not on PATH"; exit 1; }
docker info >/dev/null 2>&1 || { error "the Docker daemon is not reachable"; exit 1; }
docker compose version >/dev/null 2>&1 || { error "Docker Compose v2 is required"; exit 1; }

[ -f "$ENV_FILE" ] || { error ".env not found at ${ENV_FILE}"; exit 1; }
ENV_MODE="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE")"
case "$ENV_MODE" in
  *[1-7][0-7]|*[0-7][1-7])
    error ".env is group or world readable (mode ${ENV_MODE}); run: chmod 600 .env"
    exit 1 ;;
esac

# Share the deployment validator so both scripts agree on what is valid.
node "${SCRIPT_DIR}/validate-env.mjs" "$ENV_FILE" || {
  error "environment validation failed; no value was printed above"
  exit 1
}

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }
read_env() { sed -n "s/^${1}=//p" "$ENV_FILE" | head -n1 | sed 's/^["'\'']//; s/["'\'']$//'; }

POSTGRES_DB="$(read_env POSTGRES_DB)"
POSTGRES_USER="$(read_env POSTGRES_USER)"
BACKUP_DIR="$(read_env BACKUP_DIR)"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/resonance-ledger}"
BACKUP_RETENTION_DAYS="$(read_env BACKUP_RETENTION_DAYS)"

# --------------------------------------------------- backup directory ------

# Refuse a path that would scatter dumps across the filesystem or let the
# retention sweep loose somewhere dangerous.
case "$BACKUP_DIR" in
  "")   error "BACKUP_DIR is empty"; exit 1 ;;
  /)    error "BACKUP_DIR must not be the filesystem root"; exit 1 ;;
  /root|/home|/home/|/Users) error "BACKUP_DIR must not be a home root"; exit 1 ;;
  /*)   ;;
  *)    error "BACKUP_DIR must be an absolute path"; exit 1 ;;
esac
if [ "$BACKUP_DIR" = "$HOME" ]; then
  error "BACKUP_DIR must not be the current user's home directory"
  exit 1
fi

if [ ! -d "$BACKUP_DIR" ]; then
  info "creating backup directory with mode 0700"
  # -m with -p would only set the mode on the deepest component, leaving any
  # parent this script creates at the default umask.
  (umask 077 && mkdir -p "$BACKUP_DIR") || { error "cannot create ${BACKUP_DIR}"; exit 1; }
  chmod 0700 "$BACKUP_DIR" || { error "cannot secure ${BACKUP_DIR}"; exit 1; }
fi
[ -w "$BACKUP_DIR" ] || { error "${BACKUP_DIR} is not writable"; exit 1; }

RESOLVED_DIR="$(cd -- "$BACKUP_DIR" && pwd -P)" || { error "cannot resolve ${BACKUP_DIR}"; exit 1; }
case "$RESOLVED_DIR" in
  /) error "BACKUP_DIR resolves to the filesystem root"; exit 1 ;;
esac

# ------------------------------------------------------ database health ----

if ! compose ps --status running --services 2>/dev/null | grep -qx postgres; then
  error "the postgres service is not running; start it before taking a backup"
  exit 1
fi
POSTGRES_CONTAINER="$(compose ps -q postgres)"
DB_HEALTH="$(docker inspect "$POSTGRES_CONTAINER" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || echo unknown)"
if [ "$DB_HEALTH" != "healthy" ]; then
  error "PostgreSQL is not healthy (state: ${DB_HEALTH})"
  exit 1
fi
ok "Preflight"

# -------------------------------------------------------------- dump -------

STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
FINAL_FILE="${RESOLVED_DIR}/resonance-ledger_${STAMP}.dump"
TEMP_FILE="${RESOLVED_DIR}/.resonance-ledger_${STAMP}.dump.part"
STDERR_FILE="$(mktemp)"

info "dumping database to a temporary file in ${RESOLVED_DIR}"

# The password never appears on a command line or in the process table:
# pg_dump runs inside the container over the local socket, which the official
# image trusts for local connections.
set +e
compose exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-password \
  >"$TEMP_FILE" 2>"$STDERR_FILE"
DUMP_STATUS=$?
set -e

DUMP_STDERR="$(cat "$STDERR_FILE")"
rm -f "$STDERR_FILE"

if [ "$DUMP_STATUS" -ne 0 ]; then
  error "pg_dump exited ${DUMP_STATUS}"
  [ -n "$DUMP_STDERR" ] && printf '[ERROR]   %s\n' "$DUMP_STDERR" >&2
  exit 1
fi
if [ -n "$DUMP_STDERR" ]; then
  error "pg_dump reported errors on stderr"
  printf '[ERROR]   %s\n' "$DUMP_STDERR" >&2
  exit 1
fi
if [ ! -s "$TEMP_FILE" ]; then
  error "pg_dump produced an empty file"
  exit 1
fi

# ------------------------------------------------------------- verify ------

info "verifying the dump is readable"
# pg_restore cannot list a custom-format archive from stdin: it needs to seek,
# and it rejects "-" outright. The dump is copied into the container's own
# tmpfs, listed there, and removed again.
VERIFY_PATH="/tmp/resonance-verify-$$.dump"
VERIFY_OK=1
if compose exec -T postgres sh -c "cat > ${VERIFY_PATH}" <"$TEMP_FILE" 2>/dev/null; then
  compose exec -T postgres pg_restore --list "$VERIFY_PATH" >/dev/null 2>&1 || VERIFY_OK=0
else
  VERIFY_OK=0
fi
compose exec -T postgres rm -f "$VERIFY_PATH" >/dev/null 2>&1 || true
if [ "$VERIFY_OK" -ne 1 ]; then
  error "pg_restore --list could not read the dump; treating it as corrupt"
  exit 1
fi

BYTES="$(wc -c <"$TEMP_FILE" | tr -d ' ')"
CHECKSUM="$(sha256sum "$TEMP_FILE" 2>/dev/null | awk '{print $1}')"
[ -n "$CHECKSUM" ] || CHECKSUM="$(shasum -a 256 "$TEMP_FILE" | awk '{print $1}')"

# Atomic within the same directory, so a reader never sees a partial file.
chmod 0600 "$TEMP_FILE"
mv -f "$TEMP_FILE" "$FINAL_FILE"
TEMP_FILE=""
chmod 0600 "$FINAL_FILE"

ok "backup written"
info "file:      ${FINAL_FILE}"
info "bytes:     ${BYTES}"
info "sha256:    ${CHECKSUM}"
info "completed: $(timestamp)"

# ----------------------------------------------------------- retention -----

if [ -n "$BACKUP_RETENTION_DAYS" ]; then
  if ! printf '%s' "$BACKUP_RETENTION_DAYS" | grep -qE '^[1-9][0-9]*$'; then
    error "BACKUP_RETENTION_DAYS must be a positive integer"
    exit 1
  fi
  info "removing dumps older than ${BACKUP_RETENTION_DAYS} days"
  REMOVED=0
  # -maxdepth 1 and -type f keep the sweep inside the exact directory and
  # never follow a symlink out of it.
  while IFS= read -r -d '' stale; do
    rm -f -- "$stale" && REMOVED=$((REMOVED + 1))
  done < <(find "$RESOLVED_DIR" -maxdepth 1 -type f \
             -name 'resonance-ledger_*.dump' \
             -mtime "+${BACKUP_RETENTION_DAYS}" -print0 2>/dev/null)
  info "removed ${REMOVED} expired backup file(s)"
fi

ok "backup complete"
trap - EXIT
exit 0
