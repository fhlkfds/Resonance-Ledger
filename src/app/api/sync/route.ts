import { NextResponse } from 'next/server';
import { ProblemError } from '@/lib/api/errors';
import { problemResponse } from '@/lib/api/responses';
import { requireSession } from '@/lib/auth/request-session';
import { validateCsrfToken, validateSameOrigin } from '@/lib/auth/csrf';
import { queueManualSync } from '@/lib/db/repositories/sync';
import { database } from '@/lib/db/client';
import { getEnvironment } from '@/lib/env';
import { resolveRequestId } from '@/lib/observability/request-id';

export async function POST(request: Request): Promise<NextResponse> {
  const requestId = resolveRequestId(request.headers.get('x-request-id'));
  try {
    const session = await requireSession();
    if (
      !validateSameOrigin(request, getEnvironment().APP_URL) ||
      !validateCsrfToken(request.headers.get('x-csrf-token'), session.csrfHash)
    ) {
      return problemResponse(new ProblemError(403, 'CSRF_REJECTED', 'Request origin or CSRF token is invalid'), requestId);
    }
    const result = await queueManualSync(database, session.userId);
    if (result === 'limited')
      return NextResponse.json(
        {
          type: 'about:blank',
          title: 'Rate limited',
          status: 429,
          code: 'SYNC_RATE_LIMITED',
          requestId,
        },
        { status: 429 },
      );
    if (result === 'missing')
      return NextResponse.json(
        {
          type: 'about:blank',
          title: 'Connected account not found',
          status: 404,
          code: 'ACCOUNT_NOT_FOUND',
          requestId,
        },
        { status: 404 },
      );
    return NextResponse.json(
      { data: { queuedAt: new Date().toISOString() }, meta: { requestId } },
      { status: 202 },
    );
  } catch (error) {
    return problemResponse(error, requestId);
  }
}
