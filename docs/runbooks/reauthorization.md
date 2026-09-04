# Runbook: Spotify reauthorization

**Symptom.** Settings shows an authorization expiry warning, the account state
is `NEEDS_REAUTH`, or synchronization stopped with repeated credential errors.

**Why it happens.** Spotify access tokens last about an hour and refresh
automatically. Refresh tokens issued to Developer Dashboard apps currently
expire about six months after authorization and are not extended on refresh.
The application warns at 30, 7, and 1 day before that deadline.

## Resolve

1. Open `/settings` as the connected user.
2. Confirm the connection panel shows the expiry date and the days remaining.
3. Select **Reauthorize Spotify**. The server builds the authorization URL,
   stores a fresh single-use state, and the browser follows it to Spotify.
4. Approve the same two scopes: `user-read-recently-played` and
   `user-read-private`. Nothing else is requested.
5. On return, the account links by its immutable Spotify `account_id`, so
   history stays attached to the same local user.
6. Confirm the account state returns to `ACTIVE` and **Next run** advances.

## If reauthorization fails

- **Redirect URI mismatch.** `SPOTIFY_REDIRECT_URI` must equal the Spotify
  Developer Dashboard entry byte for byte, including scheme and trailing path.
  Verify with `node scripts/validate-env.mjs .env`, which checks the callback
  shares the `APP_URL` origin and uses `/api/auth/callback`.
- **Invalid state.** OAuth state is single-use and expires after ten minutes.
  Start again from `/settings` rather than reusing a stale browser tab.
- **Development Mode limits.** Since February 2026, the app owner must have
  Premium and a Development Mode app is limited to five users. Wider use needs
  Extended Quota Mode.

## Verify

```sh
node scripts/smoke-test.mjs https://music.example.com
docker compose logs --tail 50 worker
```

A successful run records `lastSuccessAt` and resets the failure counter.
Reauthorization does not delete history and does not backfill the gap that
accumulated while the credential was invalid; see `probable-gap.md`.
