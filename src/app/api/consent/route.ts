import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { CONSENT_COOKIE, createConsentReceipt } from '@/lib/auth/consent';
import { secureCookieOptions } from '@/lib/auth/cookies';
import { getEnvironment } from '@/lib/env';

export async function POST(request: Request): Promise<NextResponse> {
  const environment = getEnvironment();
  if (request.headers.get('origin') !== new URL(environment.APP_URL).origin) {
    return NextResponse.json(
      { title: 'Invalid origin', status: 403 },
      { status: 403, headers: { 'Content-Type': 'application/problem+json' } },
    );
  }
  const body = await request.formData();
  if (body.get('consent') !== 'accepted') {
    return NextResponse.json(
      { title: 'Consent is required', status: 400 },
      { status: 400, headers: { 'Content-Type': 'application/problem+json' } },
    );
  }
  const store = await cookies();
  store.set(
    CONSENT_COOKIE,
    createConsentReceipt(Buffer.from(environment.SESSION_SECRET, 'base64')),
    {
      ...secureCookieOptions(environment.NODE_ENV === 'production', 3600),
    },
  );
  return NextResponse.redirect(
    new URL('/api/auth/spotify', environment.APP_URL),
    303,
  );
}
