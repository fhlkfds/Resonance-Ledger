-- CreateEnum
CREATE TYPE "AccountState" AS ENUM ('ACTIVE', 'NEEDS_REAUTH', 'PAUSED', 'BLOCKED', 'DELETING');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('IDLE', 'RUNNING', 'BACKOFF', 'NEEDS_REAUTH', 'PAUSED');

-- CreateEnum
CREATE TYPE "SyncOutcome" AS ENUM ('SUCCEEDED', 'FAILED', 'RATE_LIMITED', 'SKIPPED', 'PARTIAL');

-- CreateEnum
CREATE TYPE "HistorySource" AS ENUM ('SPOTIFY_API', 'IMPORT');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "consent_version" TEXT,
    "consented_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spotify_accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "spotify_account_id" TEXT NOT NULL,
    "display_name" TEXT,
    "access_token_envelope" JSONB NOT NULL,
    "refresh_token_envelope" JSONB NOT NULL,
    "access_token_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "refresh_token_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "scopes" TEXT[],
    "state" "AccountState" NOT NULL DEFAULT 'ACTIVE',
    "authorized_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "spotify_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_settings" (
    "user_id" UUID NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "week_starts_on" INTEGER NOT NULL DEFAULT 1,
    "default_range" TEXT NOT NULL DEFAULT 'LAST_30_DAYS',
    "theme" TEXT NOT NULL DEFAULT 'SYSTEM',
    "retention_days" INTEGER NOT NULL DEFAULT 730,

    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "app_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "csrf_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "idle_at" TIMESTAMPTZ(6) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "auth_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_states" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "state_hash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'OAUTH',
    "rate_key" TEXT,
    "return_path" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artists" (
    "id" UUID NOT NULL,
    "external_key" TEXT NOT NULL,
    "spotify_id" TEXT,
    "name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "spotify_uri" TEXT,
    "image_url" TEXT,
    "metadata_fetched_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "artists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "albums" (
    "id" UUID NOT NULL,
    "external_key" TEXT NOT NULL,
    "spotify_id" TEXT,
    "name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "album_type" TEXT,
    "release_date_text" TEXT,
    "release_date_precision" TEXT,
    "release_year" INTEGER,
    "spotify_uri" TEXT,
    "artwork_url" TEXT,
    "metadata_fetched_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "albums_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "album_artists" (
    "album_id" UUID NOT NULL,
    "artist_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "album_artists_pkey" PRIMARY KEY ("album_id","artist_id")
);

-- CreateTable
CREATE TABLE "tracks" (
    "id" UUID NOT NULL,
    "external_key" TEXT NOT NULL,
    "spotify_id" TEXT,
    "album_id" UUID,
    "name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "disc_number" INTEGER,
    "track_number" INTEGER,
    "explicit" BOOLEAN NOT NULL DEFAULT false,
    "is_local" BOOLEAN NOT NULL DEFAULT false,
    "spotify_uri" TEXT,
    "isrc" TEXT,
    "metadata_fetched_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tracks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "track_artists" (
    "track_id" UUID NOT NULL,
    "artist_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "track_artists_pkey" PRIMARY KEY ("track_id","artist_id")
);

-- CreateTable
CREATE TABLE "listening_history" (
    "id" UUID NOT NULL,
    "spotify_account_id" UUID NOT NULL,
    "track_id" UUID NOT NULL,
    "played_at" TIMESTAMPTZ(6) NOT NULL,
    "estimated_duration_ms" INTEGER NOT NULL,
    "source" "HistorySource" NOT NULL DEFAULT 'SPOTIFY_API',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listening_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_state" (
    "spotify_account_id" UUID NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'IDLE',
    "cursor_played_at" TIMESTAMPTZ(6),
    "next_sync_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_attempt_at" TIMESTAMPTZ(6),
    "last_success_at" TIMESTAMPTZ(6),
    "last_manual_sync_at" TIMESTAMPTZ(6),
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "probable_gap" BOOLEAN NOT NULL DEFAULT false,
    "gap_detected_at" TIMESTAMPTZ(6),
    "gap_reason" TEXT,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMPTZ(6),
    "worker_heartbeat_at" TIMESTAMPTZ(6),

    CONSTRAINT "sync_state_pkey" PRIMARY KEY ("spotify_account_id")
);

-- CreateTable
CREATE TABLE "sync_runs" (
    "id" UUID NOT NULL,
    "spotify_account_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "outcome" "SyncOutcome" NOT NULL,
    "pages_fetched" INTEGER NOT NULL DEFAULT 0,
    "items_fetched" INTEGER NOT NULL DEFAULT 0,
    "events_inserted" INTEGER NOT NULL DEFAULT 0,
    "duplicates" INTEGER NOT NULL DEFAULT 0,
    "error_class" TEXT,
    "request_id" TEXT NOT NULL,

    CONSTRAINT "sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE UNIQUE INDEX "spotify_accounts_user_id_key" ON "spotify_accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "spotify_accounts_spotify_account_id_key" ON "spotify_accounts"("spotify_account_id");

-- CreateIndex
CREATE INDEX "spotify_accounts_state_refresh_token_expires_at_idx" ON "spotify_accounts"("state", "refresh_token_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "app_sessions_token_hash_key" ON "app_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "app_sessions_user_id_idx" ON "app_sessions"("user_id");

-- CreateIndex
CREATE INDEX "app_sessions_expires_at_idx" ON "app_sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_states_state_hash_key" ON "oauth_states"("state_hash");

-- CreateIndex
CREATE INDEX "oauth_states_expires_at_idx" ON "oauth_states"("expires_at");

-- CreateIndex
CREATE INDEX "oauth_states_purpose_rate_key_created_at_idx" ON "oauth_states"("purpose", "rate_key", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "artists_external_key_key" ON "artists"("external_key");

-- CreateIndex
CREATE UNIQUE INDEX "artists_spotify_id_key" ON "artists"("spotify_id");

-- CreateIndex
CREATE INDEX "artists_normalized_name_idx" ON "artists"("normalized_name");

-- CreateIndex
CREATE UNIQUE INDEX "albums_external_key_key" ON "albums"("external_key");

-- CreateIndex
CREATE UNIQUE INDEX "albums_spotify_id_key" ON "albums"("spotify_id");

-- CreateIndex
CREATE INDEX "albums_normalized_name_idx" ON "albums"("normalized_name");

-- CreateIndex
CREATE INDEX "albums_release_year_idx" ON "albums"("release_year");

-- CreateIndex
CREATE INDEX "album_artists_artist_id_idx" ON "album_artists"("artist_id");

-- CreateIndex
CREATE UNIQUE INDEX "album_artists_album_id_position_key" ON "album_artists"("album_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "tracks_external_key_key" ON "tracks"("external_key");

-- CreateIndex
CREATE UNIQUE INDEX "tracks_spotify_id_key" ON "tracks"("spotify_id");

-- CreateIndex
CREATE INDEX "tracks_album_id_idx" ON "tracks"("album_id");

-- CreateIndex
CREATE INDEX "tracks_normalized_name_idx" ON "tracks"("normalized_name");

-- CreateIndex
CREATE INDEX "tracks_isrc_idx" ON "tracks"("isrc");

-- CreateIndex
CREATE INDEX "track_artists_artist_id_idx" ON "track_artists"("artist_id");

-- CreateIndex
CREATE UNIQUE INDEX "track_artists_track_id_position_key" ON "track_artists"("track_id", "position");

-- CreateIndex
CREATE INDEX "listening_history_spotify_account_id_played_at_id_idx" ON "listening_history"("spotify_account_id", "played_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "listening_history_spotify_account_id_track_id_played_at_idx" ON "listening_history"("spotify_account_id", "track_id", "played_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "listening_history_spotify_account_id_track_id_played_at_key" ON "listening_history"("spotify_account_id", "track_id", "played_at");

-- CreateIndex
CREATE INDEX "sync_state_status_next_sync_at_idx" ON "sync_state"("status", "next_sync_at");

-- CreateIndex
CREATE INDEX "sync_state_lease_expires_at_idx" ON "sync_state"("lease_expires_at");

-- CreateIndex
CREATE INDEX "sync_runs_spotify_account_id_started_at_idx" ON "sync_runs"("spotify_account_id", "started_at" DESC);

-- AddForeignKey
ALTER TABLE "spotify_accounts" ADD CONSTRAINT "spotify_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_sessions" ADD CONSTRAINT "app_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "album_artists" ADD CONSTRAINT "album_artists_album_id_fkey" FOREIGN KEY ("album_id") REFERENCES "albums"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "album_artists" ADD CONSTRAINT "album_artists_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "artists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_album_id_fkey" FOREIGN KEY ("album_id") REFERENCES "albums"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "track_artists" ADD CONSTRAINT "track_artists_track_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "track_artists" ADD CONSTRAINT "track_artists_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "artists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listening_history" ADD CONSTRAINT "listening_history_spotify_account_id_fkey" FOREIGN KEY ("spotify_account_id") REFERENCES "spotify_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listening_history" ADD CONSTRAINT "listening_history_track_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_spotify_account_id_fkey" FOREIGN KEY ("spotify_account_id") REFERENCES "spotify_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_spotify_account_id_fkey" FOREIGN KEY ("spotify_account_id") REFERENCES "spotify_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Native PostgreSQL invariants and search indexes that Prisma cannot express.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE "user_settings"
  ADD CONSTRAINT "user_settings_week_starts_on_check" CHECK ("week_starts_on" BETWEEN 0 AND 6),
  ADD CONSTRAINT "user_settings_retention_days_check" CHECK ("retention_days" > 0);

ALTER TABLE "oauth_states"
  ADD CONSTRAINT "oauth_states_purpose_check" CHECK (
    ("purpose" = 'OAUTH' AND "rate_key" IS NULL) OR
    ("purpose" = 'RATE' AND "rate_key" IS NOT NULL)
  );

ALTER TABLE "artists"
  ADD CONSTRAINT "artists_external_key_check" CHECK (
    ("spotify_id" IS NOT NULL AND "external_key" = 'spotify:' || "spotify_id") OR
    ("spotify_id" IS NULL AND "external_key" ~ '^local:[0-9a-f]{64}$')
  );

ALTER TABLE "albums"
  ADD CONSTRAINT "albums_external_key_check" CHECK (
    ("spotify_id" IS NOT NULL AND "external_key" = 'spotify:' || "spotify_id") OR
    ("spotify_id" IS NULL AND "external_key" ~ '^local:[0-9a-f]{64}$')
  ),
  ADD CONSTRAINT "albums_release_precision_check" CHECK (
    "release_date_precision" IS NULL OR "release_date_precision" IN ('year', 'month', 'day')
  ),
  ADD CONSTRAINT "albums_release_year_check" CHECK (
    "release_year" IS NULL OR "release_year" BETWEEN 1 AND 9999
  );

ALTER TABLE "tracks"
  ADD CONSTRAINT "tracks_external_key_check" CHECK (
    ("spotify_id" IS NOT NULL AND "external_key" = 'spotify:' || "spotify_id") OR
    ("spotify_id" IS NULL AND "external_key" ~ '^local:[0-9a-f]{64}$')
  ),
  ADD CONSTRAINT "tracks_duration_ms_check" CHECK ("duration_ms" >= 0),
  ADD CONSTRAINT "tracks_disc_number_check" CHECK ("disc_number" IS NULL OR "disc_number" > 0),
  ADD CONSTRAINT "tracks_track_number_check" CHECK ("track_number" IS NULL OR "track_number" > 0);

ALTER TABLE "album_artists"
  ADD CONSTRAINT "album_artists_position_check" CHECK ("position" >= 0);

ALTER TABLE "track_artists"
  ADD CONSTRAINT "track_artists_position_check" CHECK ("position" >= 0);

ALTER TABLE "listening_history"
  ADD CONSTRAINT "listening_history_estimated_duration_ms_check" CHECK ("estimated_duration_ms" >= 0);

ALTER TABLE "sync_state"
  ADD CONSTRAINT "sync_state_consecutive_failures_check" CHECK ("consecutive_failures" >= 0),
  ADD CONSTRAINT "sync_state_gap_fields_check" CHECK (
    (NOT "probable_gap") OR ("gap_detected_at" IS NOT NULL AND "gap_reason" IS NOT NULL)
  ),
  ADD CONSTRAINT "sync_state_lease_fields_check" CHECK (
    ("lease_owner" IS NULL AND "lease_expires_at" IS NULL) OR
    ("lease_owner" IS NOT NULL AND "lease_expires_at" IS NOT NULL)
  );

ALTER TABLE "sync_runs"
  ADD CONSTRAINT "sync_runs_counts_check" CHECK (
    "pages_fetched" >= 0 AND "items_fetched" >= 0 AND "events_inserted" >= 0 AND "duplicates" >= 0
  ),
  ADD CONSTRAINT "sync_runs_finished_at_check" CHECK ("finished_at" IS NULL OR "finished_at" >= "started_at");

CREATE INDEX "artists_normalized_name_trgm_idx" ON "artists" USING GIN ("normalized_name" gin_trgm_ops);
CREATE INDEX "albums_normalized_name_trgm_idx" ON "albums" USING GIN ("normalized_name" gin_trgm_ops);
CREATE INDEX "tracks_normalized_name_trgm_idx" ON "tracks" USING GIN ("normalized_name" gin_trgm_ops);
CREATE INDEX "sync_state_due_idx" ON "sync_state" ("next_sync_at", "lease_expires_at")
  WHERE "status" IN ('IDLE', 'BACKOFF', 'RUNNING');
CREATE INDEX "app_sessions_live_idx" ON "app_sessions" ("token_hash", "expires_at")
  WHERE "revoked_at" IS NULL;
