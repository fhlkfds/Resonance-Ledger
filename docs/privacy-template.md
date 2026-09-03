# Operator privacy notice template

Status: incomplete template. An operator must fill every bracketed field and obtain legal review before accepting user connections.

Last updated: [DATE]

Operator: [LEGAL NAME AND CONTACT]

## Data collected

This Resonance Ledger installation stores the Spotify account identifier and display name needed to link an account, recently played timestamps, and the track, album, and artist metadata needed to display and calculate listening statistics. It does not collect email through Spotify and does not download or store audio.

## Purpose and storage

The data is used only to synchronize and display the connected user's listening history. Durable data is stored in the operator's PostgreSQL database and configured backups. Spotify access and refresh tokens are encrypted before database storage.

## Retention

Listening history is retained for [RETENTION DAYS] days. "All retained history" means the data still present under this limit. Operational synchronization records are retained for [SYNC RUN RETENTION DAYS] days. Backup retention is [BACKUP RETENTION DAYS] days.

## Cookies

The application uses a host-only, Secure, HttpOnly session cookie and a short-lived OAuth state cookie. It does not use advertising cookies.

## Export, disconnect, and deletion

Users can export their own retained data from the application. Disconnecting disables future Spotify access immediately and starts deletion of Spotify-derived personal data. Deletion completes immediately where possible and no later than five days after disconnect. Contact [OPERATOR CONTACT] if deletion does not complete.

## Sharing

The operator does not sell Spotify-derived data or send it to advertising or third-party analytics services. Spotify processes OAuth and API requests under its own terms.

## Legal review

This template is not legal advice. Review the completed notice, retention period, end-user agreement, and Spotify Developer Terms before inviting users.
