'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { csrfHeaders } from '@/lib/csrf-client';

const ranges = [
  ['TODAY', 'Today'],
  ['LAST_7_DAYS', 'Last 7 days'],
  ['LAST_30_DAYS', 'Last 30 days'],
  ['CURRENT_MONTH', 'Current month'],
  ['CURRENT_YEAR', 'Current year'],
  ['ALL_TIME', 'All retained history'],
] as const;

const weekdays = [
  [0, 'Sunday'],
  [1, 'Monday'],
  [2, 'Tuesday'],
  [3, 'Wednesday'],
  [4, 'Thursday'],
  [5, 'Friday'],
  [6, 'Saturday'],
] as const;

const themes = [
  ['SYSTEM', 'Match system'],
  ['DARK', 'Dark'],
  ['LIGHT', 'Light'],
] as const;

const field = 'rounded-xl border border-white/15 bg-panel px-3 py-2 text-ink';

export type Preferences = {
  timezone: string;
  weekStartsOn: number;
  defaultRange: string;
  theme: string;
};

export function PreferencesForm({ initial }: { initial: Preferences }) {
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>(
    'idle',
  );
  const [message, setMessage] = useState('');

  const timezones =
    typeof Intl.supportedValuesOf === 'function'
      ? Intl.supportedValuesOf('timeZone')
      : [initial.timezone, 'UTC'];

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setStatus('saving');
    setMessage('');
    const response = await fetch('/api/settings', {
      method: 'PATCH',
      headers: csrfHeaders(),
      body: JSON.stringify(values),
    });
    if (response.ok) {
      setStatus('saved');
      setMessage('Preferences saved.');
      router.refresh();
    } else {
      setStatus('error');
      const problem = await response.json().catch(() => null);
      setMessage(problem?.detail ?? 'Preferences could not be saved.');
    }
  }

  return (
    <form onSubmit={save} className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-1 text-sm text-muted">
          Timezone
          <select
            className={field}
            value={values.timezone}
            onChange={(event) =>
              setValues({ ...values, timezone: event.target.value })
            }
          >
            {[...new Set([initial.timezone, ...timezones])].map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm text-muted">
          Week starts on
          <select
            className={field}
            value={values.weekStartsOn}
            onChange={(event) =>
              setValues({ ...values, weekStartsOn: Number(event.target.value) })
            }
          >
            {weekdays.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm text-muted">
          Default date range
          <select
            className={field}
            value={values.defaultRange}
            onChange={(event) =>
              setValues({ ...values, defaultRange: event.target.value })
            }
          >
            {ranges.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm text-muted">
          Theme
          <select
            className={field}
            value={values.theme}
            onChange={(event) =>
              setValues({ ...values, theme: event.target.value })
            }
          >
            {themes.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={status === 'saving'}
          className="rounded-xl border border-white/15 px-4 py-2 text-sm hover:border-accent disabled:opacity-50"
        >
          {status === 'saving' ? 'Saving…' : 'Save preferences'}
        </button>
        <p
          role="status"
          aria-live="polite"
          className={`text-sm ${status === 'error' ? 'text-amber-300' : 'text-muted'}`}
        >
          {message}
        </p>
      </div>
    </form>
  );
}
