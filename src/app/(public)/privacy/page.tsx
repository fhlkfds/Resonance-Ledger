import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Privacy' };

export default function PrivacyPage() {
  return (
    <article className="prose prose-invert max-w-3xl">
      <h1>Privacy notice</h1>
      <p>
        This installation&apos;s operator must publish the completed policy
        before accepting connections.
      </p>
      <p>
        See the operator template in <code>docs/privacy-template.md</code>.
      </p>
    </article>
  );
}
