# Runbook: backup restore and quarterly drill

`scripts/backup.sh` produces `resonance-ledger_<UTC>.dump` in PostgreSQL custom
format, mode 0600, already verified with `pg_restore --list`. **A backup is not
operationally complete until a restore has succeeded.** Run the drill below at
least quarterly and record the result.

## Quarterly restore drill (non-destructive)

Restores into a disposable database beside the live one. It never touches
application data.

```sh
DUMP=$(ls -t "${BACKUP_DIR:-/var/backups/resonance-ledger}"/resonance-ledger_*.dump | head -1)
echo "drilling with ${DUMP}"

# Row counts before, for comparison.
docker compose --env-file .env exec -T postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "SELECT 'users='||(SELECT count(*) FROM users)||' history='||(SELECT count(*) FROM listening_history);"

# Fresh disposable database.
docker compose --env-file .env exec -T postgres \
  psql -U "$POSTGRES_USER" -d postgres -q \
  -c "DROP DATABASE IF EXISTS restore_drill;" -c "CREATE DATABASE restore_drill;"

# Restore into it.
docker compose --env-file .env exec -T postgres sh -c 'cat > /tmp/drill.dump' < "$DUMP"
docker compose --env-file .env exec -T postgres \
  pg_restore -U "$POSTGRES_USER" -d restore_drill --no-owner /tmp/drill.dump

# Compare schema, counts, and the constraint that prevents duplicate plays.
docker compose --env-file .env exec -T postgres \
  psql -U "$POSTGRES_USER" -d restore_drill -tAc \
  "SELECT 'tables='||(SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE')||' users='||(SELECT count(*) FROM users)||' history='||(SELECT count(*) FROM listening_history);"
docker compose --env-file .env exec -T postgres \
  psql -U "$POSTGRES_USER" -d restore_drill -tAc \
  "SELECT count(*) FROM pg_indexes WHERE tablename='listening_history' AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%played_at%';"

# Clean up the drill only. Never the application database.
docker compose --env-file .env exec -T postgres rm -f /tmp/drill.dump
docker compose --env-file .env exec -T postgres \
  psql -U "$POSTGRES_USER" -d postgres -q -c "DROP DATABASE IF EXISTS restore_drill;"
```

**Pass condition.** 13 application tables plus `_prisma_migrations`, row counts
matching the source at dump time, and the unique
`(spotify_account_id, track_id, played_at)` index present.

## Real recovery

Use this only when the live database is lost or corrupt.

1. **Stop writers.** Leave `postgres` running.
   ```sh
   docker compose --env-file .env stop app worker
   ```
2. **Back up whatever is still there**, even if it looks broken.
   ```sh
   scripts/backup.sh || echo "current state is unreadable; continuing"
   ```
3. **Restore into a new database**, rather than over the damaged one, so the
   damaged copy stays available for diagnosis.
   ```sh
   docker compose --env-file .env exec -T postgres \
     psql -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE resonance_restored;"
   docker compose --env-file .env exec -T postgres sh -c 'cat > /tmp/restore.dump' < "$DUMP"
   docker compose --env-file .env exec -T postgres \
     pg_restore -U "$POSTGRES_USER" -d resonance_restored --no-owner /tmp/restore.dump
   ```
4. **Verify** with the same count and constraint queries as the drill.
5. **Cut over** by pointing `POSTGRES_DB` in `.env` at the restored database,
   or rename the databases. Then:
   ```sh
   scripts/deploy.sh --skip-build
   node scripts/smoke-test.mjs https://music.example.com
   ```
6. **Confirm** the dashboard shows expected totals and the worker records a new
   successful run.

## Expectations

- Recovery point objective: the last successful daily backup, target ≤ 24 hours.
- Recovery time objective: ≤ 2 hours for an operator familiar with Docker and
  PostgreSQL.
- Plays that occurred after the dump are lost and are **not** recoverable from
  Spotify beyond its recent window. Expect a probable gap afterwards; see
  `probable-gap.md`.

Never run `docker compose down -v`, `docker volume rm`, or
`docker system prune --volumes` during recovery.
