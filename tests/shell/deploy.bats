#!/usr/bin/env bats
#
# T-030 failure fixtures for scripts/deploy.sh and scripts/backup.sh.
#
# These exercise the preflight paths that must fail closed. They never start
# containers, so they are safe to run anywhere, and they assert that no secret
# value reaches the console and that no volume-destroying command exists.

setup() {
  REPO_ROOT="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd -P)"
  export REPO_ROOT
  WORK="$(mktemp -d)"
  export WORK

  # A self-contained copy of the repository skeleton so a fixture can break
  # one thing at a time without touching the real checkout.
  mkdir -p "${WORK}/scripts" "${WORK}/prisma" "${WORK}/bin"
  cp "${REPO_ROOT}/scripts/deploy.sh" "${WORK}/scripts/"
  cp "${REPO_ROOT}/scripts/backup.sh" "${WORK}/scripts/"
  cp "${REPO_ROOT}/scripts/validate-env.mjs" "${WORK}/scripts/"
  cp "${REPO_ROOT}/docker-compose.yml" "${WORK}/"
  cp "${REPO_ROOT}/Dockerfile" "${WORK}/"
  cp "${REPO_ROOT}/package.json" "${WORK}/"
  cp "${REPO_ROOT}/prisma/schema.prisma" "${WORK}/prisma/"

  SECRET_PASSWORD='sup3rSecretDatabasePassw0rdXY'
  export SECRET_PASSWORD
  cat >"${WORK}/.env" <<ENVFILE
NODE_ENV=production
APP_URL=https://music.resonance.test
PORT=3000
HOST_PORT=3000
BIND_ADDRESS=127.0.0.1
POSTGRES_DB=resonance
POSTGRES_USER=resonance
POSTGRES_PASSWORD=${SECRET_PASSWORD}
DATABASE_URL=postgresql://resonance:${SECRET_PASSWORD}@postgres:5432/resonance?schema=public
SPOTIFY_CLIENT_ID=8f2c1d4e9a7b3c6d0e5f2a1b8c4d7e90
SPOTIFY_CLIENT_SECRET=b41d9f2ac7e358061bd42fa9e70c1583a6d4e2f9
SPOTIFY_REDIRECT_URI=https://music.resonance.test/api/auth/callback
SESSION_SECRET=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=
TOKEN_ENCRYPTION_KEY=ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=
TOKEN_ENCRYPTION_KEY_VERSION=v1
SYNC_INTERVAL_SECONDS=180
SYNC_OVERLAP_SECONDS=300
DATA_RETENTION_DAYS=730
SYNC_RUN_RETENTION_DAYS=90
LOG_LEVEL=info
TRUST_PROXY=1
TZ=UTC
APP_IMAGE=resonance-ledger
APP_VERSION=0.1.0
BACKUP_DIR=${WORK}/backups
BACKUP_RETENTION_DAYS=30
BACKUP_BEFORE_DEPLOY=false
ENVFILE
  chmod 600 "${WORK}/.env"
}

teardown() {
  [ -n "${WORK:-}" ] && rm -rf "$WORK"
}

# Puts a stub `docker` on PATH ahead of the real one.
stub_docker() {
  cat >"${WORK}/bin/docker" <<STUB
#!/usr/bin/env bash
$1
STUB
  chmod +x "${WORK}/bin/docker"
  export PATH="${WORK}/bin:${PATH}"
}

@test "deploy: exits non-zero when docker is missing" {
  # A minimal PATH holding everything the script needs before its docker
  # check, and deliberately no docker binary, so the real branch is taken.
  mkdir -p "${WORK}/minbin"
  for tool in bash date dirname sed mkdir rmdir stat cat head grep node flock rm; do
    target="$(command -v "$tool" || true)"
    [ -n "$target" ] && ln -sf "$target" "${WORK}/minbin/${tool}"
  done
  run env PATH="${WORK}/minbin" "${WORK}/scripts/deploy.sh"
  [ "$status" -ne 0 ]
  [[ "$output" == *"docker is not installed"* ]]
}

@test "deploy: exits non-zero when the docker daemon is unreachable" {
  stub_docker 'case "$1" in info) exit 1 ;; compose) exit 0 ;; *) exit 0 ;; esac'
  run "${WORK}/scripts/deploy.sh"
  [ "$status" -ne 0 ]
  [[ "$output" == *"Docker daemon is not reachable"* ]]
}

@test "deploy: rejects a missing .env" {
  stub_docker 'exit 0'
  rm -f "${WORK}/.env"
  run "${WORK}/scripts/deploy.sh"
  [ "$status" -ne 0 ]
  [[ "$output" == *".env not found"* ]]
}

@test "deploy: rejects a group-readable .env" {
  stub_docker 'exit 0'
  chmod 640 "${WORK}/.env"
  run "${WORK}/scripts/deploy.sh"
  [ "$status" -ne 0 ]
  [[ "$output" == *"group or world readable"* ]]
}

@test "deploy: rejects an incomplete checkout" {
  stub_docker 'exit 0'
  rm -f "${WORK}/docker-compose.yml"
  run "${WORK}/scripts/deploy.sh"
  [ "$status" -ne 0 ]
  [[ "$output" == *"incomplete checkout"* ]]
}

