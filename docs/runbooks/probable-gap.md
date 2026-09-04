# Runbook: probable history gap

**Symptom.** The dashboard or `/settings` reports a probable gap in historical
coverage. `GET /api/sync/status` returns `probableGap: true` with a
`gapDetectedAt` and `gapReason`.

**Why it happens.** Spotify's recently-played endpoint returns at most 50 items
and only covers a bounded recent window. If the worker is down, the credential
is invalid, or Spotify is unavailable for long enough, plays fall out of that
window before they are ever fetched. When the stored cursor plus its overlap
predates the oldest item in a full, bounded response, the run records a durable
warning instead of silently claiming completeness.

**This is a data-completeness notice, not a service fault.** Synchronization can
be perfectly healthy while coverage has a hole. The two are reported separately
on purpose.

## Investigate

```sh
# When the gap was detected and why.
curl -s -H "Cookie: <session>" https://music.example.com/api/sync/status | jq .

# What the worker was doing around then.
docker compose logs --since 24h worker | tail -100
```

Correlate `gapDetectedAt` with host downtime, a `NEEDS_REAUTH` period, or a
Spotify incident.

## Resolve

1. Fix the underlying cause first — see `reauthorization.md` or
   `spotify-outage.md`.
2. Confirm synchronization is healthy again: `lastSuccessAt` advancing and
   `consecutiveFailures` back to zero.
3. Acknowledge the warning in Settings once you accept the gap.

**The missing plays are not recoverable through the API.** Spotify does not
serve history beyond its recent window, and the MVP has no import path. Do not
present the range as complete to users.

## Reduce future gaps

- Keep the worker on `restart: unless-stopped` (the shipped default).
- Reauthorize before the 30-day warning rather than after expiry.
- Keep `SYNC_INTERVAL_SECONDS` at or below the 180-second default on an account
  that plays music heavily; 50 items is the ceiling per request.
- Alert on three or more consecutive failures.
