import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import {
  DesktopNavigation,
  MobileNavigation,
} from '@/components/layout/Navigation';
import { requireSession } from '@/lib/auth/request-session';
import { ProblemError } from '@/lib/api/errors';
import { safeReturnPath } from '@/lib/auth/oauth-state';

export default async function AuthenticatedLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  await connection();
  try {
    await requireSession();
  } catch (error) {
    if (!(error instanceof ProblemError) || error.status !== 401) throw error;
    const requestedPath = safeReturnPath(
      (await headers()).get('x-resonance-path'),
    );
    redirect(`/login?returnTo=${encodeURIComponent(requestedPath)}`);
  }
  return (
    <div className="min-h-screen">
      <DesktopNavigation />
      <MobileNavigation />
      <main className="mx-auto max-w-[1500px] px-4 py-8 pb-28 sm:px-8 lg:ml-64 lg:px-10 lg:py-12">
        {children}
      </main>
    </div>
  );
}
