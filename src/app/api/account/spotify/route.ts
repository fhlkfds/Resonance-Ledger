import { z } from 'zod';
import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api/handler';
import { ProblemError } from '@/lib/api/errors';
import { requireMutationSession } from '@/lib/auth/mutations';
import { RECENT_AUTH_SECONDS } from '@/lib/auth/sessions';
import { database } from '@/lib/db/client';
import { disconnectUser } from '@/lib/db/repositories/disconnect';

const bodySchema = z.object({ confirmation: z.literal('DELETE') }).strict();

export async function DELETE(request: Request): Promise<NextResponse> {
  return apiHandler(request, async (requestId) => {
    const session = await requireMutationSession(request);
    if (session.authAt < new Date(Date.now() - RECENT_AUTH_SECONDS * 1000)) {
      throw new ProblemError(
        403,
        'RECENT_AUTH_REQUIRED',
        'Recent authentication is required',
      );
    }
    const body = bodySchema.safeParse(await request.json());
    if (!body.success)
      throw new ProblemError(
        400,
        'CONFIRMATION_REQUIRED',
        'Type DELETE to confirm disconnection',
      );
    await disconnectUser(database, session.userId);
    return new NextResponse(null, {
      status: 204,
      headers: { 'X-Request-ID': requestId },
    });
  });
}
