# Resonance Ledger

Resonance Ledger is a self-hosted Spotify recently-played collector and analytics application. It stores normalized metadata and play events in PostgreSQL. It does not download, proxy, record, or play audio.

The project is under construction phase by phase against the product and technical specification. Do not deploy it until `docs/deployment-record.md` reports every required acceptance criterion as passing.

## Local foundation checks

Use Node.js 24 and npm:

```sh
npm ci
npm run typecheck
npm run lint
npm run test:unit
npm run build
```

Copy `.env.example` to `.env` only when configuring a runtime. Replace every placeholder with a secret generated outside the repository, keep the file mode at `0600`, and never commit it.

## Product limits

Spotify recently played data is a bounded forward-looking source. The application cannot reconstruct a complete historical record after a long outage. "Estimated listening time" sums each recorded track's full duration because Spotify does not provide actual played milliseconds.

The working product name needs trademark and domain clearance before release. A Development Mode Spotify application requires a Premium owner and supports no more than five users under the platform rules cited by the specification.
