#!/usr/bin/env bash
#
# Resonance Ledger deployment and update orchestrator.
#
# Noninteractive and operator-safe. It validates configuration, brings up
# PostgreSQL, applies migrations, then replaces the app and worker, waiting
# for health at each step.
#
# It never runs `docker compose down`, never removes a volume, and never
# prunes. A failed deployment leaves the previous database volume intact.
#
# Usage: scripts/deploy.sh [--skip-build] [--no-backup]

set -euo pipefail

# --------------------------------------------------------------- console ---

timestamp() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
info() { printf '[INFO] %s %s\n' "$(timestamp)" "$*"; }
ok()   { printf '[OK]   %s %s\n' "$(timestamp)" "$*"; }
warn() { printf '[WARN] %s %s\n' "$(timestamp)" "$*" >&2; }
error(){ printf '[ERROR] %s %s\n' "$(timestamp)" "$*" >&2; }

CURRENT_STEP="startup"
DEPLOY_STARTED_AT="$(date +%s)"
step() { CURRENT_STEP="$1"; info "$1"; }

# --------------------------------------------------------------- redaction -

# Values that must never reach the console, even inside diagnostics.
SECRET_KEYS=(
  POSTGRES_PASSWORD SPOTIFY_CLIENT_SECRET SPOTIFY_CLIENT_ID
  SESSION_SECRET TOKEN_ENCRYPTION_KEY DATABASE_URL
)
REDACT_ARGS=()

build_redactor() {
  REDACT_ARGS=()
  local key value
  for key in "${SECRET_KEYS[@]}"; do
    # Read the raw assignment without sourcing or evaluating the file.
    value="$(sed -n "s/^${key}=//p" "$ENV_FILE" | head -n1 | sed 's/^["'\'']//; s/["'\'']$//')"
    if [ -n "$value" ] && [ "${#value}" -ge 8 ]; then
      REDACT_ARGS+=(-e "s|$(printf '%s' "$value" | sed 's/[]\/$*.^[]/\\&/g')|***REDACTED***|g")
    fi
  done
  # Common token shapes that may appear in provider or driver errors.
  REDACT_ARGS+=(-e 's/\(authorization: *\)[^ ]*/\1***REDACTED***/Ig')
  REDACT_ARGS+=(-e 's/\(Bearer \)[A-Za-z0-9._~+\/-]\{8,\}/\1***REDACTED***/g')
  REDACT_ARGS+=(-e 's|\(postgres\(ql\)\?://[^:]*:\)[^@]*@|\1***REDACTED***@|g')
}

redact() {
  if [ "${#REDACT_ARGS[@]}" -gt 0 ]; then sed "${REDACT_ARGS[@]}"; else cat; fi
}

# --------------------------------------------------------------- failure ---

# shellcheck disable=SC2329  # invoked through the EXIT trap below
on_failure() {
  local code=$?
  if [ -n "${USING_LOCK_DIR:-}" ]; then rmdir "$LOCK_DIR" 2>/dev/null || true; fi
  [ "$code" -eq 0 ] && exit 0
  error "deployment failed during: ${CURRENT_STEP}"
  error "the database volume was left intact; no data was removed"
  if [ -n "${COMPOSE_READY:-}" ]; then
    error "service state:"
    compose ps -a 2>&1 | redact | sed 's/^/[ERROR]   /' >&2 || true
    local service
    for service in postgres migrate app worker; do
      if compose ps -a --services 2>/dev/null | grep -qx "$service"; then
        error "last log lines for ${service}:"
        compose logs --tail 20 "$service" 2>&1 | redact | sed 's/^/[ERROR]   /' >&2 || true
      fi
    done
  fi
  error "safe diagnostics: docker compose -f ${COMPOSE_FILE} --env-file ${ENV_FILE} ps -a"
  error "safe diagnostics: docker compose -f ${COMPOSE_FILE} --env-file ${ENV_FILE} logs --tail 100 app"
  error "runbook: docs/runbooks/failed-migration.md"
  exit "$code"
}
trap on_failure EXIT

# ------------------------------------------------------------------ setup --

SKIP_BUILD=0
RUN_BACKUP=""
for argument in "$@"; do
  case "$argument" in
    --skip-build) SKIP_BUILD=1 ;;
    --no-backup)  RUN_BACKUP="false" ;;
    -h|--help) sed -n '2,14p' "$0"; trap - EXIT; exit 0 ;;
    *) error "unknown argument: ${argument}"; exit 2 ;;
  esac
done

step "Preflight"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
cd "$REPO_ROOT"

COMPOSE_FILE="${REPO_ROOT}/docker-compose.yml"
ENV_FILE="${REPO_ROOT}/.env"

