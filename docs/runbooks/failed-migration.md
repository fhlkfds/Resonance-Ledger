# Runbook: failed migration

**Symptom.** `scripts/deploy.sh` stops at `Migrations applied` with
"prisma migrate deploy did not exit 0". The app and worker were **not**
replaced, and the database volume is intact.

**Design intent.** The migration job is a gate. Nothing downstream starts until
it exits 0, so a failed migration leaves the previous application running
against the previous schema.

## Diagnose

```sh
# Full output from the migration job.
docker compose --env-file .env run --rm migrate

# Which migrations are applied, pending, or failed.
docker compose --env-file .env run --rm --entrypoint npx migrate prisma migrate status
```

Common causes:

| Cause                                 | Signal                           | Action                                                                                   |
| ------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------- |
| Database unreachable                  | connection refused or timeout    | Confirm `postgres` is healthy; check `DATABASE_URL` host is the Compose service name     |
| Wrong credentials                     | authentication failed            | `node scripts/validate-env.mjs .env`; confirm `POSTGRES_PASSWORD` matches `DATABASE_URL` |
| Migration already partly applied      | "migration started but failed"   | Follow _Resolve a failed migration_ below                                                |
| Constraint violation on existing data | duplicate key or check violation | Existing rows conflict with the new constraint; fix the data or the migration            |
| Drift from a manual schema change     | "database schema is not in sync" | Reconcile manually; never resolve drift on production without a backup                   |

## Resolve a failed migration

**Take a backup before touching migration state.**

```sh
scripts/backup.sh
```

Then, for a migration that failed partway:

```sh
# Only after you have confirmed the migration's effects were fully reverted:
docker compose --env-file .env run --rm --entrypoint npx migrate \
  prisma migrate resolve --rolled-back <migration_name>

# Or, if the change is genuinely already present in the schema:
docker compose --env-file .env run --rm --entrypoint npx migrate \
  prisma migrate resolve --applied <migration_name>
```

Re-run `scripts/deploy.sh` once status is clean.

## What not to do

- **Do not** run `docker compose down -v`, `docker volume rm`, or
  `docker system prune --volumes`. These destroy the database.
- **Do not** roll a migration back automatically. The deploy script never does,
  and neither should you without a verified backup and a tested plan.
- **Do not** edit an already-applied migration file. Write a new forward one.

If the schema cannot be repaired, restore from backup using
`backup-restore.md` and accept the recovery point objective.
