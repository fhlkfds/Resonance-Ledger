import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Terms' };

export default function TermsPage() {
  return (
    <article className="prose prose-invert max-w-3xl">
      <h1>Terms</h1>
      <p>
        This installation&apos;s operator must complete legal review before
        accepting connections.
      </p>
      <p>
        Resonance Ledger is an independent project and is not affiliated with
        Spotify.
      </p>
    </article>
  );
}
