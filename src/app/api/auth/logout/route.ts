import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { sessionCookieName } from '@/lib/auth/cookies';
import { validateCsrfToken, validateSameOrigin } from '@/lib/auth/csrf';
import { resolveSession, revokeSession } from '@/lib/auth/sessions';
import { database } from '@/lib/db/client';
import { getEnvironment } from '@/lib/env';

export async function POST(request: Request): Promise<NextResponse> {
  const environment = getEnvironment();
  const production = environment.NODE_ENV === 'production';
  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName(production))?.value;
  const session = await resolveSession(database, token);
  if (!session) return new NextResponse(null, { status: 401 });
  if (
    !validateSameOrigin(request, environment.APP_URL) ||
    !validateCsrfToken(request.headers.get('x-csrf-token'), session.csrfHash)
  ) {
    return new NextResponse(null, { status: 403 });
  }
  await revokeSession(database, token);
  cookieStore.delete(sessionCookieName(production));
  cookieStore.delete('resonance_csrf');
  return new NextResponse(null, { status: 204 });
}
