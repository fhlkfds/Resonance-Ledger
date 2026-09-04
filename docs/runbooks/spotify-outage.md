# Runbook: Spotify outage or rate limiting

**Symptom.** Sync status shows `BACKOFF` with a rising failure count, or runs
record `RATE_LIMITED`. The dashboard still serves everything already stored:
historical reads never call Spotify.

## What the worker already does

No manual action is needed for a short outage. The shipped behavior is:

| Condition                | Handling                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `429`                    | Honors `Retry-After` exactly, plus 0–1s jitter. Not counted as a credential failure.   |
| `5xx` or network timeout | Exponential backoff with full jitter, base 1s, cap 60s, at most five attempts per run. |
| `401`                    | Refreshes once under an account lock, retries the original request once.               |
| `403`                    | Treated as a missing or revoked scope: `NEEDS_REAUTH` or `BLOCKED`.                    |
| Malformed payload        | Fails closed. The cursor is preserved and no partial rows are written.                 |

**The cursor never advances on a failed transaction**, so nothing is skipped
because of an outage. Work resumes from the same point when Spotify recovers.

## Assess

```sh
docker compose logs --since 1h worker | tail -100
curl -s -H "Cookie: <session>" https://music.example.com/api/sync/status | jq .
```

Check whether the failure is provider-wide (Spotify status page) or specific to
this installation (credentials, egress, DNS).

Confirm the host can still reach Spotify:

```sh
docker compose exec app node -e \
  "fetch('https://api.spotify.com/v1', {signal: AbortSignal.timeout(5000)})
     .then(r => console.log('reachable, status', r.status))
     .catch(e => console.log('unreachable:', e.name))"
```

## Act

- **Provider outage.** Wait. Do not restart the worker in a loop; that discards
  backoff state and can worsen rate limiting. Watch for a probable gap once it
  clears (`probable-gap.md`).
- **Rate limiting only this app.** Spotify limits per app over a rolling
  30-second window. Raise `SYNC_INTERVAL_SECONDS` toward 900 temporarily, and
  avoid repeated manual syncs — manual sync is capped at one per account per
  minute.
- **Persistent 401 or 403.** This is a credential problem, not an outage. See
  `reauthorization.md`.
- **Egress blocked.** Confirm the `egress` network still resolves DNS and that
  no host firewall change blocked outbound 443.

## After recovery

1. Confirm `lastSuccessAt` advances and `consecutiveFailures` returns to zero.
2. Check for a probable gap; a long outage very likely created one.
3. If the account was left in `PAUSED` or `BLOCKED`, clear it from `/settings`
   after fixing the cause.

**Do not** delete history or reset the cursor to force a re-fetch. Spotify does
not serve history beyond its recent window, so a reset loses the cursor without
recovering anything.
