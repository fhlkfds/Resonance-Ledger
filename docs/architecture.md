# Architecture decisions

This document records choices where the product specification is silent. The specification remains authoritative.

## Foundation choices

- The repository uses npm and commits `package-lock.json`. Direct dependency versions are exact.
- Tailwind CSS 3.4 is used because the required repository tree includes `tailwind.config.ts`; Tailwind 4 would replace that configuration model without adding required product behavior.
- ESLint uses its flat configuration with the Next.js Core Web Vitals and TypeScript rules. Prettier handles formatting only.
- TypeScript checks application code strictly but skips declaration-file checking. Next.js 16.3.4 currently references global `URLPatternInput` and `URLPatternOptions` names that Node 24's declarations do not expose; application source remains fully checked.
- API errors use a stable local problem type rooted at `https://resonance-ledger.invalid/problems/`. Operators can replace the documentation origin later without changing application codes.
- The first release is licensed under AGPL-3.0-only. This is a repository choice, not legal advice.
- `EXTERNAL_DATABASE=true` is an optional, undocumented-by-default escape hatch for test harnesses and operators who deliberately run PostgreSQL outside Compose. Without it, validation requires the `postgres` Compose hostname. It is omitted from the normative `.env.example`.

## Privacy boundary

PostgreSQL is the only durable runtime store. The application stores normalized Spotify metadata and listening events but never audio or raw Spotify payloads. Browser code receives neither provider tokens nor server secrets. Logs are structured and redact secret-bearing field names recursively.

## Authentication defaults

- Application sessions have a 30-day absolute lifetime and a 24-hour idle lifetime. Disconnect requires authentication from the preceding 10 minutes.
- Before the first OAuth redirect, the public consent endpoint issues a one-hour signed, HttpOnly receipt. The OAuth callback converts that receipt into the version and timestamp stored on the new user. This resolves the specification's pre-user consent requirement without putting consent state in browser JavaScript.
- Development cookies omit the `__Host-` prefix and `Secure` attribute so loopback testing works. Production uses the exact `__Host-resonance_session` contract.
- PostgreSQL-backed fixed-window rate entries reuse the short-lived `oauth_states` ledger with an explicit `RATE` purpose and hashed key. This keeps the specification's 13-table domain schema while making limits durable across app restarts. Raw client addresses and session identifiers are not stored.

## Normalization choices

- Search names use Unicode NFKD decomposition with combining marks removed, followed by NFKC normalization, trimmed/collapsed whitespace, and locale-independent English lowercase. This makes accent and case variants share a stored search key. PostgreSQL trigram indexes operate on that result.
- Unidentified artists hash `artist|normalized name`; unidentified albums hash `album|normalized name|ordered artist names`. Tracks use the exact specification formula: normalized track name, album name, ordered artist names, and duration.
- A bounded Spotify traversal sets a probable gap only when an existing cursor plus its overlap precedes the oldest returned event. First connection remains explicitly partial history but is not labeled an outage gap.
