'use client';

import { useState } from 'react';
import { csrfHeaders, csrfToken } from '@/lib/csrf-client';

export function ManualSyncButton() {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function requestSync() {
    setBusy(true);
    const response = await fetch('/api/sync', {
      method: 'POST',
      headers: csrfHeaders(),
    });
    const problem = await response.json().catch(() => null);
    setMessage(
      response.ok
        ? 'Synchronization queued.'
        : (problem?.detail ?? 'Synchronization could not be queued.'),
    );
    setBusy(false);
  }

  return (
    <div className="flex flex-wrap items-center gap-4">
      <button
        type="button"
        onClick={requestSync}
        disabled={busy}
        className="rounded-xl border border-white/15 px-4 py-2 text-sm hover:border-accent disabled:opacity-50"
      >
        {busy ? 'Queueing…' : 'Sync now'}
      </button>
      <p role="status" aria-live="polite" className="text-sm text-muted">
        {message}
      </p>
    </div>
  );
}

export function ReauthorizeButton() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function reauthorize() {
    setBusy(true);
    const response = await fetch('/api/account/reauthorize', {
      method: 'POST',
      headers: csrfHeaders(),
    });
    const body = await response.json().catch(() => null);
    if (response.ok && body?.data?.authorizationUrl) {
      window.location.href = body.data.authorizationUrl;
      return;
    }
    setMessage(body?.detail ?? 'Reauthorization could not be started.');
    setBusy(false);
  }

  return (
    <div className="flex flex-wrap items-center gap-4">
      <button
        type="button"
        onClick={reauthorize}
        disabled={busy}
        className="rounded-xl border border-white/15 px-4 py-2 text-sm hover:border-accent disabled:opacity-50"
      >
        {busy ? 'Starting…' : 'Reauthorize Spotify'}
      </button>
      <p role="status" aria-live="polite" className="text-sm text-amber-300">
        {message}
      </p>
    </div>
  );
}

export function LogoutButton() {
  return (
    <button
      type="button"
      onClick={() => {
        void fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'x-csrf-token': csrfToken() },
        }).then(() => {
          // Full document load so no authenticated data survives in the
          // client router cache after the session is revoked.
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination
          window.location.href = '/login';
        });
      }}
      className="rounded-xl border border-white/15 px-4 py-2 text-sm hover:border-accent"
    >
      Log out
    </button>
  );
}

export function DisconnectForm() {
  const [confirmation, setConfirmation] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function disconnect(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    const response = await fetch('/api/account/spotify', {
      method: 'DELETE',
      headers: csrfHeaders(),
      body: JSON.stringify({ confirmation }),
    });
    if (response.status === 204) {
      // A full document load, not a client transition: the session is now
      // revoked and the router cache must not keep authenticated data.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.href = '/login';
      return;
    }
    const problem = await response.json().catch(() => null);
    setMessage(problem?.detail ?? 'Disconnection could not be completed.');
    setBusy(false);
  }

  return (
    <form onSubmit={disconnect} className="space-y-3">
      <label className="grid gap-1 text-sm text-muted">
        Type <span className="font-mono text-ink">DELETE</span> to confirm
        <input
          className="max-w-xs rounded-xl border border-white/15 bg-panel px-3 py-2 text-ink"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          autoComplete="off"
        />
      </label>
      <button
        type="submit"
        disabled={busy || confirmation !== 'DELETE'}
        className="rounded-xl border border-red-400/50 px-4 py-2 text-sm text-red-200 hover:bg-red-400/10 disabled:opacity-40"
      >
        {busy ? 'Disconnecting…' : 'Disconnect and delete my data'}
      </button>
      <p role="status" aria-live="polite" className="text-sm text-amber-300">
        {message}
      </p>
    </form>
  );
}
