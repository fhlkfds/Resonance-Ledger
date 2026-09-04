# Operations

Day-to-day operation of a Resonance Ledger installation. For incident-specific
procedures see `docs/runbooks/`.

## Topology

One Linux host runs four Compose services:

| Service    | Role                     | Network               | Published                |
| ---------- | ------------------------ | --------------------- | ------------------------ |
| `postgres` | Sole durable store       | `database` (internal) | Never                    |
| `migrate`  | One-shot migration gate  | `database`            | Never                    |
| `app`      | Next.js UI and API       | `egress`, `database`  | `127.0.0.1:${HOST_PORT}` |
| `worker`   | Sync, retention, cleanup | `egress`, `database`  | Never                    |

An HTTPS reverse proxy in front of the loopback-bound app is an operator
prerequisite, not a Compose service. Terminate TLS there and forward to
`127.0.0.1:${HOST_PORT}`.

## Routine commands

```sh
# Deploy or update. Validates config, migrates, then replaces app and worker.
scripts/deploy.sh

# Deploy without rebuilding images (for example after only an .env change).
scripts/deploy.sh --skip-build

# Take a verified backup now.
scripts/backup.sh

# Read-only check of a running installation.
node scripts/smoke-test.mjs https://music.example.com

# Validate configuration without deploying. Prints names, never values.
node scripts/validate-env.mjs .env

# Service state and bounded logs.
docker compose ps -a
docker compose logs --tail 100 app
docker compose logs --tail 100 worker
```

`scripts/deploy.sh` never runs `docker compose down`, never removes a volume,
and never prunes. A failed deployment leaves the database volume intact.

## What to watch

The specification treats each of these as operator-visible:

- A probable history gap — see `runbooks/probable-gap.md`.
- Three or more consecutive sync failures — check `/settings` or
  `GET /api/sync/status`.
- Spotify authorization expiring within seven days — see
  `runbooks/reauthorization.md`.
- A failed backup or a failed retention job.

Logs are JSON on stdout with a request or run id on every line. Secret-bearing
fields are redacted recursively, so shipping container logs to a collector does
not leak tokens.

## Backups

`scripts/backup.sh` writes `resonance-ledger_<UTC>.dump` (PostgreSQL custom
format) into `BACKUP_DIR`, mode 0600, after verifying it with
`pg_restore --list`. Set `BACKUP_RETENTION_DAYS` to sweep older dumps; the
sweep stays inside the exact directory and never follows a symlink.

A daily backup is recommended. Run it from cron or a systemd timer:

```
15 3 * * * cd /opt/resonance-ledger && scripts/backup.sh >> /var/log/resonance-backup.log 2>&1
```

`pg_dump` is a logical backup, not point-in-time recovery. The default recovery
point objective is the last successful daily backup. **A backup is not
operationally complete until a restore drill has succeeded** — do one quarterly
using `runbooks/backup-restore.md`.

For a stronger objective, add encrypted off-host copies and WAL archiving after
the MVP.

## Upgrading

1. Review the release notes and the migration diff.
2. Ensure `BACKUP_BEFORE_DEPLOY=true`, or take a backup manually.
3. Set `APP_VERSION` to the new immutable version. Never `latest`.
4. Run `scripts/deploy.sh`.

Migrations are applied by a one-shot job that must exit 0 before the app and
worker are replaced. Migrations are never rolled back automatically. An
application-only rollback is safe when the new migrations are backward
compatible; `deploy.sh` prints the previous image id for that purpose.

## Retention and privacy

`DATA_RETENTION_DAYS` (default 730) is disclosed in the privacy policy. The
worker deletes history past the cutoff daily, then purges metadata no longer
referenced by any event. Changing retention means changing the published policy
too — see `docs/privacy-template.md`.

Disconnecting from `/settings` disables Spotify access immediately and deletes
the user's Spotify-derived data. Current Spotify terms require completion within
five days.
