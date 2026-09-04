import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api/handler';
import { jsonResponse } from '@/lib/api/responses';
import { ProblemError } from '@/lib/api/errors';
import { requireSession } from '@/lib/auth/request-session';
import { ApiRepository } from '@/lib/db/repositories/api';
import { database } from '@/lib/db/client';

export async function GET(request: Request): Promise<NextResponse> {
  return apiHandler(request, async (requestId) => {
    const session = await requireSession(request);
    const user = await new ApiRepository(database).me(session.userId);
    if (!user) throw new ProblemError(404, 'USER_NOT_FOUND', 'User not found');
    return jsonResponse(user, requestId);
  });
}
