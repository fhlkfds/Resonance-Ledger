import type { ReactNode } from 'react';

export default function PublicLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col justify-center px-6 py-16">
      {children}
    </main>
  );
}