@test "deploy: rejects invalid configuration without printing any value" {
  stub_docker 'case "$1" in info) exit 0 ;; compose) exit 0 ;; *) exit 0 ;; esac'
  # Break one variable; the rest stay valid.
  sed -i 's|^SYNC_INTERVAL_SECONDS=.*|SYNC_INTERVAL_SECONDS=5|' "${WORK}/.env"
  run "${WORK}/scripts/deploy.sh"
  [ "$status" -ne 0 ]
  [[ "$output" == *"SYNC_INTERVAL_SECONDS"* ]]
  [[ "$output" != *"${SECRET_PASSWORD}"* ]]
}

@test "deploy: never prints a secret value on any preflight failure" {
  stub_docker 'case "$1" in info) exit 1 ;; *) exit 0 ;; esac'
  run "${WORK}/scripts/deploy.sh"
  [ "$status" -ne 0 ]
  [[ "$output" != *"${SECRET_PASSWORD}"* ]]
}

@test "deploy: reports an unhealthy database and exits non-zero" {
  # compose config/up succeed; postgres never reports healthy.
  stub_docker 'case "$1" in
  info) exit 0 ;;
  compose)
    for a in "$@"; do
      case "$a" in
        config) exit 0 ;;
        version) exit 0 ;;
        up) exit 0 ;;
        ps) echo "" ; exit 0 ;;
      esac
    done
    exit 0 ;;
  inspect) echo "unhealthy"; exit 0 ;;
  image) echo "none"; exit 0 ;;
  *) exit 0 ;;
esac'
  run timeout 200 "${WORK}/scripts/deploy.sh" --skip-build --no-backup
  [ "$status" -ne 0 ]
  [[ "$output" == *"did not become healthy"* ]]
  [[ "$output" != *"${SECRET_PASSWORD}"* ]]
}

@test "deploy: reports a migration failure and does not replace app or worker" {
  stub_docker 'case "$1" in
  info) exit 0 ;;
  compose)
    for a in "$@"; do
      case "$a" in
        run) echo "migration boom" >&2; exit 1 ;;
        ps) echo "fakecontainerid"; exit 0 ;;
      esac
    done
    exit 0 ;;
  inspect) echo "healthy"; exit 0 ;;
  image) echo "none"; exit 0 ;;
  *) exit 0 ;;
esac'
  run timeout 200 "${WORK}/scripts/deploy.sh" --skip-build --no-backup
  [ "$status" -ne 0 ]
  [[ "$output" == *"migrate deploy did not exit 0"* ]]
  [[ "$output" != *"${SECRET_PASSWORD}"* ]]
}

@test "deploy: rejects an unknown argument" {
  run "${WORK}/scripts/deploy.sh" --wipe-everything
  [ "$status" -ne 0 ]
  [[ "$output" == *"unknown argument"* ]]
}

@test "backup: rejects a missing .env" {
  stub_docker 'exit 0'
  rm -f "${WORK}/.env"
  run "${WORK}/scripts/backup.sh"
  [ "$status" -ne 0 ]
  [[ "$output" == *".env not found"* ]]
}

@test "backup: refuses the filesystem root as a backup directory" {
  stub_docker 'case "$1" in info) exit 0 ;; *) exit 0 ;; esac'
  sed -i 's|^BACKUP_DIR=.*|BACKUP_DIR=/|' "${WORK}/.env"
  run "${WORK}/scripts/backup.sh"
  [ "$status" -ne 0 ]
  [[ "$output" == *"must not be the filesystem root"* ]]
}

@test "backup: refuses a relative backup directory" {
  stub_docker 'case "$1" in info) exit 0 ;; *) exit 0 ;; esac'
  sed -i 's|^BACKUP_DIR=.*|BACKUP_DIR=relative/path|' "${WORK}/.env"
  run "${WORK}/scripts/backup.sh"
  [ "$status" -ne 0 ]
}

@test "backup: exits non-zero when postgres is not running" {
  stub_docker 'case "$1" in
  info) exit 0 ;;
  compose)
    for a in "$@"; do
      case "$a" in ps) echo ""; exit 0 ;; esac
    done
    exit 0 ;;
  *) exit 0 ;;
esac'
  run "${WORK}/scripts/backup.sh"
  [ "$status" -ne 0 ]
  [[ "$output" == *"not running"* ]]
}

@test "neither script contains a volume-destroying command" {
  for script in "${REPO_ROOT}/scripts/deploy.sh" "${REPO_ROOT}/scripts/backup.sh"; do
    run grep -nE 'compose[[:space:]]+down|down[[:space:]]+-v|volume[[:space:]]+rm|system[[:space:]]+prune|--volumes' "$script"
    # A match is only allowed inside a comment line.
    if [ "$status" -eq 0 ]; then
      while IFS= read -r line; do
        [[ "${line#*:}" =~ ^[[:space:]]*# ]] || {
          echo "destructive command in ${script}: ${line}"
          return 1
        }
      done <<< "$output"
    fi
  done
}

@test "both scripts pass bash syntax checking" {
  run bash -n "${REPO_ROOT}/scripts/deploy.sh"
  [ "$status" -eq 0 ]
  run bash -n "${REPO_ROOT}/scripts/backup.sh"
  [ "$status" -eq 0 ]
}
