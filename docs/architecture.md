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

## Container and image decisions

- **PostgreSQL volume path.** The specification's Compose outline mounts `postgres_data:/var/lib/postgresql/data`, but the `postgres:18-alpine` image the same specification mandates refuses to start against that path: from 18 onward the official images keep data in a major-version subdirectory and treat a mount at `.../data` as an unsupported upgrade artifact. The volume is therefore mounted one level up, at `/var/lib/postgresql`, which is the layout the image documents for 18+ and which keeps `pg_upgrade --link` possible without crossing a mount boundary. This is the only intentional divergence from the normative Compose outline.
- **Base images are pinned by digest** (`node:24-bookworm-slim`, `postgres:18-alpine`). Refresh them through a reviewed change; never float a tag.
- **The runtime image ships only the Next.js standalone tree.** Standalone output already traces the dependencies the web app needs, including Prisma Client and its native query engine. Copying a second pruned production tree on top of it roughly tripled the image, so it was removed.
- **The worker bundle carries its own JavaScript dependencies.** Because the standalone tree only traces what the web app imports, `pino` and `zod` were not resolvable for the worker at runtime. `scripts/build-worker.mjs` bundles them in and leaves only Prisma external, since Prisma loads a platform-specific engine that cannot be bundled. The bundle is emitted as `.mjs` so Node treats it as ESM without a `type` field, and a `createRequire` banner is prepended because several bundled dependencies are CommonJS and call `require()` at load time.
- **The migrator is built from a generated minimal manifest.** Applying migrations needs only the Prisma CLI, Prisma Client, and the committed schema. Installing the full production tree pulled in Next, React, and ECharts and left a 1.4 GB one-shot image. `scripts/migrator-manifest.mjs` writes a manifest containing only the two Prisma packages, at the versions the repository manifest already pins.
- **Server source maps are deleted from the final runtime stage.** They disclose the original source layout without helping an operator debug a production container.
- **`npm run typecheck` runs `next typegen` first.** Route and page types such as `PageProps` are generated into `.next/types`; without the typegen step, a typecheck on a clean checkout fails even though the same command passes locally after a previous build.