# Reject an incomplete checkout before touching Docker.
for required in "$COMPOSE_FILE" "${REPO_ROOT}/Dockerfile" \
                "${REPO_ROOT}/package.json" "${REPO_ROOT}/prisma/schema.prisma" \
                "${SCRIPT_DIR}/validate-env.mjs"; do
  if [ ! -f "$required" ]; then
    error "incomplete checkout: missing ${required#"$REPO_ROOT"/}"
    exit 1
  fi
done

# Only one deployment at a time. flock when available, atomic mkdir otherwise.
LOCK_FILE="${REPO_ROOT}/.deploy.lock"
LOCK_DIR="${REPO_ROOT}/.deploy.lock.d"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    error "another deployment holds ${LOCK_FILE}"
    exit 1
  fi
else
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    error "another deployment holds ${LOCK_DIR}"
    exit 1
  fi
  # Release the fallback lock from within the existing handler rather than
  # installing a second EXIT trap, which would discard failure diagnostics.
  USING_LOCK_DIR=1
fi

command -v docker >/dev/null 2>&1 || { error "docker is not installed or not on PATH"; exit 1; }
docker info >/dev/null 2>&1 || { error "the Docker daemon is not reachable"; exit 1; }
docker compose version >/dev/null 2>&1 || {
  error "Docker Compose v2 is required; the legacy docker-compose binary is not supported"
  exit 1
}

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

