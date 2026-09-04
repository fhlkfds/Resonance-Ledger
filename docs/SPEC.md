**PRODUCT + TECHNICAL SPECIFICATION**

Resonance Ledger

Self-hosted Spotify listening-history and analytics application

---

**Status:** Source of truth for implementation - specification only

**Audience:** Coding agents, full-stack engineers, DevOps engineers, security reviewers, and self-hosting operators

**Research date:** 3 September 2026

**Working name:** Temporary; trademark and domain clearance required before release

**Implementation stance: one-user-first, multi-user-safe, Docker Compose on one Linux host, PostgreSQL as the sole durable store, and no Redis in the MVP.**

# **Specification Basis**

## **Architecture decision**

Build a responsive Next.js application with server-side route handlers, a separate Node.js synchronization worker, PostgreSQL, and a one-shot migration service. The web and worker processes use the same codebase. PostgreSQL is the sole durable system of record; Redis is not part of the MVP because scheduling, locking, sessions, and cursors can be handled reliably in PostgreSQL at the expected scale.

## **Critical product guardrails**

1.  Spotify's recently-played endpoint returns at most 50 items per request and exposes played_at plus the track's full duration_ms; it does not expose actual milliseconds heard. Therefore, the product must call the metric **estimated listening time**, never exact listening time, unless a later import source contains an actual played-duration field. See [<u>Spotify: Get Recently Played Tracks</u>](https://developer.spotify.com/documentation/web-api/reference/get-recently-played).

2.  Spotify access tokens normally last one hour, and refresh tokens issued to Developer Dashboard apps currently expire after six months without extension on refresh. The app must warn before refresh-token expiry and support reauthorization. See [<u>Spotify: Refreshing Tokens</u>](https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens).

3.  As of the February 2026 Development Mode changes, the app owner must have Premium and a Development Mode app is limited to five users; wider use requires Extended Quota Mode. See [<u>Spotify: February 2026 Migration Guide</u>](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide).

4.  Spotify's current Developer Terms require data minimization, a defined non-indefinite retention policy, current metadata, an accessible disconnect mechanism, and deletion of connected-user data after disconnection; the Data Protection Appendix states deletion within five days. The MVP must implement these controls, and legal review is required before a public multi-user release. See [<u>Spotify Developer Terms</u>](https://developer.spotify.com/terms).

5.  “All time” means all data still retained by this installation under its disclosed retention policy.

# **1. Product Overview**

| **Field**               | **Specification**                                                                                                                          |
| :---------------------- | :----------------------------------------------------------------------------------------------------------------------------------------- |
| Project name            | **Resonance Ledger** (temporary working name; complete trademark and domain clearance before release)                                      |
| Product type            | Self-hosted listening-history collector and personal analytics web application                                                             |
| Primary purpose         | Reliably capture Spotify recently-played events, persist a privacy-controlled history, and present searchable statistics and visual trends |
| Target users            | Individuals, households, and small trusted groups that operate a VPS, NAS, or home server; MVP optimized for one connected Spotify account |
| Deployment model        | Docker Compose on one Linux host, normally behind an HTTPS reverse proxy                                                                   |
| Authentication provider | Spotify OAuth 2.0 Authorization Code flow; application sessions are issued after callback                                                  |
| Database                | PostgreSQL 18, with Prisma as the default ORM and migration tool                                                                           |
| Primary platform        | Modern desktop and mobile web browsers                                                                                                     |
| Mobile support          | Responsive layouts, touch-friendly controls, accessible chart alternatives; no native app in MVP                                           |
| Self-hosted             | Yes; all durable application data remains in the operator's PostgreSQL volume and configured backups                                       |
| Docker support          | Required; docker compose up -d must deploy a new configured installation                                                                   |

## **Product boundaries**

- The application records metadata and play events; it does not stream, download, proxy, or record audio.

- It is not affiliated with Spotify and must not include “Spotify” in its product name or imitate Spotify branding.

- It does not promise complete recovery after a long outage because Spotify's recently-played window is bounded.

- It does not treat a track's full duration as proof that the user heard the entire track.

- Multi-user data isolation is designed into the schema and APIs, but one-user operation is the recommended MVP boundary because of Development Mode limits.

# **2. Functional Requirements**

Priority meanings: **Must** is release-blocking, **Should** is expected for v1 unless explicitly deferred, and **Could** is post-MVP.

| **ID** | **Feature**                         | **Description**                                                                                                                                             | **Priority** | **Acceptance criteria**                                                                                                                                      |
| :----: | :---------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------: | :----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-001 | Spotify OAuth login                 | Start a server-side Spotify Authorization Code flow with the minimum scopes.                                                                                |     Must     | Login redirects to Spotify; a valid callback creates or links the correct local user; denied or invalid callbacks do not create a session.                   |
| FR-002 | Token refresh and reauthorization   | Refresh expired access tokens and detect refresh-token expiry/revocation.                                                                                   |     Must     | Expired access tokens refresh without user action; invalid or expired refresh tokens set NEEDS_REAUTH; UI shows a reauthorize action and expiry warnings.    |
| FR-003 | Listening-history synchronization   | Retrieve recently played items for each active account and persist normalized events.                                                                       |     Must     | A successful run stores every valid item returned by Spotify, its track, album, and artists in one committed unit.                                           |
| FR-004 | Automatic scheduled synchronization | Run synchronization every three minutes by default with per-account jitter.                                                                                 |     Must     | Worker resumes after restart, selects due accounts from persisted state, and does not require a browser session.                                             |
| FR-005 | Duplicate-play prevention           | Enforce idempotency in the database, not only in application memory.                                                                                        |     Must     | Reprocessing identical Spotify results inserts zero duplicate events under sequential or concurrent runs.                                                    |
| FR-006 | Track metadata                      | Store the normalized track name, Spotify ID when present, URI, duration, disc/track number, explicit flag, local-file flag, album, and metadata timestamps. |     Must     | Track records are upserted by a stable external key; local tracks without a Spotify ID are supported with a deterministic local key.                         |
| FR-007 | Artist metadata                     | Store each credited artist's stable key, Spotify ID when present, name, URI, image URL when available, and freshness timestamps.                            |     Must     | Artist upserts preserve one record per external key and track-artist order.                                                                                  |
| FR-008 | Album metadata                      | Store album identity, name, type, release date and precision, artwork URL, credited artists, and freshness timestamps.                                      |     Must     | Albums are deduplicated; partial release dates retain their precision rather than inventing a day.                                                           |
| FR-009 | Dashboard                           | Present summary cards, recent activity, top entities, and a trend chart for the selected range.                                                             |     Must     | Dashboard loads only the authenticated user's retained data and handles empty/loading/error states.                                                          |
| FR-010 | Estimated listening time            | Sum the full duration snapshot of each recorded play and label it as an estimate.                                                                           |     Must     | Every UI/API surface says “Estimated listening time”; tooltip explains that Spotify does not provide actual played milliseconds.                             |
| FR-011 | Total plays                         | Count retained listening events in the selected range.                                                                                                      |     Must     | Count equals the filtered listening_history rows.                                                                                                            |
| FR-012 | Unique tracks                       | Count distinct track IDs represented in filtered events.                                                                                                    |     Must     | Result matches a distinct track query for the same range and user.                                                                                           |
| FR-013 | Unique artists                      | Count distinct credited artists represented by filtered tracks.                                                                                             |     Must     | Collaborating artists are individually included once in the unique count.                                                                                    |
| FR-014 | Unique albums                       | Count distinct non-null album IDs represented in filtered events.                                                                                           |     Must     | Local/unmatched tracks without an album do not inflate the count.                                                                                            |
| FR-015 | Top tracks                          | Rank tracks by play count with deterministic tie-breaking.                                                                                                  |     Must     | Order is play count desc, estimated duration desc, normalized name asc.                                                                                      |
| FR-016 | Top artists                         | Rank all credited artists by play credits.                                                                                                                  |     Must     | Each play gives one credit to every credited artist; the UI explains that collaborative totals overlap.                                                      |
| FR-017 | Top albums                          | Rank albums by plays of their member tracks.                                                                                                                |     Must     | Each listening event contributes at most one play to one album.                                                                                              |
| FR-018 | Listening history                   | Browse a reverse-chronological event list with cursor pagination.                                                                                           |     Must     | Pagination has no duplicates or skips when events share nearby timestamps.                                                                                   |
| FR-019 | Search                              | Search retained tracks, artists, and albums by normalized name.                                                                                             |     Must     | Search is case-insensitive, scoped to the authenticated user's history, debounced in UI, and rejects oversized queries.                                      |
| FR-020 | Filtering                           | Filter history and entity lists by entity, explicit flag, and date range where applicable.                                                                  |     Must     | Filters compose, are reflected in the URL, and survive refresh/back navigation.                                                                              |
| FR-021 | Preset date ranges                  | Support today, last 7 days, last 30 days, current month, current year, and retained all-time.                                                               |     Must     | Server converts user-local boundaries to UTC half-open intervals \[from,to).                                                                                 |
| FR-022 | Custom date ranges                  | Allow an inclusive user-facing start/end date with an optional timezone override.                                                                           |     Must     | Validation rejects inverted, invalid, or policy-disallowed ranges; displayed result includes the effective timezone.                                         |
| FR-023 | Artist detail page                  | Show artist totals, rank, top tracks/albums, trend, and recent plays.                                                                                       |     Must     | All metrics use the same selected range and collaboration-credit definition.                                                                                 |
| FR-024 | Album detail page                   | Show album totals, track breakdown, first/last recorded play, and trend.                                                                                    |     Must     | Unknown or unauthorized album IDs return 404 without revealing another user's data.                                                                          |
| FR-025 | Track detail page                   | Show track totals, estimated time, first/last play, trend, album, and credited artists.                                                                     |     Must     | The page handles local tracks and missing artwork gracefully.                                                                                                |
| FR-026 | Daily statistics                    | Aggregate plays and estimated duration by local calendar day.                                                                                               |     Must     | Day buckets remain correct across daylight-saving transitions.                                                                                               |
| FR-027 | Weekly statistics                   | Aggregate by configurable week start.                                                                                                                       |     Must     | Week boundaries follow user timezone and weekStartsOn.                                                                                                       |
| FR-028 | Monthly statistics                  | Aggregate by local calendar month.                                                                                                                          |     Must     | Missing months return zero-filled buckets for chart continuity.                                                                                              |
| FR-029 | Yearly statistics                   | Aggregate by local calendar year.                                                                                                                           |     Must     | Year labels and totals match the selected timezone.                                                                                                          |
| FR-030 | Retained all-time statistics        | Aggregate all events still retained under policy.                                                                                                           |     Must     | UI names the range “All retained history” and shows the earliest retained event date.                                                                        |
| FR-031 | Charts                              | Render responsive, accessible charts with textual/table alternatives.                                                                                       |     Must     | Keyboard users can reach filters; every chart has a summary and downloadable underlying values.                                                              |
| FR-032 | Hourly listening patterns           | Group plays by local hour 0-23.                                                                                                                             |     Must     | All 24 buckets are returned, including zeros.                                                                                                                |
| FR-033 | Day-of-week analytics               | Group plays by local weekday with configured week order.                                                                                                    |     Must     | Seven labeled buckets are returned and sum to the range total.                                                                                               |
| FR-034 | Data export                         | Export the authenticated user's filtered history and aggregates as CSV or JSON.                                                                             |     Must     | Export streams data, excludes tokens/secrets, applies retention/access rules, and includes timezone/metric definitions.                                      |
| FR-035 | Settings                            | Manage timezone, week start, default range, theme, retention disclosure, sync status, and reauthorization.                                                  |     Must     | Settings validate IANA timezone names and persist per user.                                                                                                  |
| FR-036 | Logout                              | Revoke the local application session without disconnecting Spotify or deleting history.                                                                     |     Must     | POST logout invalidates the server-side session, clears the cookie, and redirects to login.                                                                  |
| FR-037 | Manual synchronization              | Let an authenticated user request one rate-limited sync.                                                                                                    |    Should    | Request schedules work and returns 202; it never performs a long Spotify call inside the HTTP request.                                                       |
| FR-038 | Sync health and gap detection       | Show last attempt/success, next run, failure count, account state, and probable missing-history gaps.                                                       |     Must     | A full page after an extended cursor gap records a durable warning without silently claiming completeness.                                                   |
| FR-039 | Disconnect and delete               | Stop Spotify access and delete the user's Spotify-derived data.                                                                                             |     Must     | Confirmation is required; account is disabled immediately; deletion completes immediately where possible and always within five days with retry/audit state. |
| FR-040 | Privacy and terms consent           | Show operator privacy terms before first connection and retain consent version/time.                                                                        |     Must     | No OAuth start occurs until consent is recorded; public privacy/terms pages remain reachable.                                                                |
| FR-041 | Metadata freshness                  | Refresh metadata that is displayed and remove unreferenced stale metadata.                                                                                  |    Should    | Recently displayed/played entities refresh on a bounded schedule; no permanent artwork cache is created.                                                     |
| FR-042 | Health reporting                    | Provide liveness/readiness status without sensitive details.                                                                                                |     Must     | /api/health returns 200 only when the app can serve and query PostgreSQL; response includes version and request ID, not secrets.                             |
| FR-043 | Responsive mobile UI                | Support phone, tablet, and desktop widths.                                                                                                                  |     Must     | Core routes work at 360 CSS pixels without horizontal page scrolling; tables collapse or scroll within labeled regions.                                      |
| FR-044 | Tenant isolation                    | Enforce ownership in every query and mutation.                                                                                                              |     Must     | Integration tests prove that IDs from user B return 404/403 to user A and never appear in search/export.                                                     |

# **3. Pages and Navigation**

| **Page**       | **Route**       | **Purpose**                                                          | **Main components**                                                                                              |
| :------------- | :-------------- | :------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------- |
| Login          | /login          | Explain the product, privacy boundary, and begin Spotify connection. | Product summary, consent notice, Connect button, error banner, links to privacy/terms                            |
| Dashboard      | /               | At-a-glance summary for the active range.                            | Global date filter, KPI cards, top artist/track, recent plays, trend chart, sync-status badge                    |
| History        | /history        | Browse exact recorded events.                                        | Search, date/entity/explicit filters, cursor-paginated list/table, export action                                 |
| Tracks         | /tracks         | Rank and browse retained tracks.                                     | Search, range filter, sortable list, plays, estimated time, last played                                          |
| Artists        | /artists        | Rank and browse credited artists.                                    | Search, range filter, ranking list, collaboration note                                                           |
| Albums         | /albums         | Rank and browse albums.                                              | Search, range filter, artwork list, plays, estimated time                                                        |
| Statistics     | /statistics     | Explore deeper time and distribution analysis.                       | Metric selector, granularity selector, chart grid, table alternatives, comparison controls                       |
| Track Details  | /tracks/\[id\]  | Inspect one retained track.                                          | Metadata header, KPI row, trend, recent plays, artists and album links                                           |
| Artist Details | /artists/\[id\] | Inspect one retained artist.                                         | Metadata header, KPI row, top tracks/albums, trend, recent plays                                                 |
| Album Details  | /albums/\[id\]  | Inspect one retained album.                                          | Metadata header, track breakdown, KPI row, trend, recent plays                                                   |
| Settings       | /settings       | Manage preferences, connection, privacy, and sync health.            | Profile, timezone/week start, retention disclosure, token-expiry warning, reauthorize, disconnect/delete, logout |
| Privacy        | /privacy        | Disclose collection, retention, cookies, exports, and deletion.      | Versioned privacy text, operator contact placeholder, last-updated date                                          |
| Terms          | /terms          | Present operator terms and Spotify-required third-party disclaimers. | Versioned terms, third-party beneficiary/disclaimer language requiring legal review                              |

## **Navigation model**

- Desktop: persistent left rail in order Dashboard, History, Statistics, Tracks, Artists, Albums; Settings and user menu at the bottom.

- Mobile: compact top bar plus bottom navigation for Dashboard, History, Statistics, and Library; Library opens Tracks/Artists/Albums.

- Global controls: date range and timezone context appear on data pages; route/query parameters are canonical so links are shareable within the same authenticated account.

- Breadcrumbs: use on detail pages only.

- Authentication: unauthenticated requests to private pages redirect to /login?returnTo=\<safe-local-path\>; never accept an external return URL.

# **4. Dashboard Specification**

| **Widget**                | **Data**                                                               | **Visualization**                                                       | **Filters**                                                                            |
| :------------------------ | :--------------------------------------------------------------------- | :---------------------------------------------------------------------- | :------------------------------------------------------------------------------------- |
| Estimated listening time  | Sum of estimated_duration_ms snapshots                                 | KPI card with human duration and prior-period delta                     | Global date range, timezone                                                            |
| Total plays               | Count of listening events                                              | KPI card with prior-period delta                                        | Global date range                                                                      |
| Unique artists            | Distinct credited artists                                              | KPI card                                                                | Global date range                                                                      |
| Unique albums             | Distinct non-null albums                                               | KPI card                                                                | Global date range                                                                      |
| Unique tracks             | Distinct tracks                                                        | KPI card                                                                | Global date range                                                                      |
| Top artist                | Highest artist play-credit count                                       | Artwork/name card, plays, estimated time note                           | Global date range                                                                      |
| Top track                 | Highest track play count                                               | Artwork/title/artist card, plays                                        | Global date range                                                                      |
| Most active listening day | Local date with greatest plays; tie by estimated time then latest date | Highlight card with date, plays, estimated time                         | Global date range, timezone                                                            |
| Recent plays              | Latest 10 retained events                                              | Compact list with artwork, track, artists, relative and exact timestamp | User only; independent of range by default, optional “within range” toggle             |
| Listening trend           | Plays or estimated time grouped at adaptive granularity                | Area/line chart with accessible table                                   | Date range, metric, timezone; day for \<=90 days, week for \<=2 years, month otherwise |

Dashboard queries must execute concurrently where safe, use one normalized range object, and return a single response so every widget represents the same database snapshot. Empty ranges show zeros and a connection/sync call to action, not errors. Prior-period comparisons use an immediately preceding interval of equal duration; disable the delta for retained all-time.

# **5. Analytics Specification**

| **Analysis**                           | **Definition**                                                            | **Recommended chart**                                             | **Required controls**                            |
| :------------------------------------- | :------------------------------------------------------------------------ | :---------------------------------------------------------------- | :----------------------------------------------- |
| Plays over time                        | Event count by adaptive day/week/month bucket                             | Area chart with line and tooltip                                  | Range, granularity, timezone                     |
| Estimated listening duration over time | Sum of full track-duration snapshots by bucket                            | Line or area chart; format milliseconds as hours/minutes          | Range, granularity, timezone                     |
| Top artists                            | Play credits for every credited artist                                    | Horizontal bar, top 10/25, plus table                             | Range, limit, plays/estimated time               |
| Top albums                             | Events grouped by album                                                   | Horizontal bar                                                    | Range, limit, plays/estimated time               |
| Top tracks                             | Events grouped by track                                                   | Horizontal bar                                                    | Range, limit, plays/estimated time               |
| Activity by hour                       | Events grouped by local hour 0-23                                         | Column chart; optional hour x weekday heatmap                     | Range, timezone, plays/estimated time            |
| Activity by weekday                    | Events grouped by local weekday                                           | Ordered column chart                                              | Range, timezone, week start                      |
| Activity by month                      | Events grouped by calendar month                                          | Column chart for multi-year totals; line for chronological months | Range, timezone                                  |
| Year-over-year listening               | Same calendar buckets for selected years                                  | Multi-series line chart                                           | Years, metric, timezone; leap-day rule disclosed |
| Artist distribution                    | Top artist play credits divided by total artist credits, top N plus Other | Treemap or donut with table                                       | Range, N, plays/estimated time                   |
| Album distribution                     | Album plays divided by plays with an album, top N plus Other              | Treemap or donut with table                                       | Range, N, plays/estimated time                   |

## **Metric semantics**

| **Metric**               | **Normative definition**                                                                                                            |
| :----------------------- | :---------------------------------------------------------------------------------------------------------------------------------- |
| Play                     | One unique listening_history row accepted from Spotify or a future import source.                                                   |
| Estimated listening time | Sum of the track's full duration captured with each event. It is an upper-bound-style estimate, not evidence of completed playback. |
| Unique track/album       | COUNT(DISTINCT entity_id) among filtered events; null albums are excluded.                                                          |
| Unique artist            | Distinct artists joined through filtered events and track_artists.                                                                  |
| Artist play credit       | One credit to each artist Spotify lists for the played track; collaboration totals overlap and must not be summed as total plays.   |
| Prior period             | Immediately preceding half-open interval with equal elapsed duration, calculated in the chosen timezone.                            |
| Day/week/month/year      | Calendar bucket in the user's IANA timezone. Store timestamps in UTC; convert only for boundaries/grouping/display.                 |
| Retained all-time        | All rows currently retained, with earliest retained timestamp returned as metadata.                                                 |

Tie-breaking must be deterministic: primary metric descending, secondary estimated duration descending, normalized display name ascending, internal ID ascending. API responses return raw integer milliseconds and counts; the frontend performs localized formatting only.

# **6. Spotify Integration**

Spotify uses OAuth 2.0. The server-side [<u>Authorization Code flow</u>](https://developer.spotify.com/documentation/web-api/tutorials/code-flow) is selected because the client secret can remain on the server. Spotify requires exact redirect-URI matching, and production redirect URIs must use HTTPS; localhost is not accepted, while explicit loopback IP literals may use HTTP for local development. See [<u>Spotify Redirect URI requirements</u>](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri).

## **Required scopes**

| **Scope**                 | **Reason**                                                              |
| :------------------------ | :---------------------------------------------------------------------- |
| user-read-recently-played | Read recently played items for synchronization.                         |
| user-read-private         | Retrieve the current profile and stable account_id for account linking. |

Do not request user-read-email: Spotify currently marks email deprecated and unverified, and the product does not require it. Use the current profile's immutable account_id, not the mutable/deprecated user id, for linking. See [<u>Spotify: Get Current User's Profile</u>](https://developer.spotify.com/documentation/web-api/reference/get-current-users-profile).

## **OAuth flow**

1.  GET /api/auth/spotify verifies consent, creates 32 random bytes of state, stores only SHA-256(state) with a 10-minute expiry and single-use flag in oauth_states, and writes the raw value to an HttpOnly, Secure-in-production, SameSite=Lax, host-only cookie.

2.  The server returns a 302 redirect to Spotify /authorize with response_type=code, client ID, exact redirect URI, scopes, and state. The return path is a validated relative path stored server-side, never copied from an arbitrary external URL.

3.  GET /api/auth/callback accepts code, state, or an OAuth error; it requires constant-time equality between callback state, cookie state, and the unused, unexpired state hash. It marks the state used before token exchange.

4.  The backend exchanges the code at Spotify's token endpoint using HTTP Basic client authentication. Neither code nor tokens are sent to browser JavaScript.

5.  The backend calls /v1/me, links by Spotify account_id, records the granted scopes, encrypts tokens, calculates access and refresh expiry, and creates a local application session.

6.  The server sets an opaque random session cookie named \_\_Host-resonance_session in production: Secure; HttpOnly; SameSite=Lax; Path=/, no Domain. Store only a SHA-256 hash of the session token in the database.

7.  Redirect to the validated local return path or /. Remove the OAuth state cookie.

State is mandatory even though Spotify labels it strongly recommended. [<u>OWASP's OAuth guidance</u>](https://cheatsheetseries.owasp.org/cheatsheets/OAuth2_Cheat_Sheet.html) identifies transaction-bound state as a CSRF defense. Authorization Code with PKCE S256 may be added later only after an integration test confirms the selected Spotify/library behavior; it is not a substitute for state in this server-side design.

## **Token storage and lifecycle**

| **Item**         | **Requirement**                                                                                                                                                                       |
| :--------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Access token     | AES-256-GCM encrypted application-side with a versioned envelope; store ciphertext, nonce, tag, key version, and access_token_expires_at.                                             |
| Refresh token    | Same encryption controls; preserve the existing refresh token if a refresh response omits a replacement.                                                                              |
| Encryption key   | TOKEN_ENCRYPTION_KEY, supplied at runtime, never stored in PostgreSQL or the image; support key versioning/rotation.                                                                  |
| Access expiry    | Refresh when less than five minutes remain; serialize refreshes per Spotify account to prevent a refresh stampede.                                                                    |
| Refresh expiry   | Record six months from authorization under current Spotify behavior; warn at 30, 7, and 1 day; reauthorization replaces the token set.                                                |
| Revocation/error | On invalid_grant, repeated 401, revoked scope, or expired refresh token, set account state to NEEDS_REAUTH, stop aggressive retries, and retain data only under the disclosed policy. |

## **Recently played synchronization**

- Call GET /v1/me/player/recently-played?limit=50&after=\<cursor\> with the required scope.

- Follow only next URLs whose origin is exactly https://api.spotify.com; cap traversal at 10 pages and the run at 500 items to bound work.

- Sort returned items ascending by played_at before persistence.

- Treat played_at as the event time and duration_ms as full track length. Do not infer actual playback progress.

- Persist only normalized fields required by the product. Do not retain raw Spotify response bodies after structured logging/redaction and transaction completion.

- On the first connection, import the items Spotify currently returns; make no claim that this is the user's full history.

## **Rate limits, retries, and failure handling**

Spotify applies an app-wide limit over a rolling 30-second window and normally returns Retry-After with 429 responses. See [<u>Spotify Rate Limits</u>](https://developer.spotify.com/documentation/web-api/concepts/rate-limits).

| **Condition**             | **Required handling**                                                                                         |
| :------------------------ | :------------------------------------------------------------------------------------------------------------ |
| 200                       | Validate schema, normalize, transact, advance cursor, reset failure count.                                    |
| 400                       | Do not retry blindly; record sanitized validation/configuration error.                                        |
| 401                       | Refresh once under an account lock, then retry the original request once; otherwise require reauthorization.  |
| 403                       | Treat as missing/revoked scope or policy restriction; set NEEDS_REAUTH or BLOCKED with operator-safe message. |
| 429                       | Honor Retry-After exactly, add 0-1 second jitter, and do not count it as a credential failure.                |
| 5xx/network timeout       | Exponential backoff with full jitter: base 1 second, cap 60 seconds, maximum five attempts in one run.        |
| Malformed success payload | Fail closed, preserve cursor, store a bounded sanitized error classification, and alert after threshold.      |

All outbound Spotify calls use connect and total timeouts, a descriptive user agent, request correlation IDs, and a concurrency limiter. Never log authorization codes, cookies, access tokens, refresh tokens, client secrets, full response headers, or database URLs.

# **7. Synchronization Architecture**

## **Recommended schedule**

- Default interval: **3 minutes per active account**.

- Configurable range: 60-900 seconds; values outside the range fail startup validation.

- Add deterministic 0-20 second jitter per account to avoid synchronized bursts.

- A worker tick every 30 seconds leases due accounts from PostgreSQL; the schedule is not kept only in process memory.

- Manual sync is limited to one request per account per minute and merely sets next_sync_at=now().

## **Normative process**

1.  Scheduler selects an active, due account whose lease is absent/expired and atomically acquires a 2-minute lease with a unique worker ID.

2.  Retrieve/decrypt the current Spotify token set under least privilege.

3.  Refresh if access expiry is within five minutes; write the new encrypted access token and expiry atomically.

4.  Fetch recently played items with limit=50 and after=max(cursor-5 minutes,0) to create a safe overlap; follow validated next cursors within run limits.

5.  Validate payloads against a versioned runtime schema; reject unknown required-shape changes while tolerating unknown optional fields.

6.  Normalize Spotify IDs, local-track fallback keys, names, release-date precision, durations, artwork URLs, and artist order.

7.  Upsert artists by external_key.

8.  Upsert albums and album-artist links by external_key.

9.  Upsert tracks and ordered track-artist links by external_key.

10. Insert listening events with ON CONFLICT DO NOTHING against the unique account/track/time key. PostgreSQL's ON CONFLICT provides database-enforced idempotency; see [<u>PostgreSQL INSERT</u>](https://www.postgresql.org/docs/current/sql-insert.html).

11. In the same transaction, advance cursor_played_at to the maximum accepted/observed timestamp, record page/item counts, release the lease, set the next run, and mark success.

12. On transient failure, roll back the data transaction, preserve the old cursor, increment failure state, calculate backoff, and release/expire the lease safely.

## **Protection matrix**

| **Risk**                      | **Protection**                                                                                                                                                                                            |
| :---------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duplicate events              | Five-minute overlap plus unique (spotify_account_id, track_id, played_at) constraint and ON CONFLICT DO NOTHING.                                                                                          |
| Concurrent workers            | Atomic lease fields in sync_state; lease owner must match on heartbeat/release; unique database constraint remains final defense.                                                                         |
| Spotify outage                | Persisted exponential backoff, failure counters, last error class, visible degraded state; cursor never advances on a failed transaction.                                                                 |
| Rate limiting                 | Per-app concurrency limiter, per-account jitter, Retry-After, and no immediate retry storm.                                                                                                               |
| Expired credentials           | Proactive access refresh; 30/7/1-day refresh-token warnings; durable NEEDS_REAUTH state.                                                                                                                  |
| Service restart               | Cursor, next run, failure count, gap warnings, and leases live in PostgreSQL; expired leases are reclaimable.                                                                                             |
| Long downtime/window overflow | If the cursor predates the oldest returned event and the bounded result is full, record probable_gap=true; never silently mark history complete.                                                          |
| Partial metadata write        | Artists, albums, tracks, joins, events, and cursor update occur in one transaction per account/run.                                                                                                       |
| Poison item                   | Reject the run on schema-critical corruption; after three identical failures, quarantine only the item fingerprint without storing raw personal payload, alert, and continue by explicit operator policy. |

## **Completeness rule**

A sync run can be marked successful even when it inserts zero events, but it can be marked complete only for the response window actually observed. The UI must distinguish **healthy synchronization** from **complete historical coverage**. A probable gap is durable until the user acknowledges it or a supported import fills it.

# **8. Database Specification**

Use PostgreSQL 18. PostgreSQL 18 and 17 are supported current branches as of this specification; production images must pin a major/minor tag or digest and follow planned minor upgrades, not latest. See [<u>PostgreSQL Downloads</u>](https://www.postgresql.org/download/).

## **Schema inventory**

| **Table**         | **Purpose**                                       | **Important fields**                                                                                                                     | **Relationships**                        | **Indexes and constraints**                                                                  |
| :---------------- | :------------------------------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------- | :------------------------------------------------------------------------------------------- |
| users             | Local product identity and lifecycle              | id uuid PK, status, consent_version, consented_at, created_at, updated_at, deleted_at                                                    | 1:1 account/settings; 1:N sessions       | Index status; consent required before active connection                                      |
| spotify_accounts  | Spotify account link and encrypted token envelope | id uuid PK, user_id FK, spotify_account_id, display_name, encrypted token fields, access/refresh expiries, scopes, state, authorized_at  | Belongs to user; owns history/sync state | Unique user_id; unique immutable spotify_account_id; index state/refresh expiry              |
| user_settings     | Analytics and UI preferences                      | user_id PK/FK, timezone, week_starts_on, default_range, theme, retention_days                                                            | 1:1 user                                 | Check week start 0-6; finite positive retention; valid timezone in application               |
| app_sessions      | Revocable opaque sessions                         | id uuid PK, user_id FK, token_hash, expires_at, last_seen_at, revoked_at                                                                 | N:1 user                                 | Unique token hash; indexes user and expiry; cleanup expired rows                             |
| oauth_states      | Single-use OAuth CSRF state                       | id uuid PK, state_hash, return_path, expires_at, used_at                                                                                 | Optional initiating user                 | Unique state hash; expiry index; cleanup after 24 hours                                      |
| artists           | Normalized artist metadata                        | id uuid PK, external_key, nullable spotify_id, name, spotify_uri, image_url, metadata_fetched_at, timestamps                             | M:N tracks; M:N albums                   | Unique external key; unique nullable Spotify ID; index normalized name                       |
| albums            | Normalized album metadata                         | id uuid PK, external_key, nullable spotify_id, name, album_type, partial release date fields, artwork URL, freshness timestamps          | 1:N tracks; M:N artists                  | Unique external key/nullable Spotify ID; indexes normalized name/release year                |
| album_artists     | Ordered album credits                             | album_id FK, artist_id FK, position                                                                                                      | Join album/artist                        | PK album+artist; unique album+position; artist index                                         |
| tracks            | Normalized track metadata                         | id uuid PK, external_key, nullable spotify_id, album_id FK, name, duration_ms, disc/track number, flags, URI, ISRC, freshness timestamps | N:1 album; M:N artists; 1:N history      | Unique external key/nullable Spotify ID; indexes album, normalized name, ISRC                |
| track_artists     | Ordered track credits                             | track_id FK, artist_id FK, position                                                                                                      | Join track/artist                        | PK track+artist; unique track+position; artist index                                         |
| listening_history | Immutable accepted play events                    | id uuid PK, spotify_account_id FK, track_id FK, played_at timestamptz, estimated_duration_ms, source, created_at                         | N:1 account and track                    | Unique account+track+played_at; indexes account+played_at desc, account+track+played_at desc |
| sync_state        | Durable schedule, cursor, lock, and error state   | spotify_account_id PK/FK, cursor, next/last times, status, failures, gap fields, lease owner/expiry, worker heartbeat                    | 1:1 Spotify account                      | Index due accounts (status,next_sync_at) and lease expiry                                    |
| sync_runs         | Bounded operational audit                         | id uuid PK, account FK, start/end, outcome, pages/items/inserted/duplicates, error class, request ID                                     | N:1 account                              | Index account+started_at desc; retain 90 days; never store tokens/raw payloads               |

## **Identity, time, and deletion rules**

- Use application-generated UUIDs. Public API IDs are internal UUIDs; Spotify external IDs remain separate.

- external_key is required. Use spotify:\<spotify_id\> when present; for local/unidentified items use local:\<sha256(normalized track name\|album name\|ordered artists\|duration)\>.

- Store all event and audit timestamps as timestamptz in UTC. Calendar aggregation converts to a validated IANA timezone.

- Use ON DELETE CASCADE from user to account, settings, sessions, history, sync state, and runs. Entity metadata can be deleted when no listening history references it.

- The disconnect transaction first disables the account and revokes sessions/tokens, then deletes user-scoped Spotify-derived data. A cleanup job retries failed deletion and must complete within five days under current Spotify terms.

- Default retention_days is 730. A daily job deletes history older than the user's disclosed cutoff, then purges orphaned tracks/albums/artists and expired metadata cache entries. Operators may change this only together with their published privacy policy and applicable review.

## **Suggested Prisma-style logical schema**

This is a logical model, not a copy-paste migration. Native PostgreSQL migrations must add check constraints, case-insensitive search support, partial indexes, and deletion behavior that the ORM schema cannot express completely.

> enum AccountState { ACTIVE NEEDS_REAUTH PAUSED BLOCKED DELETING }
>
> enum SyncStatus { IDLE RUNNING BACKOFF NEEDS_REAUTH PAUSED }
>
> enum SyncOutcome { SUCCEEDED FAILED RATE_LIMITED SKIPPED PARTIAL }
>
> enum HistorySource { SPOTIFY_API IMPORT }
>
> model User {
>
> id String @id @default(uuid()) @db.Uuid
>
> status String @default("ACTIVE")
>
> consentVersion String?
>
> consentedAt DateTime?
>
> createdAt DateTime @default(now())
>
> updatedAt DateTime @updatedAt
>
> deletedAt DateTime?
>
> spotifyAccount SpotifyAccount?
>
> settings UserSettings?
>
> sessions AppSession\[\]
>
> }
>
> model SpotifyAccount {
>
> id String @id @default(uuid()) @db.Uuid
>
> userId String @unique @db.Uuid
>
> spotifyAccountId String @unique
>
> displayName String?
>
> accessTokenEnvelope Json
>
> refreshTokenEnvelope Json
>
> accessTokenExpiresAt DateTime
>
> refreshTokenExpiresAt DateTime
>
> scopes String\[\]
>
> state AccountState @default(ACTIVE)
>
> authorizedAt DateTime @default(now())
>
> updatedAt DateTime @updatedAt
>
> user User @relation(fields: \[userId\], references: \[id\], onDelete: Cascade)
>
> history ListeningHistory\[\]
>
> syncState SyncState?
>
> syncRuns SyncRun\[\]
>
> @@index(\[state, refreshTokenExpiresAt\])
>
> }
>
> model UserSettings {
>
> userId String @id @db.Uuid
>
> timezone String @default("UTC")
>
> weekStartsOn Int @default(1)
>
> defaultRange String @default("LAST_30_DAYS")
>
> theme String @default("SYSTEM")
>
> retentionDays Int @default(730)
>
> user User @relation(fields: \[userId\], references: \[id\], onDelete: Cascade)
>
> }
>
> model AppSession {
>
> id String @id @default(uuid()) @db.Uuid
>
> userId String @db.Uuid
>
> tokenHash String @unique
>
> expiresAt DateTime
>
> lastSeenAt DateTime @default(now())
>
> revokedAt DateTime?
>
> user User @relation(fields: \[userId\], references: \[id\], onDelete: Cascade)
>
> @@index(\[userId\])
>
> @@index(\[expiresAt\])
>
> }
>
> model OAuthState {
>
> id String @id @default(uuid()) @db.Uuid
>
> stateHash String @unique
>
> returnPath String?
>
> expiresAt DateTime
>
> usedAt DateTime?
>
> createdAt DateTime @default(now())
>
> @@index(\[expiresAt\])
>
> }
>
> model Artist {
>
> id String @id @default(uuid()) @db.Uuid
>
> externalKey String @unique
>
> spotifyId String? @unique
>
> name String
>
> normalizedName String
>
> spotifyUri String?
>
> imageUrl String?
>
> metadataFetchedAt DateTime
>
> createdAt DateTime @default(now())
>
> updatedAt DateTime @updatedAt
>
> tracks TrackArtist\[\]
>
> albums AlbumArtist\[\]
>
> @@index(\[normalizedName\])
>
> }
>
> model Album {
>
> id String @id @default(uuid()) @db.Uuid
>
> externalKey String @unique
>
> spotifyId String? @unique
>
> name String
>
> normalizedName String
>
> albumType String?
>
> releaseDateText String?
>
> releaseDatePrecision String?
>
> releaseYear Int?
>
> spotifyUri String?
>
> artworkUrl String?
>
> metadataFetchedAt DateTime
>
> createdAt DateTime @default(now())
>
> updatedAt DateTime @updatedAt
>
> tracks Track\[\]
>
> artists AlbumArtist\[\]
>
> @@index(\[normalizedName\])
>
> @@index(\[releaseYear\])
>
> }
>
> model Track {
>
> id String @id @default(uuid()) @db.Uuid
>
> externalKey String @unique
>
> spotifyId String? @unique
>
> albumId String? @db.Uuid
>
> name String
>
> normalizedName String
>
> durationMs Int
>
> discNumber Int?
>
> trackNumber Int?
>
> explicit Boolean @default(false)
>
> isLocal Boolean @default(false)
>
> spotifyUri String?
>
> isrc String?
>
> metadataFetchedAt DateTime
>
> createdAt DateTime @default(now())
>
> updatedAt DateTime @updatedAt
>
> album Album? @relation(fields: \[albumId\], references: \[id\], onDelete: SetNull)
>
> artists TrackArtist\[\]
>
> history ListeningHistory\[\]
>
> @@index(\[albumId\])
>
> @@index(\[normalizedName\])
>
> @@index(\[isrc\])
>
> }
>
> model TrackArtist {
>
> trackId String @db.Uuid
>
> artistId String @db.Uuid
>
> position Int
>
> track Track @relation(fields: \[trackId\], references: \[id\], onDelete: Cascade)
>
> artist Artist @relation(fields: \[artistId\], references: \[id\], onDelete: Cascade)
>
> @@id(\[trackId, artistId\])
>
> @@unique(\[trackId, position\])
>
> @@index(\[artistId\])
>
> }
>
> model AlbumArtist {
>
> albumId String @db.Uuid
>
> artistId String @db.Uuid
>
> position Int
>
> album Album @relation(fields: \[albumId\], references: \[id\], onDelete: Cascade)
>
> artist Artist @relation(fields: \[artistId\], references: \[id\], onDelete: Cascade)
>
> @@id(\[albumId, artistId\])
>
> @@unique(\[albumId, position\])
>
> @@index(\[artistId\])
>
> }
>
> model ListeningHistory {
>
> id String @id @default(uuid()) @db.Uuid
>
> spotifyAccountId String @db.Uuid
>
> trackId String @db.Uuid
>
> playedAt DateTime
>
> estimatedDurationMs Int
>
> source HistorySource @default(SPOTIFY_API)
>
> createdAt DateTime @default(now())
>
> spotifyAccount SpotifyAccount @relation(fields: \[spotifyAccountId\], references: \[id\], onDelete: Cascade)
>
> track Track @relation(fields: \[trackId\], references: \[id\], onDelete: Restrict)
>
> @@unique(\[spotifyAccountId, trackId, playedAt\])
>
> @@index(\[spotifyAccountId, playedAt(sort: Desc), id(sort: Desc)\])
>
> @@index(\[spotifyAccountId, trackId, playedAt(sort: Desc)\])
>
> }
>
> model SyncState {
>
> spotifyAccountId String @id @db.Uuid
>
> status SyncStatus @default(IDLE)
>
> cursorPlayedAt DateTime?
>
> nextSyncAt DateTime @default(now())
>
> lastAttemptAt DateTime?
>
> lastSuccessAt DateTime?
>
> consecutiveFailures Int @default(0)
>
> probableGap Boolean @default(false)
>
> gapDetectedAt DateTime?
>
> gapReason String?
>
> leaseOwner String?
>
> leaseExpiresAt DateTime?
>
> workerHeartbeatAt DateTime?
>
> spotifyAccount SpotifyAccount @relation(fields: \[spotifyAccountId\], references: \[id\], onDelete: Cascade)
>
> @@index(\[status, nextSyncAt\])
>
> @@index(\[leaseExpiresAt\])
>
> }
>
> model SyncRun {
>
> id String @id @default(uuid()) @db.Uuid
>
> spotifyAccountId String @db.Uuid
>
> startedAt DateTime @default(now())
>
> finishedAt DateTime?
>
> outcome SyncOutcome
>
> pagesFetched Int @default(0)
>
> itemsFetched Int @default(0)
>
> eventsInserted Int @default(0)
>
> duplicates Int @default(0)
>
> errorClass String?
>
> requestId String
>
> spotifyAccount SpotifyAccount @relation(fields: \[spotifyAccountId\], references: \[id\], onDelete: Cascade)
>
> @@index(\[spotifyAccountId, startedAt(sort: Desc)\])
>
> }

# **9. API Specification**

## **API conventions**

- Base path: /api; JSON uses UTF-8 and camelCase.

- Successful responses use { "data": ..., "meta": { ... } }. Lists include an opaque nextCursor when more data exists.

- Errors use application/problem+json with type, title, status, safe detail, stable application code, and requestId.

- Dates are ISO 8601 UTC instants. Responses also return the effective IANA timezone and local bucket labels where relevant.

- Private analytics responses set Cache-Control: private, no-store.

- IDs in routes are internal UUIDs. Every lookup also constrains ownership through the authenticated user; an inaccessible ID normally returns 404.

- Query validation is strict: unknown enum values, dates, UUIDs, limits, and cursors return 400. Default/max page size is 50/100.

| **Method** | **Endpoint**             | **Purpose**                                                             | **Authentication**                            | **Request**                                                             | **Response**                                                    |
| :--------: | :----------------------- | :---------------------------------------------------------------------- | :-------------------------------------------- | :---------------------------------------------------------------------- | :-------------------------------------------------------------- |
|    GET     | /api/auth/spotify        | Begin OAuth authorization.                                              | Public, but consent cookie/record required    | Optional safe local returnTo                                            | 302 to Spotify or problem response                              |
|    GET     | /api/auth/callback       | Validate callback, exchange code, link account, create session.         | Public callback protected by state            | code,state or error,state query                                         | 302 to app; error redirects with non-sensitive code             |
|    POST    | /api/auth/logout         | Revoke local session and clear cookie.                                  | Session + CSRF/origin check                   | Empty body                                                              | 204                                                             |
|    GET     | /api/me                  | Return current local user, settings summary, connection and sync state. | Session                                       | None                                                                    | User/profile object without tokens                              |
|    GET     | /api/dashboard           | Return all dashboard widgets from one normalized range.                 | Session                                       | range or from,to; optional tz, metric                                   | KPI, top entity, recent plays, trend, comparison metadata       |
|    GET     | /api/history             | Browse play events.                                                     | Session                                       | Range, q, artistId, albumId, trackId, explicit, limit, cursor           | Event list and next cursor                                      |
|    GET     | /api/artists             | Search/rank artists represented in history.                             | Session                                       | Range, q, sort, limit, cursor                                           | Artist summaries                                                |
|    GET     | /api/artists/:id         | Artist detail and range metrics.                                        | Session                                       | UUID plus range/granularity                                             | Artist metadata, totals, top tracks/albums, trend, recent plays |
|    GET     | /api/albums              | Search/rank albums represented in history.                              | Session                                       | Range, q, sort, limit, cursor                                           | Album summaries                                                 |
|    GET     | /api/albums/:id          | Album detail and range metrics.                                         | Session                                       | UUID plus range/granularity                                             | Album metadata, totals, track breakdown, trend, recent plays    |
|    GET     | /api/tracks              | Search/rank tracks represented in history.                              | Session                                       | Range, q, sort, limit, cursor                                           | Track summaries                                                 |
|    GET     | /api/tracks/:id          | Track detail and range metrics.                                         | Session                                       | UUID plus range/granularity                                             | Track metadata, totals, trend, recent plays                     |
|    GET     | /api/stats               | Return one or more analytics series.                                    | Session                                       | metrics\[\], dimensions\[\], range, granularity, tz, optional entity ID | Series, totals, bucket definitions, metric caveats              |
|    GET     | /api/export              | Stream filtered history or aggregates.                                  | Session; stricter per-user rate limit         | \`type=history                                                          | stats, format=csv                                               |
|    GET     | /api/settings            | Retrieve preferences and policy/connection state.                       | Session                                       | None                                                                    | Settings, retention disclosure, token expiry, sync health       |
|   PATCH    | /api/settings            | Update allowed preferences.                                             | Session + CSRF/origin check                   | Partial timezone, week start, default range, theme                      | Validated saved settings                                        |
|    POST    | /api/sync                | Schedule a manual sync.                                                 | Session + CSRF/origin check                   | Empty body                                                              | 202 with queued time; 429 if manual limit exceeded              |
|    GET     | /api/sync/status         | Retrieve durable synchronization state and recent sanitized runs.       | Session                                       | Optional run limit \<=20                                                | State, probable gaps, last/next times, recent outcomes          |
|    POST    | /api/account/reauthorize | Begin a fresh Spotify authorization for the linked user.                | Session + CSRF/origin check                   | Empty body                                                              | 302/authorization URL handled server-side                       |
|   DELETE   | /api/account/spotify     | Disconnect and delete Spotify-derived data.                             | Recent session + CSRF + explicit confirmation | { "confirmation": "DELETE" }                                            | 202/204 with deletion status; account disabled immediately      |
|    GET     | /api/health              | Container readiness and build identity.                                 | Public                                        | None                                                                    | 200 {status:"ok",version,db:"ok",requestId} or 503 degraded     |

## **Authorization and query rules**

- Central middleware resolves the session hash to a live user, attaches userId, rejects expired/revoked sessions, and rotates sessions after login and privilege-sensitive actions.

- Data functions require userId as a non-optional first argument. Repository methods must not offer unscoped entity reads to route handlers.

- range=custom requires both from and to; other presets reject conflicting custom parameters.

- Range end is exclusive internally. A user-entered end date is converted to the next local midnight before UTC conversion.

- Maximum interactive statistics range is the user's retained data. Export can stream the same range without loading it into memory.

- API rate limits: auth start 10/IP/10 minutes; manual sync 1/user/minute; export 3/user/10 minutes; general API 120/session/minute with burst tolerance. Store limit counters in PostgreSQL for the MVP.

# **10. Technology Stack**

| **Layer**      | **Selection**                                                                          | **Rationale**                                                                                                                                                                                                                                                                   |
| :------------- | :------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Web framework  | Next.js App Router, current supported stable at implementation                         | One TypeScript codebase for responsive UI, server rendering, route handlers, cookies, and self-hosted Node deployment. Next.js documents a minimal production standalone Docker output. See [<u>Next.js deployment</u>](https://nextjs.org/docs/app/getting-started/deploying). |
| UI             | React + TypeScript in strict mode                                                      | Mature component model and end-to-end shared types; strict TypeScript reduces data-shape ambiguity.                                                                                                                                                                             |
| Styling        | Tailwind CSS + small accessible component primitives                                   | Fast responsive implementation without importing another product's visual assets or brand.                                                                                                                                                                                      |
| Runtime        | Node.js 24 LTS, pinned to a supported patch/digest                                     | Node recommends Active or Maintenance LTS for production; v24 is LTS as of this specification. See [<u>Node.js releases</u>](https://nodejs.org/en/about/previous-releases).                                                                                                    |
| API            | Next.js route handlers with service/repository separation                              | Avoids a second HTTP server while keeping business logic testable and reusable by the worker.                                                                                                                                                                                   |
| Validation     | Zod at environment, OAuth payload, API, and worker boundaries                          | Runtime validation is required because Spotify and HTTP inputs are untrusted.                                                                                                                                                                                                   |
| Database       | PostgreSQL 18                                                                          | Relational integrity, time aggregation, transactions, unique constraints, JSON support for encrypted envelopes, and reliable backups.                                                                                                                                           |
| ORM/migrations | Prisma Client + Prisma Migrate                                                         | Typed access and explicit migrations; production applies committed migrations with prisma migrate deploy. See [<u>Prisma production migrations</u>](https://www.prisma.io/docs/orm/prisma-client/deployment/deploy-database-changes-with-prisma-migrate).                       |
| Charts         | Apache ECharts loaded in client-only chart components                                  | Mature line/bar/heatmap/treemap support; one library covers every required analysis. Enable ECharts ARIA and provide an HTML table alternative.                                                                                                                                 |
| Logging        | Pino structured JSON logs                                                              | Fast structured logging with redaction, request IDs, level control, and container-friendly stdout.                                                                                                                                                                              |
| Tests          | Vitest, React Testing Library, Playwright, Testcontainers or Compose test project, MSW | Covers pure logic, UI, OAuth/API boundaries, PostgreSQL integration, and browser flows.                                                                                                                                                                                         |
| Packaging      | Docker BuildKit multi-stage Dockerfile                                                 | Reproducible builds and a smaller runtime by copying only required artifacts. See [<u>Docker multi-stage builds</u>](https://docs.docker.com/build/building/multi-stage/).                                                                                                      |
| Orchestration  | Docker Compose v2                                                                      | Simple, reliable single-host deployment with health-gated dependencies and named volumes.                                                                                                                                                                                       |

## **Stack constraints**

- Pin all direct dependency versions and commit package-lock.json; automated update tooling may open reviewed updates, never deploy floating majors.

- Use server components for initial private-page data where useful, client components only for interactive filters/charts, and dynamic(...,{ssr:false}) for ECharts.

- Do not prefix secrets with NEXT_PUBLIC\_. Next.js explicitly inlines such variables into browser bundles; server-only variables remain unprefixed. See [<u>Next.js self-hosting environment guidance</u>](https://nextjs.org/docs/app/guides/self-hosting).

- Put an HTTPS reverse proxy such as Caddy, Traefik, or Nginx in front of the loopback-bound app. The proxy is an operator prerequisite, not a required Compose service, because many self-hosters already run one.

- Do not add Redis until measured needs require multi-host queues, high-volume shared caching, or distributed rate limiting. PostgreSQL is sufficient for the MVP's users and one worker.

# **11. Repository Structure**

> /
>
> ├── src/
>
> │ ├── app/
>
> │ │ ├── (public)/
>
> │ │ │ ├── login/page.tsx
>
> │ │ │ ├── privacy/page.tsx
>
> │ │ │ └── terms/page.tsx
>
> │ │ ├── (authenticated)/
>
> │ │ │ ├── page.tsx
>
> │ │ │ ├── history/page.tsx
>
> │ │ │ ├── statistics/page.tsx
>
> │ │ │ ├── tracks/\[id\]/page.tsx
>
> │ │ │ ├── artists/\[id\]/page.tsx
>
> │ │ │ ├── albums/\[id\]/page.tsx
>
> │ │ │ └── settings/page.tsx
>
> │ │ ├── api/
>
> │ │ │ ├── auth/spotify/route.ts
>
> │ │ │ ├── auth/callback/route.ts
>
> │ │ │ ├── auth/logout/route.ts
>
> │ │ │ ├── me/route.ts
>
> │ │ │ ├── dashboard/route.ts
>
> │ │ │ ├── history/route.ts
>
> │ │ │ ├── artists/\[id\]/route.ts
>
> │ │ │ ├── albums/\[id\]/route.ts
>
> │ │ │ ├── tracks/\[id\]/route.ts
>
> │ │ │ ├── stats/route.ts
>
> │ │ │ ├── export/route.ts
>
> │ │ │ ├── settings/route.ts
>
> │ │ │ ├── sync/route.ts
>
> │ │ │ ├── account/spotify/route.ts
>
> │ │ │ └── health/route.ts
>
> │ │ ├── layout.tsx
>
> │ │ └── globals.css
>
> │ ├── components/
>
> │ │ ├── charts/
>
> │ │ ├── dashboard/
>
> │ │ ├── entities/
>
> │ │ ├── filters/
>
> │ │ ├── layout/
>
> │ │ └── ui/
>
> │ ├── features/
>
> │ │ ├── auth/
>
> │ │ ├── dashboard/
>
> │ │ ├── history/
>
> │ │ ├── library/
>
> │ │ ├── settings/
>
> │ │ └── statistics/
>
> │ ├── lib/
>
> │ │ ├── api/
>
> │ │ │ ├── errors.ts
>
> │ │ │ ├── pagination.ts
>
> │ │ │ └── responses.ts
>
> │ │ ├── auth/
>
> │ │ │ ├── csrf.ts
>
> │ │ │ ├── oauth-state.ts
>
> │ │ │ ├── sessions.ts
>
> │ │ │ └── spotify-oauth.ts
>
> │ │ ├── crypto/token-envelope.ts
>
> │ │ ├── db/
>
> │ │ │ ├── client.ts
>
> │ │ │ └── repositories/
>
> │ │ ├── observability/
>
> │ │ ├── spotify/
>
> │ │ │ ├── client.ts
>
> │ │ │ ├── normalize.ts
>
> │ │ │ ├── rate-limit.ts
>
> │ │ │ ├── schemas.ts
>
> │ │ │ └── tokens.ts
>
> │ │ ├── stats/
>
> │ │ │ ├── dates.ts
>
> │ │ │ ├── definitions.ts
>
> │ │ │ └── queries.ts
>
> │ │ ├── env.ts
>
> │ │ └── validation.ts
>
> │ ├── worker/
>
> │ │ ├── index.ts
>
> │ │ ├── scheduler.ts
>
> │ │ ├── sync-account.ts
>
> │ │ ├── retention.ts
>
> │ │ └── healthcheck.ts
>
> │ └── types/
>
> ├── prisma/
>
> │ ├── migrations/
>
> │ ├── schema.prisma
>
> │ └── seed.ts
>
> ├── scripts/
>
> │ ├── deploy.sh
>
> │ ├── backup.sh
>
> │ ├── validate-env.mjs
>
> │ └── smoke-test.mjs
>
> ├── tests/
>
> │ ├── unit/
>
> │ ├── integration/
>
> │ ├── e2e/
>
> │ ├── fixtures/
>
> │ └── smoke/
>
> ├── public/
>
> ├── docs/
>
> │ ├── architecture.md
>
> │ ├── operations.md
>
> │ ├── privacy-template.md
>
> │ └── runbooks/
>
> ├── .dockerignore
>
> ├── .env.example
>
> ├── .gitignore
>
> ├── Dockerfile
>
> ├── docker-compose.yml
>
> ├── next.config.ts
>
> ├── package.json
>
> ├── package-lock.json
>
> ├── tailwind.config.ts
>
> ├── tsconfig.json
>
> ├── vitest.config.ts
>
> ├── playwright.config.ts
>
> ├── LICENSE
>
> └── README.md

Route files remain thin. OAuth, synchronization, statistics, and persistence rules belong in service modules and repositories so unit/integration tests can exercise them without rendering pages.

# **12. Docker Specification**

## **Required services**

| **Service** | **Purpose**                                    |                            **Port**                             | **Dependencies**                                 | **Persistent storage**                              | **Health check**                                             |
| :---------- | :--------------------------------------------- | :-------------------------------------------------------------: | :----------------------------------------------- | :-------------------------------------------------- | :----------------------------------------------------------- |
| postgres    | Durable PostgreSQL database                    |               Internal 5432 only; no host mapping               | None                                             | Named volume postgres_data:/var/lib/postgresql/data | pg_isready using configured DB/user                          |
| migrate     | One-shot production migration gate             |                              None                               | postgres healthy                                 | None                                                | Exit 0 after prisma migrate deploy; not long-running         |
| app         | Next.js UI and API                             | Container 3000; bind host to 127.0.0.1:\${HOST_PORT} by default | postgres healthy; migrate completed successfully | None; only tmpfs for /tmp                           | Node fetch to http://127.0.0.1:3000/api/health               |
| worker      | Scheduled Spotify sync, retention, and cleanup |                              None                               | postgres healthy; migrate completed successfully | None                                                | Worker health command verifies heartbeat and database access |

There are three required long-running services: app, worker, and PostgreSQL. migrate is a required one-shot job. Redis is intentionally excluded.

## **Container requirements**

- App and worker run the same versioned runtime image and code revision; the migrate target is built from the same Dockerfile.

- Run Node processes as an unprivileged user, enable init: true, set no-new-privileges, drop all Linux capabilities for app/worker, use a read-only root filesystem, and provide only required tmpfs paths.

- App and worker share an ordinary egress network for Spotify/HTTPS and a separate internal database network. PostgreSQL joins only the internal network.

- PostgreSQL is never published to the host. App binds to loopback unless the operator explicitly changes BIND_ADDRESS after understanding exposure.

- All services use restart: unless-stopped except one-shot migration. Add a 30-second stop grace period to app/worker.

- Health checks have a start period and bounded retries; they must not require curl in the slim runtime.

- No secrets appear in image layers, Compose defaults, command arguments, labels, or health output. Runtime values come from .env or an operator-provided secrets mechanism.

# **13. Docker Compose Requirements**

The implementation must preserve the following service relationships. Docker Compose supports service_healthy and service_completed_successfully dependency gates; see [<u>Docker startup order</u>](https://docs.docker.com/compose/how-tos/startup-order/).

> name: resonance-ledger
>
> x-runtime: &runtime
>
> build:
>
> context: .
>
> target: runtime
>
> image: \${APP_IMAGE:-resonance-ledger}:\${APP_VERSION:-local}
>
> env_file: \[.env\]
>
> init: true
>
> restart: unless-stopped
>
> read_only: true
>
> tmpfs:
>
> \- /tmp:size=64m,mode=1777
>
> security_opt:
>
> \- no-new-privileges:true
>
> cap_drop: \[ALL\]
>
> stop_grace_period: 30s
>
> services:
>
> postgres:
>
> image: postgres:18-alpine
>
> restart: unless-stopped
>
> environment:
>
> POSTGRES_DB: \${POSTGRES_DB:?required}
>
> POSTGRES_USER: \${POSTGRES_USER:?required}
>
> POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?required}
>
> volumes:
>
> \- postgres_data:/var/lib/postgresql/data
>
> networks: \[database\]
>
> healthcheck:
>
> test: \[CMD-SHELL, "pg_isready -U \$\$POSTGRES_USER -d \$\$POSTGRES_DB"\]
>
> interval: 10s
>
> timeout: 5s
>
> retries: 12
>
> start_period: 20s
>
> migrate:
>
> build:
>
> context: .
>
> target: migrator
>
> image: \${APP_IMAGE:-resonance-ledger}-migrator:\${APP_VERSION:-local}
>
> env_file: \[.env\]
>
> command: \["npx", "prisma", "migrate", "deploy"\]
>
> restart: "no"
>
> depends_on:
>
> postgres:
>
> condition: service_healthy
>
> networks: \[database\]
>
> app:
>
> \<\<: \*runtime
>
> command: \["node", "server.js"\]
>
> ports:
>
> \- "\${BIND_ADDRESS:-127.0.0.1}:\${HOST_PORT:-3000}:3000"
>
> depends_on:
>
> postgres:
>
> condition: service_healthy
>
> migrate:
>
> condition: service_completed_successfully
>
> networks: \[egress, database\]
>
> healthcheck:
>
> test: \[CMD, "node", "scripts/container-app-health.mjs"\]
>
> interval: 15s
>
> timeout: 5s
>
> retries: 8
>
> start_period: 30s
>
> worker:
>
> \<\<: \*runtime
>
> command: \["node", "dist/worker/index.js"\]
>
> depends_on:
>
> postgres:
>
> condition: service_healthy
>
> migrate:
>
> condition: service_completed_successfully
>
> networks: \[egress, database\]
>
> healthcheck:
>
> test: \[CMD, "node", "dist/worker/healthcheck.js"\]
>
> interval: 30s
>
> timeout: 10s
>
> retries: 4
>
> start_period: 45s
>
> volumes:
>
> postgres_data:
>
> networks:
>
> egress:
>
> driver: bridge
>
> database:
>
> driver: bridge
>
> internal: true

This is a normative outline: the implementation must resolve YAML-anchor merges correctly, pin production image digests, and make health scripts part of the runtime image. docker compose config is the authority for the rendered configuration. A fresh configured installation must succeed with docker compose up -d; migrate may remain in exited state with code 0.

## **Production Dockerfile specification**

Use one multi-stage Dockerfile with these named stages:

1.  **base** - pinned node:24-bookworm-slim digest, working directory /app, production-safe npm settings, and required CA certificates only.

2.  **deps** - copy package.json and package-lock.json; run npm ci; never copy .env.

3.  **builder** - copy source and Prisma schema; run npx prisma generate, strict typecheck, worker bundle build, and next build with output: "standalone".

4.  **runtime-deps** - create a pruned production dependency tree needed by the bundled worker and Prisma Client.

5.  **runtime** - create fixed non-root UID/GID, copy .next/standalone, .next/static, public, production dependencies/Prisma engines, worker output, health scripts, and license notices. Set NODE_ENV=production, PORT=3000, HOSTNAME=0.0.0.0, STOPSIGNAL SIGTERM, and CMD \["node","server.js"\].

6.  **migrator** - copy the Prisma CLI, schema, migrations, and required production dependencies; default command is npx prisma migrate deploy. It contains no application secret at build time.

The final stages must contain no compiler, source maps with secrets, test fixtures, package-manager cache, .git, .env\*, backups, or development server. Use .dockerignore; record OCI source/revision/version labels; produce an SBOM in CI; and scan both runtime and migrator images before release.

# **14. Deployment Script Specification**

scripts/deploy.sh is an operator-safe, noninteractive deployment/update orchestrator. It must begin with \#!/usr/bin/env bash and set -euo pipefail.

## **Required behavior**

1.  Resolve the repository root from the script's own location and cd there; reject execution from an incomplete checkout.

2.  Acquire a local deployment lock with flock or an atomic lock directory so two deployments cannot overlap.

3.  Verify docker exists, the daemon is reachable, and docker compose version succeeds. Reject legacy standalone docker-compose as the only implementation unless explicitly supported and tested.

4.  Verify .env exists, is a regular file, is not group/world-readable when it contains secrets, and is not a symlink to an unexpected location.

5.  Validate every required environment variable without source, eval, or printing values. Use scripts/validate-env.mjs or an equally strict parser. Validate URLs, integer ranges, distinct secrets, and redirect/callback consistency.

6.  Run docker compose --env-file .env config --quiet. Never print fully rendered configuration because it may contain secrets.

7.  If APP_IMAGE identifies a registry release, pull exact versioned images. Otherwise build with BuildKit and --pull; do not use floating latest in production.

8.  Start PostgreSQL only: docker compose up -d postgres.

9.  Wait up to 120 seconds for the PostgreSQL container health state, polling without printing credentials. On timeout, print sanitized service status and the last bounded PostgreSQL log lines.

10. Run docker compose run --rm migrate (or an equivalent one-shot compose invocation) and require exit 0 before replacing app/worker.

11. Start/update app and worker with docker compose up -d app worker. Do not call down, delete volumes, prune images/volumes, or remove unrelated containers.

12. Wait up to 180 seconds for app and worker health. Confirm /api/health from inside the app container and, when APP_URL is reachable, from the host through the reverse proxy.

13. Run a read-only smoke test: current migration status, health response schema, and service state. Do not trigger OAuth or mutate history during an unattended deploy.

14. Show docker compose ps and a concise completion summary containing version, elapsed time, and health—not secret values.

15. Return non-zero on any failure. A trap records the failed step, prints safe diagnostic commands/log tails, and leaves the previous database volume intact.

## **Console contract**

Use timestamped single-line messages: \[INFO\], \[OK\], \[WARN\], \[ERROR\]. Suggested milestones are “Preflight,” “Configuration valid,” “Database healthy,” “Migrations applied,” “Application healthy,” and “Deployment complete.” Redact substrings matching known secrets and authorization header/token patterns from any diagnostic output.

## **Update and rollback boundary**

- Create a database backup before schema-changing production updates when BACKUP_BEFORE_DEPLOY=true; abort deployment if that requested backup fails.

- Record the prior image tag/digest before update. Application rollback may restore the prior image only when migrations are backward compatible.

- Never automatically roll back database migrations or restore backups. Print an operator runbook reference and stop.

- Never run docker compose down -v, docker volume rm, docker system prune --volumes, or equivalent destructive commands.

# **15. Backup Script**

scripts/backup.sh must also use set -euo pipefail, resolve the project root safely, and share the environment validator.

## **Required behavior**

1.  Verify Docker/Compose, .env, the configured backup directory, and a healthy PostgreSQL service.

2.  Reject an empty, root, home-root, or unresolved backup path. Create the exact configured directory with mode 0700 if absent.

3.  Generate UTC filenames such as resonance-ledger_20260903T221530Z.dump.

4.  Run pg_dump -Fc inside the PostgreSQL container, streaming to a temporary host file in the backup directory; do not expose the password on the process command line.

5.  Require non-empty output, inspect stderr for failure, and run pg_restore --list against the file as a basic readability check. PostgreSQL documents custom format as compressed and flexible for restore; see [<u>PostgreSQL pg_dump</u>](https://www.postgresql.org/docs/current/app-pgdump.html).

6.  Atomically rename the verified temporary file to the final timestamped name and set mode 0600.

7.  Print the filename, byte size, UTC completion time, and checksum; never print credentials.

8.  Optional retention: when BACKUP_RETENTION_DAYS is a validated positive integer, delete only matching resonance-ledger\_\*.dump regular files inside the resolved backup directory that exceed the age. Report each deletion count. Never follow symlinks or recurse outside the exact directory.

9.  Exit non-zero on dump, validation, checksum, rename, or retention errors. Leave a failed temporary file clearly suffixed .failed for diagnosis unless it contains no useful bytes.

A backup is not complete operationally until a restore drill has succeeded in a disposable database. Document quarterly restore testing. For higher recovery objectives, add encrypted off-host copies and PostgreSQL WAL/PITR after the MVP; pg_dump alone is a logical backup, not point-in-time recovery.

# **16. Environment Variables**

| **Variable**                 | **Required** | **Example placeholder**                                                | **Description**                                                                         |
| :--------------------------- | :----------: | :--------------------------------------------------------------------- | :-------------------------------------------------------------------------------------- |
| NODE_ENV                     |     Yes      | production                                                             | Must equal production in deployed app/worker.                                           |
| APP_URL                      |     Yes      | https://music.example.com                                              | Canonical external HTTPS origin; no path or trailing slash.                             |
| PORT                         |     Yes      | 3000                                                                   | Internal application listen port; normally 3000.                                        |
| HOST_PORT                    |      No      | 3000                                                                   | Host loopback port mapped to the app.                                                   |
| BIND_ADDRESS                 |      No      | 127.0.0.1                                                              | Host bind address; default loopback for reverse proxy.                                  |
| DATABASE_URL                 |     Yes      | postgresql://resonance:CHANGE_ME@postgres:5432/resonance?schema=public | App/worker/migrator PostgreSQL connection URI; URL-encode reserved password characters. |
| POSTGRES_DB                  |     Yes      | resonance                                                              | Database created by PostgreSQL image.                                                   |
| POSTGRES_USER                |     Yes      | resonance                                                              | Dedicated application database role.                                                    |
| POSTGRES_PASSWORD            |     Yes      | CHANGE_TO_RANDOM_VALUE                                                 | Strong random database password; must match DATABASE_URL.                               |
| SPOTIFY_CLIENT_ID            |     Yes      | your_spotify_client_id                                                 | Spotify Developer Dashboard client ID.                                                  |
| SPOTIFY_CLIENT_SECRET        |     Yes      | your_spotify_client_secret                                             | Confidential client secret used only by backend OAuth/token calls.                      |
| SPOTIFY_REDIRECT_URI         |     Yes      | https://music.example.com/api/auth/callback                            | Exact allowlisted callback; must share APP_URL origin.                                  |
| SESSION_SECRET               |     Yes      | base64_32_or_more_random_bytes                                         | Key material for signed state/cookie helpers; distinct from token key.                  |
| TOKEN_ENCRYPTION_KEY         |     Yes      | base64_exactly_32_random_bytes                                         | AES-256-GCM token-encryption key; version/rotation strategy required.                   |
| TOKEN_ENCRYPTION_KEY_VERSION |     Yes      | v1                                                                     | Stored with token envelopes to support rotation.                                        |
| SYNC_INTERVAL_SECONDS        |     Yes      | 180                                                                    | Per-account target interval; allowed 60-900.                                            |
| SYNC_OVERLAP_SECONDS         |      No      | 300                                                                    | Cursor overlap; allowed 60-900 and not less than sync interval.                         |
| DATA_RETENTION_DAYS          |     Yes      | 730                                                                    | Default finite history retention disclosed in privacy policy.                           |
| SYNC_RUN_RETENTION_DAYS      |      No      | 90                                                                     | Operational sync-run audit retention.                                                   |
| LOG_LEVEL                    |      No      | info                                                                   | One of trace/debug/info/warn/error; production default info.                            |
| TRUST_PROXY                  |     Yes      | 1                                                                      | Number/setting of trusted reverse proxies; must be explicit for secure-origin checks.   |
| APP_IMAGE                    |      No      | ghcr.io/example/resonance-ledger                                       | Registry repository or local image name; deploy with immutable version.                 |
| APP_VERSION                  |      No      | 1.0.0                                                                  | Image tag/build version; never latest in production.                                    |
| BACKUP_DIR                   |      No      | /var/backups/resonance-ledger                                          | Absolute host directory used by backup script.                                          |
| BACKUP_RETENTION_DAYS        |      No      | 30                                                                     | Optional local backup retention; positive integer.                                      |
| BACKUP_BEFORE_DEPLOY         |      No      | true                                                                   | Require backup before production update.                                                |
| TZ                           |      No      | UTC                                                                    | Container operational timezone; stored event time remains UTC.                          |

## .env.example **specification**

> NODE_ENV=production
>
> APP_URL=https://music.example.com
>
> PORT=3000
>
> HOST_PORT=3000
>
> BIND_ADDRESS=127.0.0.1
>
> POSTGRES_DB=resonance
>
> POSTGRES_USER=resonance
>
> POSTGRES_PASSWORD=CHANGE_TO_RANDOM_VALUE
>
> DATABASE_URL=postgresql://resonance:CHANGE_TO_URL_ENCODED_RANDOM_VALUE@postgres:5432/resonance?schema=public
>
> SPOTIFY_CLIENT_ID=your_spotify_client_id
>
> SPOTIFY_CLIENT_SECRET=your_spotify_client_secret
>
> SPOTIFY_REDIRECT_URI=https://music.example.com/api/auth/callback
>
> SESSION_SECRET=CHANGE_TO_BASE64_32_OR_MORE_RANDOM_BYTES
>
> TOKEN_ENCRYPTION_KEY=CHANGE_TO_BASE64_EXACTLY_32_RANDOM_BYTES
>
> TOKEN_ENCRYPTION_KEY_VERSION=v1
>
> SYNC_INTERVAL_SECONDS=180
>
> SYNC_OVERLAP_SECONDS=300
>
> DATA_RETENTION_DAYS=730
>
> SYNC_RUN_RETENTION_DAYS=90
>
> LOG_LEVEL=info
>
> TRUST_PROXY=1
>
> TZ=UTC
>
> APP_IMAGE=resonance-ledger
>
> APP_VERSION=1.0.0
>
> BACKUP_DIR=/var/backups/resonance-ledger
>
> BACKUP_RETENTION_DAYS=30
>
> BACKUP_BEFORE_DEPLOY=true

The committed .env.example contains placeholders only. .env, .env.local, backups, exported history, and token-key files are ignored by Git. Startup validation must reject placeholder strings, weak/equal secrets, non-HTTPS production URLs, callback mismatches, invalid integer ranges, and a database hostname other than the Compose service name unless explicitly operating in an external-database mode.

# **17. Security Requirements**

The threat model assumes an internet-facing HTTPS reverse proxy, untrusted browser input, untrusted Spotify responses, a possibly curious co-tenant user, and an attacker who can read logs but not runtime secrets. Host-root compromise is outside the application's protection boundary; backups and the database remain sensitive even though Spotify tokens are encrypted.

## **Authentication, OAuth, and sessions**

- Generate OAuth state and session tokens with a cryptographically secure random generator. OAuth state is at least 256 bits, single-use, transaction-bound, stored hashed, and expires after 10 minutes.

- Validate exact callback origin/path from configuration; never accept a request-provided redirect URI or open redirect.

- Regenerate the application session after OAuth callback. Store only the SHA-256 session-token hash; compare in constant time; use idle and absolute expiry; revoke on logout, disconnect, password/key incident, or user deletion.

- Production session cookie: \_\_Host-resonance_session, Secure, HttpOnly, SameSite=Lax, Path=/, no Domain. OAuth's cross-site top-level redirect requires Lax behavior. [<u>OWASP session guidance</u>](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) recommends explicit Secure/HttpOnly/SameSite attributes and host-only scope.

- Destructive and state-changing endpoints require same-origin Origin/Host validation plus a per-session synchronizer CSRF token submitted in a custom header or form field. SameSite is defense in depth, not the only control.

- Require a recently authenticated session for disconnect/delete. Use an explicit typed confirmation and make the result idempotent.

## **Secret and token protection**

- Spotify client secret, session secret, token-encryption key, database password, and backup credentials are server-only runtime secrets. They never use NEXT_PUBLIC\_, never appear in JSON/HTML, and never enter Docker build arguments.

- Encrypt Spotify access and refresh tokens with AES-256-GCM using a unique 96-bit nonce per encryption and authenticated context containing account ID, token type, and key version. Never reuse a nonce/key pair.

- Support a rotation operation that reads an old key version and re-encrypts to the active version in bounded batches. Keep old keys only until rotation and rollback verification finish.

- Prefer a Docker/host secret store for production. If .env is used, require owner-only mode, secure backups, and documented rotation. OWASP advises protecting tokens in storage and not placing them in browser local storage; see [<u>OWASP Secrets Management</u>](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html).

- Restrict the PostgreSQL application role to its database/schema. Migration credentials may own schema changes but must not be used by the steady-state app when separate roles are practical.

## **Application and API controls**

| **Area**         | **Requirement**                                                                                                                                                                                                                                                                                                      |
| :--------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input validation | Parse every route/query/body/environment/Spotify payload with allowlisted schemas, size limits, UUID/date/URL validation, and safe defaults. Reject unknown fields on mutations.                                                                                                                                     |
| SQL injection    | Use Prisma parameterization. Raw SQL is allowed only in reviewed repository helpers with positional parameters; never concatenate user input into SQL, sort expressions, or identifiers.                                                                                                                             |
| XSS              | Rely on React escaping, never render Spotify/user text with dangerouslySetInnerHTML, sanitize any future Markdown/HTML, and validate image URLs against exact HTTPS hosts.                                                                                                                                           |
| CSRF             | State for OAuth; same-origin checks and synchronizer token for POST/PATCH/DELETE; no state-changing GET routes.                                                                                                                                                                                                      |
| SSRF             | Do not fetch arbitrary user URLs. Allowlist Spotify API origins and approved image CDN origins; validate every Spotify next URL before following it.                                                                                                                                                                 |
| Rate limiting    | Apply bounded per-IP auth limits and per-user manual-sync/export/API limits. Return 429 with safe retry metadata.                                                                                                                                                                                                    |
| Authorization    | Scope every repository query by authenticated user/account. Do not rely only on UI-hidden controls. Test cross-user object IDs.                                                                                                                                                                                      |
| Browser headers  | CSP with nonces, frame-ancestors 'none', object-src 'none', restricted connect-src/img-src; HSTS at proxy; Referrer-Policy: no-referrer; X-Content-Type-Options: nosniff; restrictive Permissions Policy.                                                                                                            |
| CORS             | Same-origin UI/API requires no permissive CORS. If enabled later, exact origins only with credential review; never \* with credentials.                                                                                                                                                                              |
| Logs             | Structured allowlist fields and recursive redaction for tokens, cookies, auth codes, secrets, DATABASE_URL, authorization headers, and raw Spotify bodies. OWASP warns that logs can contain technical secrets; see [<u>OWASP Logging</u>](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html). |
| Exports          | Stream only the current user's data; set Content-Disposition: attachment, nosniff, no-store; CSV-prefix cells beginning =, +, -, or @ to prevent spreadsheet formula injection.                                                                                                                                      |
| Dependencies     | Lockfile, automated reviewed updates, npm audit/OSV scan, container scan, SBOM, and supported runtime versions. Critical exploitable findings block release.                                                                                                                                                         |
| Error handling   | Production errors reveal no stack, query, secret, provider payload, or existence of another user's object. Correlate with request ID.                                                                                                                                                                                |

## **Privacy and Spotify-platform compliance**

- Collect only profile identity needed for linking, recently played events, and entity metadata required for display/statistics. Do not request email or unrelated scopes.

- Display a versioned privacy policy and required terms before connection. Record consent version/time.

- Use a finite, disclosed retention period; run and monitor deletion. “All retained history” must not imply perpetual retention.

- Provide export, disconnect, and deletion in Settings. Disconnect disables future API calls immediately and deletes Spotify Personal Data within the current five-day contractual boundary, preferably synchronously.

- Store remote artwork URLs only while referenced and current. Any image optimization cache is temporary, bounded, and non-durable; do not build a permanent artwork archive.

- Do not sell or send Spotify-derived data to analytics/ad vendors. Self-hosted telemetry is opt-in and must exclude Spotify content and personal data.

- Complete legal review of the operator privacy policy, end-user agreement, retention choice, and Spotify terms before inviting users beyond a private installation.

## **Security verification gates**

- Threat model and data-flow review completed before OAuth merge.

- Secret scan of Git history and built image returns no real credentials.

- Cross-tenant authorization tests, CSRF tests, cookie-header tests, SSRF tests, and log-redaction tests pass.

- Dependency/container scan has no unaccepted critical/high exploitable findings.

- Token key loss, rotation, and suspected compromise have documented runbooks.

# **18. Reliability Requirements**

| **Capability**     | **Requirement**                                                                                                                                                                                                        | **Verification**                                                                                                                                                                                                                         |
| :----------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Graceful shutdown  | App stops accepting new work on SIGTERM, completes in-flight HTTP requests, and exits within 30 seconds. Worker stops leasing, finishes or rolls back the current transaction, releases/lets lease expire, then exits. | Send SIGTERM during API request and sync fixture; no corrupt/half-advanced cursor. Next.js recommends a 10-30 second drain for self-hosted shutdown. See [<u>Next.js self-hosting</u>](https://nextjs.org/docs/app/guides/self-hosting). |
| Database recovery  | Use bounded connection pool, startup retry with jitter, statement/transaction timeouts, and retry only safe transient serialization/connection failures.                                                               | Restart PostgreSQL; app becomes unhealthy then recovers without container recreation or duplicate events.                                                                                                                                |
| Spotify retry      | Timeouts, 401 refresh-once, 429 Retry-After, and capped exponential full-jitter retry for network/5xx.                                                                                                                 | Deterministic fault-injection tests for every status.                                                                                                                                                                                    |
| State persistence  | Cursor, next run, leases, failures, gaps, and account state persist in PostgreSQL.                                                                                                                                     | Restart worker mid-run and after commit; behavior is idempotent.                                                                                                                                                                         |
| Logging            | JSON to stdout/stderr with timestamp, level, service, version, request/run ID, safe user/account surrogate, event, duration, outcome.                                                                                  | Schema/log-redaction tests and sample operational queries.                                                                                                                                                                               |
| Liveness/readiness | /api/health checks process plus a bounded SELECT 1; worker health checks recent heartbeat and DB; no external Spotify call in health check.                                                                            | Docker health transitions correct during DB outage.                                                                                                                                                                                      |
| Docker restart     | unless-stopped, health gates, SIGTERM, non-root, no local durable state.                                                                                                                                               | Reboot host and restart containers; data and cursor persist.                                                                                                                                                                             |
| Migration safety   | Forward migrations are committed, reviewed, tested against a production-like backup, and applied once before new app/worker start.                                                                                     | Fresh and upgrade-path migration suites pass.                                                                                                                                                                                            |
| Backups            | Daily logical backup recommended; verified checksum/list; off-host encrypted copy recommended; quarterly restore drill.                                                                                                | Restore a backup into disposable PostgreSQL and run consistency/smoke queries.                                                                                                                                                           |
| Clock/timezone     | Host uses NTP; database stores UTC; application uses IANA timezone library and explicit DST tests.                                                                                                                     | Spring-forward/fall-back fixtures produce correct local buckets.                                                                                                                                                                         |
| Metadata change    | Upserts update names/URLs/freshness without rewriting immutable event time/duration snapshot.                                                                                                                          | Replay changed fixture; history stable, current metadata updated.                                                                                                                                                                        |
| Bounded resources  | Cursor pagination, streamed exports, maximum page traversal, query timeout, body limits, and bounded logs.                                                                                                             | Load tests do not show unbounded memory growth.                                                                                                                                                                                          |

## **Operational targets**

- Deployment topology is single-host, not high availability. Expected service target is 99% monthly availability excluding operator maintenance and Spotify outages.

- Default recovery point objective is the last successful daily backup; target RPO \<=24 hours. Default recovery time objective is \<=2 hours for an operator familiar with Docker and PostgreSQL.

- Synchronization freshness target: 95% of successful runs complete within two default intervals (6 minutes) while Spotify and the host are healthy.

- Health requests should complete within 2 seconds. Dashboard p95 target is \<=1.5 seconds for 1 million retained events on the reference single-host deployment after warm database cache.

- A probable history gap, repeated sync failure (\>=3), token expiry within seven days, backup failure, or retention-job failure is an operator-visible warning. External notifications are post-MVP unless an operator already collects container logs.

# **19. Testing Specification**

| **Test ID** | **Area**               | **Test**                                                                                                                             | **Expected result**                                                                                         |
| :---------: | :--------------------- | :----------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------- |
|    T-001    | OAuth helper           | Generate state 10,000 times; test length/entropy format and hashed storage.                                                          | No collision; raw state absent from DB/logs; expired/used state rejected.                                   |
|    T-002    | OAuth callback         | Wrong, missing, replayed, expired, or mismatched cookie/query state.                                                                 | Callback rejected; no token exchange/session; safe audit event.                                             |
|    T-003    | OAuth redirect         | Validate exact configured redirect and safe returnTo.                                                                                | External/malformed return paths rejected; generated URI exactly allowlisted.                                |
|    T-004    | Token encryption       | Encrypt/decrypt, wrong AAD, wrong key, tampered ciphertext, nonce uniqueness.                                                        | Valid round-trip only; tampering/wrong context fails closed.                                                |
|    T-005    | Token refresh          | Access token near expiry; refresh response with and without a new refresh token.                                                     | One serialized refresh; expiry updated; existing refresh token retained when omitted.                       |
|    T-006    | Refresh failure        | Simulate invalid_grant, six-month expiry, repeated 401.                                                                              | Account becomes NEEDS_REAUTH; retries stop; UI/API status explains action.                                  |
|    T-007    | Spotify normalization  | Track with multiple artists, partial release date, missing images, local track, relinked/deprecated fields, unknown optional fields. | Stable normalized entities, preserved order/precision, deterministic local key, no crash.                   |
|    T-008    | Payload schema         | Missing required played_at/track shape and oversized/malformed payload.                                                              | Cursor unchanged; safe failure classification; no partial rows.                                             |
|    T-009    | Duplicate prevention   | Process same 50 items twice and from two concurrent workers.                                                                         | First run inserts N; later/concurrent conflicts insert 0 duplicates; unique constraint intact.              |
|    T-010    | Transaction atomicity  | Fail after entity upserts but before cursor update.                                                                                  | Entire unit rolls back or safely retries; no advanced cursor without events.                                |
|    T-011    | Synchronization worker | Due-account lease, heartbeat, completion, expired lease recovery, paused account.                                                    | One owner processes active account; stale lease reclaimed; paused account untouched.                        |
|    T-012    | Rate limit             | Spotify 429 with Retry-After, then success.                                                                                          | No early retry; jitter bounded; final success; credential failure count unaffected.                         |
|    T-013    | API outage             | Timeouts and 500/502/503 sequence.                                                                                                   | Capped exponential full-jitter retry; persisted backoff; no cursor advance.                                 |
|    T-014    | Gap detection          | Cursor far behind, bounded full result, service restart.                                                                             | Durable probable-gap warning created and returned to UI.                                                    |
|    T-015    | Statistics             | Seed known plays, tracks, albums, collaborations.                                                                                    | Counts, unique entities, artist credits, top rankings, ties, and estimated duration match hand calculation. |
|    T-016    | Date filtering         | UTC, non-UTC, DST spring/fall, leap day, inclusive user end date.                                                                    | Correct half-open UTC interval and local bucket totals.                                                     |
|    T-017    | Empty statistics       | User/range with no events.                                                                                                           | Zero totals and zero-filled series; no divide-by-zero/500.                                                  |
|    T-018    | API authorization      | No session, expired session, user A requesting user B IDs/export.                                                                    | 401 for no session; 404/403 for foreign data; no existence leakage.                                         |
|    T-019    | CSRF                   | Cross-origin POST/PATCH/DELETE, missing/wrong token, valid same-origin token.                                                        | Invalid requests rejected; valid action succeeds.                                                           |
|    T-020    | Search/pagination      | Accents/case, long query, tied timestamps, forward pages.                                                                            | Correct scoped search; oversized query rejected; no duplicate/skip across cursors.                          |
|    T-021    | Export                 | Large CSV/JSON export with formula-like text and foreign-account fixture.                                                            | Stream remains bounded; only own data; formula cells neutralized; correct headers.                          |
|    T-022    | Disconnect/delete      | Repeat delete; inject transient DB failure; run cleanup retry.                                                                       | Access disabled immediately; operation idempotent; data deleted within policy; audit contains no content.   |
|    T-023    | Retention              | Seed events around cutoff and shared entity metadata.                                                                                | Only expired user history removed; still-referenced entities kept; orphans purged.                          |
|    T-024    | Health endpoint        | Healthy DB, unavailable DB, slow DB, secret-bearing env.                                                                             | 200 healthy; 503 failures within timeout; response reveals no secret.                                       |
|    T-025    | UI/dashboard           | Loading, empty, populated, error, mobile 360px, keyboard chart alternative.                                                          | Stable responsive UI, accessible names/focus, same totals as API.                                           |
|    T-026    | Docker build           | Build runtime and migrator targets without .env.                                                                                     | Both images build reproducibly, run non-root, and contain no secret/source clutter.                         |
|    T-027    | Docker startup         | Fresh named volume with docker compose up -d.                                                                                        | Postgres healthy, migrate exits 0, app/worker healthy, no DB host port.                                     |
|    T-028    | Upgrade/restart        | Deploy prior schema/data, upgrade, restart all services/host simulation.                                                             | Migration succeeds, data/cursor persists, no duplicates, services recover.                                  |
|    T-029    | Backup/restore         | Run backup, verify list/checksum, restore to disposable DB.                                                                          | Restored schema/counts/constraints match source; application smoke test passes.                             |
|    T-030    | Deployment script      | bash -n, ShellCheck, Bats fixtures for missing Docker/env, unhealthy DB/app, migration failure, success.                             | Correct messages/exit codes; no secret output; no volume-destroying command.                                |
|    T-031    | Log redaction          | Inject recognizable tokens/secrets in provider errors and headers.                                                                   | Captured logs contain none of the injected values.                                                          |
|    T-032    | Performance            | 1 million event fixture, representative dashboard/stats/search/export.                                                               | Meets p95 target or documented indexes/query changes are completed before release.                          |

Testing layers:

- Unit tests run on every change and contain no network/database dependency.

- Integration tests use an isolated PostgreSQL database and mocked Spotify HTTP server; migrations run from zero.

- End-to-end tests use Playwright with a fake OAuth/provider boundary; one manual staging test uses a dedicated Spotify developer/test account.

- Compose smoke tests use an isolated project name and disposable test volume. Production volumes are never test targets.

- Coverage is risk-based: 90% branch coverage for auth, crypto, normalization, sync cursor/lease, retention, and statistics modules; no global percentage may excuse missing critical-path cases.

# **20. Deployment Verification**

Complete and record this checklist for a fresh install and an upgrade from the prior release.

- [ ] docker compose --env-file .env config --quiet succeeds; rendered services/networks/volumes match the specification.

- [ ] Runtime and migrator Docker images build from a clean checkout with no secret build context.

- [ ] Image scan/SBOM review passes the release security policy.

- [ ] PostgreSQL becomes healthy and has no host-published port.

- [ ] prisma migrate deploy succeeds from zero and from the prior release schema.

- [ ] Migration job exits 0; app and worker do not start before it completes.

- [ ] App starts as non-root and /api/health returns 200 through container networking.

- [ ] HTTPS reverse proxy reaches the app; HTTP redirects to HTTPS; secure headers and cookies are present.

- [ ] Spotify Dashboard redirect URI exactly equals SPOTIFY_REDIRECT_URI.

- [ ] OAuth success, denial, bad state, replay, and logout behave as specified.

- [ ] Access-token refresh succeeds and a forced invalid refresh token produces NEEDS_REAUTH.

- [ ] Worker synchronizes at least one recently played item and records last success/next run.

- [ ] Artists, albums, tracks, joins, and listening events are stored with correct ownership.

- [ ] Re-running the same provider fixture/event adds no duplicate history row.

- [ ] Dashboard, history, details, search, date ranges, and statistics display persisted data consistently.

- [ ] Estimated listening time is labeled and explained on every relevant surface.

- [ ] Manual sync queues work and respects its rate limit.

- [ ] Export contains only the current user's filtered data and no tokens.

- [ ] Disconnect disables future sync and deletes scoped data through the verified path.

- [ ] scripts/deploy.sh succeeds on fresh install/update and fails non-zero in injected error scenarios.

- [ ] scripts/backup.sh creates a verified custom-format dump; restore drill passes in a disposable database.

- [ ] Restart app, worker, and PostgreSQL; health recovers, cursor/history persist, and no duplicate is created.

- [ ] Reboot simulation/daemon restart preserves the named database volume.

- [ ] Logs contain request/run IDs and no injected secrets or raw provider payloads.

- [ ] Runbooks document reauthorization, probable gaps, backup restore, token-key rotation, failed migration, and Spotify outage.

# **21. Acceptance Criteria**

| **ID** | **Requirement**         | **Verification method**                                                                           | **Pass condition**                                                                                   |
| :----: | :---------------------- | :------------------------------------------------------------------------------------------------ | :--------------------------------------------------------------------------------------------------- |
| AC-001 | Production build        | Run strict typecheck, lint, tests, worker build, and next build from clean checkout.              | All exit 0; no production build warnings classified as release-blocking.                             |
| AC-002 | Docker image builds     | Build runtime and migrator targets with BuildKit.                                                 | Both complete, start under intended commands, run non-root, and pass image policy.                   |
| AC-003 | Compose validates       | Run docker compose config --quiet with placeholder-free test env.                                 | Exit 0; required services, dependency conditions, networks, and volume are present.                  |
| AC-004 | PostgreSQL starts       | Start only PostgreSQL on fresh named volume.                                                      | Health becomes healthy within 120 seconds; data directory uses named volume.                         |
| AC-005 | Migrations succeed      | Run production migration job from empty and previous-version databases.                           | Exit 0; expected schema/constraints/indexes exist; repeated deploy is safe.                          |
| AC-006 | App health passes       | Start app after migration and call /api/health.                                                   | HTTP 200 in \<=2 seconds with safe schema; DB failure produces 503.                                  |
| AC-007 | OAuth works             | Manual staging flow plus automated state/error tests.                                             | Correct account linked; invalid state/replay denied; no token reaches browser/log.                   |
| AC-008 | Tokens refresh          | Expire access token and exercise refresh; expire/revoke refresh token.                            | Access refresh transparent; unrecoverable token sets NEEDS_REAUTH with visible action.               |
| AC-009 | Recently played sync    | Provider fixture/live staging play and worker run.                                                | Event and normalized metadata committed; cursor/next run updated only on success.                    |
| AC-010 | Duplicates prevented    | Replay identical results sequentially and concurrently.                                           | Exactly one unique account/track/timestamp row remains.                                              |
| AC-011 | Dashboard persists data | Load dashboard after sync, app restart, and browser logout/login.                                 | Same persisted totals and recent event reappear; no provider call required for historical read.      |
| AC-012 | Statistics correct      | Golden fixture across range/timezone/collaboration/DST cases.                                     | All counts, rankings, buckets, and estimated duration match expected values.                         |
| AC-013 | Security isolation      | Run cross-user API/search/export tests and CSRF suite.                                            | No foreign record/content disclosed; state-changing cross-origin requests fail.                      |
| AC-014 | Deployment script       | Run success and all defined failure fixtures.                                                     | Success completes healthy; failures exit non-zero, reveal no secret, and preserve volumes.           |
| AC-015 | Restart survival        | Restart containers and Docker daemon with data present.                                           | Services recover, data/cursor persist, stale lease recovers, duplicates remain zero.                 |
| AC-016 | Backup recoverability   | Create backup and restore into clean disposable environment.                                      | Restored app passes health, schema, row-count, ownership, and sample-dashboard checks.               |
| AC-017 | Privacy controls        | Inspect consent, finite retention, export, disconnect, deletion, and metadata-cache behavior.     | All controls function and published text matches runtime configuration; deletion SLA is enforceable. |
| AC-018 | Full test suite         | Run unit, integration, E2E, Compose, shell, security, and performance suites in release pipeline. | Every required test passes; no quarantined critical test; accepted risks documented.                 |

The application is ready only when every Must requirement and AC-001 through AC-018 pass. A waived acceptance item requires a written owner, reason, expiry date, and user-visible limitation; OAuth, tenant isolation, duplicate prevention, token secrecy, deletion, migrations, and backup recoverability cannot be waived for production.

# **22. Build Phases**

| **Phase**                          | **Tasks**                                                                                                                                                                   | **Deliverables**                                                                         | **Exit criteria**                                                                                  |
| :--------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------- |
| Phase 1 - Project foundation       | Initialize Next.js/TypeScript/Tailwind; strict config; lint/format/test tooling; environment schema; error/response/log contracts; CI skeleton; privacy/reference boundary. | Bootable skeleton, locked dependencies, CI, .env.example, architecture decision records. | Clean build/typecheck/unit test; no secrets; route/error conventions approved.                     |
| Phase 2 - Database                 | Implement Prisma models/migrations, native constraints/indexes, repositories, test fixtures, retention fields, and ownership rules.                                         | Schema, initial migration, repository layer, migration tests.                            | Fresh and repeat migration pass; unique dedupe and cascade/isolation tests pass.                   |
| Phase 3 - Spotify OAuth            | Implement consent, state store/cookie, auth redirect/callback, token envelope, profile linking by account_id, sessions, logout, reauth state.                               | Secure login/session flow and settings connection summary.                               | OAuth helper/integration/security tests pass; no token/code in browser/logs.                       |
| Phase 4 - Synchronization          | Build Spotify client/schema, token refresh, rate limits, leases, normalization, transactional upserts, cursor overlap, gap detection, worker scheduler, sync audit.         | Runnable worker and manual-queue endpoint.                                               | Golden, duplicate, concurrent, outage, restart, and gap tests pass.                                |
| Phase 5 - Backend APIs             | Implement normalized range/parser, authorization middleware, dashboard/history/entity/stats/export/settings/sync APIs and problem responses.                                | Versioned API behavior and request examples.                                             | API contract, auth isolation, pagination, range, export, and load tests pass.                      |
| Phase 6 - Dashboard                | Build layout/navigation, global range control, KPI cards, top cards, recent list, trend chart, sync warnings, empty/error/loading states.                                   | Responsive dashboard.                                                                    | Totals match golden API; 360px and keyboard/a11y checks pass.                                      |
| Phase 7 - History and entity pages | Build searchable history, tracks/artists/albums lists, three detail page types, cursor navigation, filter URL state.                                                        | Required browsing pages.                                                                 | Search/filter/pagination/detail authorization and responsive tests pass.                           |
| Phase 8 - Analytics                | Implement daily/weekly/monthly/yearly/all-retained queries, hourly/weekday/month/YoY/distribution series, ECharts wrappers, table alternatives, exports.                    | Statistics page and metric-definition help.                                              | Golden calculations, DST/leap/tie/empty tests and chart accessibility pass.                        |
| Phase 9 - Docker                   | Implement multi-stage runtime/migrator Dockerfile, Compose services, health scripts, networks, non-root/read-only controls, .dockerignore.                                  | Versioned images and docker-compose.yml.                                                 | Fresh docker compose up -d succeeds; health/dependency/security inspection passes.                 |
| Phase 10 - Deployment automation   | Implement strict env validator, deploy/backup scripts, locks, waits, migrations, status, diagnostics, retention, operations/runbooks.                                       | scripts/deploy.sh, scripts/backup.sh, restore and failure runbooks.                      | Bash/ShellCheck/Bats success and failure cases pass; restore drill passes; no destructive command. |
| Phase 11 - Testing                 | Complete unit/integration/E2E/Compose/security/performance suites, coverage gates, fake provider, CI release jobs.                                                          | Reproducible release test pipeline and reports.                                          | T-001 through T-032 pass; critical module branch target met.                                       |
| Phase 12 - Production verification | Configure domain/TLS/Spotify redirect, deploy staging then production, run complete checklist, verify backup/restart/reauth/deletion, record evidence.                      | Signed release checklist, tagged images, deployment record, operator handoff.            | AC-001 through AC-018 pass with no non-waivable exceptions.                                        |

## **Phase dependency rules**

- Do not begin UI analytics before metric definitions and golden database fixtures are approved.

- Do not merge OAuth without token-envelope, state, cookie, log-redaction, and callback tests.

- Do not allow app/worker production start before migrations succeed.

- Do not call deployment complete until restore and restart persistence are tested.

- At the end of each phase, update the spec only through reviewed decisions; avoid silent architectural drift.

# **23. Final Specification Summary**

- **Proposed architecture:** A modular Next.js web/API process and a separate Node synchronization worker share a typed domain/repository layer and use PostgreSQL as the only durable system of record. Feasible for a VPS/home server, with known completeness limits imposed by Spotify's recently-played API.

- **Final technology stack:** Next.js App Router, React, strict TypeScript, Tailwind CSS, Node.js 24 LTS, PostgreSQL 18, Prisma, Zod, Apache ECharts, Pino, Vitest/Playwright, Docker BuildKit, and Docker Compose v2.

- **Number of required services:** Three long-running services (app, worker, postgres) plus one required one-shot migration service. No Redis in the MVP.

- **Key database entities:** Users, Spotify accounts, user settings, sessions, OAuth states, artists, albums, album artists, tracks, track artists, listening history, sync state, and sync runs.

- **Major API groups:** OAuth/session, current user/settings, dashboard, history, tracks, artists, albums, statistics, export, sync control/status, disconnect/delete, and health.

- **Synchronization strategy:** Poll every three minutes with jitter; refresh tokens safely; request up to 50 recently played items with a five-minute overlap; normalize and transact metadata/events/cursor; deduplicate in PostgreSQL; persist backoff, leases, and probable-gap warnings.

- **Docker architecture:** Multi-stage runtime and migrator targets; PostgreSQL on an internal-only network and named volume; app loopback-bound behind HTTPS proxy; worker with egress but no port; health-gated startup; non-root/read-only application containers.

- **Deployment strategy:** A strict, locked deploy.sh validates configuration, builds/pulls immutable images, starts and waits for PostgreSQL, applies migrations, updates app/worker, verifies health, prints safe status, and never destroys volumes. backup.sh creates verified timestamped custom-format PostgreSQL dumps with optional bounded retention.

- **Security priorities:** OAuth state validation, server-only credentials, encrypted Spotify tokens, hashed/revocable sessions, Secure/HttpOnly/SameSite cookies, CSRF and origin controls, strict validation/authorization, SSRF allowlists, safe logs, finite retention, export/disconnect/delete, and supply-chain scanning.

- **Largest implementation risks:** API history gaps after downtime; estimated rather than actual listening duration; six-month refresh-token reauthorization; Development Mode Premium/five-user limits and quota changes; Spotify's non-indefinite storage/deletion obligations; timezone/DST aggregation; migration/backup mistakes; and accidental cross-user data exposure.

- **Recommended MVP boundary:** One operator-controlled installation, one connected Spotify account by default, recently-played collection forward from authorization, required dashboard/history/entity/statistics pages, CSV/JSON export, visible sync/gap/reauth status, finite retention, privacy/delete controls, PostgreSQL backups, and complete Compose/deploy verification. No audio, recommendations, social sharing, notifications, or historic data import in MVP.

- **Recommended post-MVP features:** Spotify Extended Streaming History JSON import with explicit msPlayed semantics and conflict rules; encrypted off-host backups and WAL/PITR; notification integrations; materialized daily aggregates for very large histories; multiple Spotify accounts after Extended Quota review; compare periods/cohorts; playlist/context analysis if scopes and terms permit; public API tokens with scopes; operator admin page; and optional Redis only when multi-host scale is proven.
