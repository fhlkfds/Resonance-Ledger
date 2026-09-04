import type { ReactNode } from 'react';

export function KpiCard({
  label,
  value,
  hint,
  delta,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  delta?: number | null;
}) {
  return (
    <article className="rounded-2xl border border-white/10 bg-panel/80 p-5">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-sm text-muted">{label}</h2>
        {hint ? (
          <span
            className="cursor-help text-muted"
            title={hint}
            aria-label={hint}
          >
            ⓘ
          </span>
        ) : null}
      </div>
      <p className="mt-3 text-3xl font-semibold tracking-tight">{value}</p>
      {delta !== null && delta !== undefined ? (
        <p
          className={`mt-2 text-xs ${delta >= 0 ? 'text-accent' : 'text-muted'}`}
        >
          {delta >= 0 ? '+' : ''}
          {delta.toLocaleString()} vs prior period
        </p>
      ) : null}
    </article>
  );
}
