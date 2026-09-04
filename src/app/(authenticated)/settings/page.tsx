import Link from 'next/link';
import {
  DisconnectForm,
  LogoutButton,
  ManualSyncButton,
  ReauthorizeButton,
} from '@/components/settings/AccountActions';
import { PreferencesForm } from '@/components/settings/PreferencesForm';
import { requireSession } from '@/lib/auth/request-session';
import { database } from '@/lib/db/client';
import { getEnvironment } from '@/lib/env';

const DAY_MS = 86_400_000;

function daysUntil(date: Date, now: Date): number {
  return Math.floor((date.getTime() - now.getTime()) / DAY_MS);
}

/** Spotify refresh tokens expire around six months; warn at 30, 7, and 1 day. */
function expiryWarning(days: number): string | null {
  if (days <= 0)
    return 'Spotify authorization has expired. Reauthorize to resume synchronization.';
  if (days <= 1)
    return 'Spotify authorization expires within one day. Reauthorize now.';
  if (days <= 7)
    return `Spotify authorization expires in ${days} days. Reauthorize soon.`;
  if (days <= 30) return `Spotify authorization expires in ${days} days.`;
  return null;
}

function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-white/10 bg-panel/80 p-6">
      <h2 className="text-lg font-semibold">{title}</h2>
      {description ? (
        <p className="mt-1 text-sm text-muted">{description}</p>
      ) : null}
      <div className="mt-5">{children}</div>
    </section>
  );
}

