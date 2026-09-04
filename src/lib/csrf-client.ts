/**
 * Reads the synchronizer CSRF token the callback set as a readable cookie.
 * The server compares its SHA-256 hash against the session record, so the
 * cookie alone is not sufficient to forge a request from another origin.
 */
export function csrfToken(): string {
  const match = /(?:^|;\s*)resonance_csrf=([^;]+)/.exec(document.cookie);
  return match?.[1] ? decodeURIComponent(match[1]) : '';
}

export function csrfHeaders(): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'x-csrf-token': csrfToken(),
  };
}
