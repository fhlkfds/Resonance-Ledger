import { cookies } from 'next/headers';
import { ProblemError } from '@/lib/api/errors';
import { database } from '@/lib/db/client';
import { getEnvironment } from '@/lib/env';
import { sessionCookieName } from './cookies';
import { resolveSession } from './sessions';
import { enforceRateLimit } from '@/lib/api/rate-limit';

export async function requireSession(request?: Request) {
  const environment = getEnvironment();
  const token = (await cookies()).get(
    sessionCookieName(environment.NODE_ENV === 'production'),
  )?.value;
  const session = await resolveSession(database, token);
  if (!session)
    throw new ProblemError(
      401,
      'AUTHENTICATION_REQUIRED',
      'Authentication required',
    );
  if (request) {
    await enforceRateLimit(database, `api:${session.id}`, 120, 60);
  }
  return session;
}