export default async function SettingsPage() {
  const session = await requireSession();
  const environment = getEnvironment();
  const now = new Date();

  const [settings, account, recentRuns] = await Promise.all([
    database.userSettings.findUniqueOrThrow({
      where: { userId: session.userId },
    }),
    database.spotifyAccount.findFirst({
      where: { userId: session.userId },
      include: { syncState: true },
    }),
    database.syncRun.findMany({
      where: { spotifyAccount: { userId: session.userId } },
      orderBy: { startedAt: 'desc' },
      take: 5,
      select: {
        id: true,
        startedAt: true,
        outcome: true,
        itemsFetched: true,
        eventsInserted: true,
        errorClass: true,
      },
    }),
  ]);

  const refreshDays = account
    ? daysUntil(account.refreshTokenExpiresAt, now)
    : null;
  const warning = refreshDays === null ? null : expiryWarning(refreshDays);
  const state = account?.syncState;

  return (
    <div className="space-y-8">
      <header>
        <p className="text-sm text-accent">Settings</p>
        <h1 className="mt-1 text-4xl font-semibold tracking-tight">
          Preferences and connection
        </h1>
      </header>

      {warning ? (
        <aside
          className="rounded-2xl border border-amber-400/40 bg-amber-400/10 p-4"
          role="alert"
        >
          {warning}
        </aside>
      ) : null}

      <Panel
        title="Spotify connection"
        description="This installation links one Spotify account by its immutable account ID."
      >
        {account ? (
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted">Display name</dt>
              <dd className="mt-1">{account.displayName ?? 'Not provided'}</dd>
            </div>
            <div>
              <dt className="text-muted">Account state</dt>
              <dd className="mt-1">{account.state}</dd>
            </div>
            <div>
              <dt className="text-muted">Granted scopes</dt>
              <dd className="mt-1 font-mono text-xs">
                {account.scopes.join(', ')}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Authorization expires</dt>
              <dd className="mt-1">
                <time dateTime={account.refreshTokenExpiresAt.toISOString()}>
                  {account.refreshTokenExpiresAt.toISOString().slice(0, 10)}
                </time>{' '}
                <span className="text-muted">({refreshDays} days)</span>
              </dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-muted">No Spotify account is connected.</p>
        )}
        <div className="mt-5 flex flex-wrap gap-3">
          <ReauthorizeButton />
          <LogoutButton />
        </div>
      </Panel>

      <Panel
        title="Analytics preferences"
        description="Calendar buckets are computed in your timezone; stored event times remain UTC."
      >
        <PreferencesForm
          initial={{
            timezone: settings.timezone,
            weekStartsOn: settings.weekStartsOn,
            defaultRange: settings.defaultRange,
            theme: settings.theme,
          }}
        />
      </Panel>

      <Panel
        title="Synchronization health"
        description="Healthy synchronization is not the same as complete historical coverage."
      >
        {state ? (
          <>
            <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <dt className="text-muted">Status</dt>
                <dd className="mt-1">{state.status}</dd>
              </div>
              <div>
                <dt className="text-muted">Last success</dt>
                <dd className="mt-1">
                  {state.lastSuccessAt?.toISOString() ?? 'Never'}
                </dd>
              </div>
              <div>
                <dt className="text-muted">Next run</dt>
                <dd className="mt-1">{state.nextSyncAt.toISOString()}</dd>
              </div>
              <div>
                <dt className="text-muted">Consecutive failures</dt>
                <dd className="mt-1">{state.consecutiveFailures}</dd>
              </div>
            </dl>
            {state.probableGap ? (
              <p
                className="mt-4 rounded-xl border border-amber-400/40 bg-amber-400/10 p-3 text-sm"
                role="status"
              >
                A probable gap in historical coverage was detected
                {state.gapDetectedAt
                  ? ` on ${state.gapDetectedAt.toISOString().slice(0, 10)}`
                  : ''}
                . Spotify only returns a bounded recently-played window, so some
                plays during an outage may never be recoverable.
              </p>
            ) : null}
            <div className="mt-5">
              <ManualSyncButton />
            </div>
            {recentRuns.length ? (
              <div
                className="mt-6 overflow-auto"
                role="region"
                aria-label="Recent synchronization runs"
                tabIndex={0}
              >
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="text-muted">
                      <th scope="col" className="py-2">
                        Started
                      </th>
                      <th scope="col">Outcome</th>
                      <th scope="col">Items</th>
                      <th scope="col">Inserted</th>
                      <th scope="col">Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentRuns.map((run) => (
                      <tr key={run.id} className="border-t border-white/10">
                        <td className="py-2">
                          <time dateTime={run.startedAt.toISOString()}>
                            {run.startedAt
                              .toISOString()
                              .replace('T', ' ')
                              .slice(0, 19)}
                          </time>
                        </td>
                        <td>{run.outcome}</td>
                        <td>{run.itemsFetched}</td>
                        <td>{run.eventsInserted}</td>
                        <td className="text-muted">{run.errorClass ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted">
            Synchronization starts once a Spotify account is connected.
          </p>
        )}
      </Panel>

      <Panel title="Data retention and export">
        <p className="text-sm text-muted">
          This installation retains listening history for{' '}
          <strong className="text-ink">{settings.retentionDays} days</strong>{' '}
          (operator default {environment.DATA_RETENTION_DAYS} days). Older
          events are deleted by a daily job, so “all retained history” never
          means perpetual retention. See the{' '}
          <Link href="/privacy" className="text-accent underline">
            privacy policy
          </Link>{' '}
          for the disclosed policy.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <a
            className="rounded-xl border border-white/15 px-4 py-2 text-sm hover:border-accent"
            href="/api/export?type=history&format=csv&range=ALL_TIME"
          >
            Export history (CSV)
          </a>
          <a
            className="rounded-xl border border-white/15 px-4 py-2 text-sm hover:border-accent"
            href="/api/export?type=history&format=json&range=ALL_TIME"
          >
            Export history (JSON)
          </a>
        </div>
      </Panel>

      <Panel
        title="Disconnect and delete"
        description="Disconnecting disables future Spotify access immediately and deletes your Spotify-derived data. This cannot be undone."
      >
        <DisconnectForm />
      </Panel>
    </div>
  );
}
