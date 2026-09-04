import { ProblemError } from '@/lib/api/errors';
import { getEnvironment } from '@/lib/env';
import { validateCsrfToken, validateSameOrigin } from './csrf';
import { requireSession } from './request-session';

export async function requireMutationSession(request: Request) {
  const session = await requireSession(request);
  if (
    !validateSameOrigin(request, getEnvironment().APP_URL) ||
    !validateCsrfToken(request.headers.get('x-csrf-token'), session.csrfHash)
  ) {
    throw new ProblemError(
      403,
      'CSRF_REJECTED',
      'Request origin or CSRF token is invalid',
    );
  }
  return session;
}
