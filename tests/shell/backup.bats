#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd -P)"
  WORK="$(mktemp -d)"
  export REPO_ROOT WORK
  mkdir -p "${WORK}/scripts" "${WORK}/bin"
  cp "${REPO_ROOT}/scripts/backup.sh" "${WORK}/scripts/"
  cp "${REPO_ROOT}/scripts/validate-env.mjs" "${WORK}/scripts/"
  cp "${REPO_ROOT}/docker-compose.yml" "${WORK}/"
  SECRET_PASSWORD='backupSecretDatabasePassw0rdXY'
  export SECRET_PASSWORD
  write_env "${WORK}/backups"
}

teardown() {
  rm -rf "$WORK"
}

write_env() {
  local backup_dir="$1"
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
BACKUP_DIR=${backup_dir}
BACKUP_RETENTION_DAYS=30
BACKUP_BEFORE_DEPLOY=false
ENVFILE
  chmod 600 "${WORK}/.env"
}

stub_docker() {
  cat >"${WORK}/bin/docker" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  info) exit 0 ;;
  inspect) echo healthy; exit 0 ;;
  compose)
    shift
    while [ "$#" -gt 0 ]; do
      case "$1" in
        version) exit 0 ;;
        ps)
          case " $* " in
            *" --status "*) echo postgres ;;
            *" -q "*) echo postgres-container ;;
          esac
          exit 0 ;;
        exec)
          case " $* " in
            *" pg_dump "*)
              printf 'fixture custom dump'
              [ "${BACKUP_DUMP_FAIL:-0}" = 1 ] && exit 9
              exit 0 ;;
            *" pg_restore "*) exit 0 ;;
            *" sh -c "*) cat >/dev/null; exit 0 ;;
            *" rm -f "*) exit 0 ;;
          esac ;;
      esac
      shift
    done ;;
esac
exit 0
STUB
  chmod +x "${WORK}/bin/docker"
  export PATH="${WORK}/bin:${PATH}"
}

@test "backup exits non-zero when Docker is missing" {
  mkdir -p "${WORK}/minbin"
  for tool in bash date dirname sed stat node; do
    target="$(command -v "$tool" || true)"
    [ -n "$target" ] && ln -s "$target" "${WORK}/minbin/${tool}"
  done
  run env PATH="${WORK}/minbin" "${WORK}/scripts/backup.sh"
  [ "$status" -ne 0 ]
  [[ "$output" == *"docker is not installed"* ]]
}

@test "backup creates a missing BACKUP_DIR with mode 0700" {
  stub_docker
  run "${WORK}/scripts/backup.sh"
  [ "$status" -eq 0 ]
  [ "$(stat -c '%a' "${WORK}/backups")" = 700 ]
  [[ "$output" != *"${SECRET_PASSWORD}"* ]]
}

@test "backup rejects unsafe BACKUP_DIR values" {
  stub_docker
  write_env "/"
  run "${WORK}/scripts/backup.sh"
  [ "$status" -ne 0 ]
  [[ "$output" == *"filesystem root"* ]]
  [[ "$output" != *"${SECRET_PASSWORD}"* ]]
}

@test "dump failure exits non-zero and preserves a .failed file" {
  stub_docker
  export BACKUP_DUMP_FAIL=1
  run "${WORK}/scripts/backup.sh"
  [ "$status" -ne 0 ]
  run find "${WORK}/backups" -maxdepth 1 -type f -name '*.failed'
  [ "$status" -eq 0 ]
  [ -n "$output" ]
  [[ "$output" != *"${SECRET_PASSWORD}"* ]]
}

@test "retention deletes only old matching regular dump files" {
  stub_docker
  mkdir -p "${WORK}/backups"
  touch -d '40 days ago' "${WORK}/backups/resonance-ledger_old.dump"
  touch -d '40 days ago' "${WORK}/backups/unrelated.dump"
  ln -s "${WORK}/backups/unrelated.dump" "${WORK}/backups/resonance-ledger_link.dump"
  run "${WORK}/scripts/backup.sh"
  [ "$status" -eq 0 ]
  [ ! -e "${WORK}/backups/resonance-ledger_old.dump" ]
  [ -e "${WORK}/backups/unrelated.dump" ]
  [ -L "${WORK}/backups/resonance-ledger_link.dump" ]
  [[ "$output" != *"${SECRET_PASSWORD}"* ]]
}
