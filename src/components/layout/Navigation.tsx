import Link from 'next/link';

const primary = [
  ['/', 'Dashboard'],
  ['/history', 'History'],
  ['/statistics', 'Statistics'],
  ['/tracks', 'Tracks'],
  ['/artists', 'Artists'],
  ['/albums', 'Albums'],
] as const;

export function DesktopNavigation() {
  return (
    <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col border-r border-white/10 bg-canvas/95 p-6 lg:flex">
      <Link
        href="/"
        className="mb-10 font-mono text-sm uppercase tracking-[0.22em] text-accent"
      >
        Resonance Ledger
      </Link>
      <nav className="space-y-2" aria-label="Primary navigation">
        {primary.map(([href, label]) => (
          <Link
            key={href}
            href={href}
            className="block rounded-xl px-4 py-3 text-muted hover:bg-white/5 hover:text-ink"
          >
            {label}
          </Link>
        ))}
      </nav>
      <Link
        href="/settings"
        className="mt-auto rounded-xl px-4 py-3 text-muted hover:bg-white/5 hover:text-ink"
      >
        Settings
      </Link>
    </aside>
  );
}

export function MobileNavigation() {
  return (
    <>
      <header className="sticky top-0 z-20 border-b border-white/10 bg-canvas/90 px-4 py-4 backdrop-blur lg:hidden">
        <Link
          href="/"
          className="font-mono text-xs uppercase tracking-[0.2em] text-accent"
        >
          Resonance Ledger
        </Link>
      </header>
      <nav
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-white/10 bg-canvas/95 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
        aria-label="Mobile navigation"
      >
        <Link className="px-2 py-4 text-center text-xs" href="/">
          Dashboard
        </Link>
        <Link className="px-2 py-4 text-center text-xs" href="/history">
          History
        </Link>
        <Link className="px-2 py-4 text-center text-xs" href="/statistics">
          Statistics
        </Link>
        <Link className="px-2 py-4 text-center text-xs" href="/tracks">
          Library
        </Link>
      </nav>
    </>
  );
}