# .env must exist, be a regular file, and stay owner-only.
if [ -L "$ENV_FILE" ]; then
  LINK_TARGET="$(readlink -f "$ENV_FILE" || true)"
  case "$LINK_TARGET" in
    "$REPO_ROOT"/*|/etc/resonance-ledger/*) ;;
    *) error ".env is a symlink to an unexpected location"; exit 1 ;;
  esac
fi
[ -f "$ENV_FILE" ] || { error ".env not found at ${ENV_FILE}"; exit 1; }
ENV_MODE="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE")"
case "$ENV_MODE" in
  *[1-7][0-7]|*[0-7][1-7])
    error ".env is group or world readable (mode ${ENV_MODE}); run: chmod 600 .env"
    exit 1 ;;
esac

build_redactor
ok "Preflight"

# ---------------------------------------------------------- configuration --

step "Configuration valid"

node "${SCRIPT_DIR}/validate-env.mjs" "$ENV_FILE" || {
  error "environment validation failed; no value was printed above"
  exit 1
}

# Never print the rendered configuration: it interpolates secrets.
compose config --quiet || { error "docker compose config rejected the configuration"; exit 1; }

read_env() { sed -n "s/^${1}=//p" "$ENV_FILE" | head -n1 | sed 's/^["'\'']//; s/["'\'']$//'; }
APP_IMAGE="$(read_env APP_IMAGE)"; APP_IMAGE="${APP_IMAGE:-resonance-ledger}"
APP_VERSION="$(read_env APP_VERSION)"; APP_VERSION="${APP_VERSION:-local}"
HOST_PORT="$(read_env HOST_PORT)"; HOST_PORT="${HOST_PORT:-3000}"
APP_URL="$(read_env APP_URL)"
[ -z "$RUN_BACKUP" ] && RUN_BACKUP="$(read_env BACKUP_BEFORE_DEPLOY)"

ok "Configuration valid"

# Record the outgoing image so an operator can roll the application back.
PREVIOUS_IMAGE_ID="$(docker image inspect "${APP_IMAGE}:${APP_VERSION}" --format '{{.Id}}' 2>/dev/null || echo 'none')"
info "previous image id: ${PREVIOUS_IMAGE_ID}"
info "target image: ${APP_IMAGE}:${APP_VERSION}"

# ----------------------------------------------------------------- backup --

if [ "$RUN_BACKUP" = "true" ]; then
  step "Pre-update backup"
  if compose ps --status running --services 2>/dev/null | grep -qx postgres; then
    if ! "${SCRIPT_DIR}/backup.sh"; then
      error "the requested pre-update backup failed; aborting before any change"
      exit 1
    fi
    ok "Pre-update backup"
  else
    info "PostgreSQL is not running yet; this is a first install, so no backup is taken"
  fi
else
  warn "BACKUP_BEFORE_DEPLOY is not true; continuing without a pre-update backup"
fi

# ------------------------------------------------------------------ images -

COMPOSE_READY=1

if [ "$SKIP_BUILD" -eq 1 ]; then
  info "--skip-build was given; using images already present"
elif printf '%s' "$APP_IMAGE" | grep -q '/'; then
  step "Pulling released images"
  compose pull --quiet 2>&1 | redact
  ok "Pulling released images"
else
  step "Building images"
  DOCKER_BUILDKIT=1 compose build --pull 2>&1 | redact | tail -20
  ok "Building images"
fi

# -------------------------------------------------------------- database ---

step "Database healthy"
compose up -d postgres 2>&1 | redact

DB_DEADLINE=$(( $(date +%s) + 120 ))
DB_STATE="unknown"
while [ "$(date +%s)" -lt "$DB_DEADLINE" ]; do
  CONTAINER="$(compose ps -q postgres 2>/dev/null || true)"
  if [ -n "$CONTAINER" ]; then
    DB_STATE="$(docker inspect "$CONTAINER" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || echo unknown)"
    [ "$DB_STATE" = "healthy" ] && break
  fi
  sleep 3
done

if [ "$DB_STATE" != "healthy" ]; then
  error "PostgreSQL did not become healthy within 120 seconds (state: ${DB_STATE})"
  compose ps -a postgres 2>&1 | redact | sed 's/^/[ERROR]   /' >&2 || true
  compose logs --tail 30 postgres 2>&1 | redact | sed 's/^/[ERROR]   /' >&2 || true
  exit 1
fi
ok "Database healthy"

# ------------------------------------------------------------ migrations ---

step "Migrations applied"
if ! compose run --rm migrate 2>&1 | redact; then
  error "prisma migrate deploy did not exit 0; app and worker were not replaced"
  error "runbook: docs/runbooks/failed-migration.md"
  exit 1
fi
ok "Migrations applied"

# ----------------------------------------------------------- application ---

step "Application healthy"
compose up -d app worker 2>&1 | redact

APP_DEADLINE=$(( $(date +%s) + 180 ))
while [ "$(date +%s)" -lt "$APP_DEADLINE" ]; do
  UNHEALTHY=0
  for service in app worker; do
    CONTAINER="$(compose ps -q "$service" 2>/dev/null || true)"
    STATE="none"
    [ -n "$CONTAINER" ] && STATE="$(docker inspect "$CONTAINER" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || echo unknown)"
    [ "$STATE" = "healthy" ] || UNHEALTHY=1
  done
  [ "$UNHEALTHY" -eq 0 ] && break
  sleep 3
done

if [ "$UNHEALTHY" -ne 0 ]; then
  error "app or worker did not become healthy within 180 seconds"
  compose ps -a 2>&1 | redact | sed 's/^/[ERROR]   /' >&2 || true
  compose logs --tail 30 app worker 2>&1 | redact | sed 's/^/[ERROR]   /' >&2 || true
  exit 1
fi
ok "Application healthy"

# ------------------------------------------------------------ smoke test ---

step "Read-only smoke test"

# Health from inside the container, over container networking.
if ! compose exec -T app node scripts/container-app-health.mjs >/dev/null 2>&1; then
  error "the in-container health probe failed"
  exit 1
fi
info "in-container health probe: ok"

# Migration status must report no pending migrations.
# Prisma reports a clean state as "Database schema is up to date!"; older
# versions phrase it as "No pending migrations".
if compose run --rm --entrypoint npx migrate prisma migrate status 2>&1 | redact \
     | grep -qE 'Database schema is up to date|No pending migrations'; then
  info "migration status: schema is up to date"
else
  warn "migration status did not report a clean state; check docs/runbooks/failed-migration.md"
fi

# Through the reverse proxy, when the operator's APP_URL is reachable.
if [ -n "$APP_URL" ] && command -v curl >/dev/null 2>&1; then
  if curl -fsS --max-time 5 "${APP_URL}/api/health" >/dev/null 2>&1; then
    info "health via APP_URL: ok"
  else
    warn "APP_URL is not reachable from this host; verify the reverse proxy separately"
  fi
fi

# Loopback check against the published port.
if command -v curl >/dev/null 2>&1; then
  if curl -fsS --max-time 5 "http://127.0.0.1:${HOST_PORT}/api/health" >/dev/null 2>&1; then
    info "health via 127.0.0.1:${HOST_PORT}: ok"
  else
    warn "the published loopback port did not answer; the proxy may target a different port"
  fi
fi
ok "Read-only smoke test"

# ---------------------------------------------------------------- summary --

step "Deployment complete"
compose ps 2>&1 | redact
ELAPSED=$(( $(date +%s) - ${DEPLOY_STARTED_AT:-$(date +%s)} ))
ok "version ${APP_VERSION} deployed; app and worker healthy; elapsed ${ELAPSED}s"
ok "previous image id recorded for rollback: ${PREVIOUS_IMAGE_ID}"
info "database migrations are never rolled back automatically; see docs/runbooks/"

if [ -n "${USING_LOCK_DIR:-}" ]; then rmdir "$LOCK_DIR" 2>/dev/null || true; fi
trap - EXIT
exit 0
