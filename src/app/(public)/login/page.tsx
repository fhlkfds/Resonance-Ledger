import Link from 'next/link';

export default function LoginPage() {
  return (
    <section className="max-w-2xl space-y-8">
      <p className="font-mono text-sm uppercase tracking-[0.25em] text-accent">
        Resonance Ledger
      </p>
      <h1 className="text-5xl font-semibold tracking-tight sm:text-7xl">
        Your listening record, on your server.
      </h1>
      <p className="max-w-xl text-lg leading-8 text-muted">
        Connect a Spotify account to collect recently played metadata and
        explore your retained listening history. No audio is downloaded or
        stored.
      </p>
      <div className="rounded-2xl border border-white/10 bg-panel p-5 text-sm leading-6 text-muted">
        Before connecting, read this installation&apos;s privacy policy and
        terms. Connecting records your consent to the current policy version.
      </div>
      <form action="/api/consent" method="post" className="space-y-4">
        <label className="flex items-start gap-3 text-sm text-muted">
          <input
            name="consent"
            value="accepted"
            type="checkbox"
            required
            className="mt-1"
          />
          <span>
            I have read and accept this installation&apos;s privacy notice and
            terms.
          </span>
        </label>
        <button
          type="submit"
          className="rounded-full bg-accent px-6 py-3 font-semibold text-canvas"
        >
          Record consent
        </button>
      </form>
      <a
        href="/api/auth/spotify"
        className="w-fit rounded-full border border-accent px-6 py-3 font-semibold text-accent"
      >
        Connect Spotify
      </a>
      <nav className="flex gap-5 text-sm text-muted" aria-label="Legal">
        <Link href="/privacy" className="underline underline-offset-4">
          Privacy
        </Link>
        <Link href="/terms" className="underline underline-offset-4">
          Terms
        </Link>
      </nav>
    </section>
  );
}
