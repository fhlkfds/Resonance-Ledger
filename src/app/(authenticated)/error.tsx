'use client';

export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section
      className="rounded-2xl border border-red-400/40 bg-red-400/10 p-6"
      role="alert"
    >
      <h1 className="text-xl font-semibold">The dashboard could not load</h1>
      <p className="mt-2 text-muted">
        The request failed without changing your listening history.
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-4 rounded-xl border border-white/20 px-4 py-2"
      >
        Try again
      </button>
    </section>
  );
}
