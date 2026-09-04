import { z } from 'zod';
import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api/handler';
import { ProblemError } from '@/lib/api/errors';
import { requireMutationSession } from '@/lib/auth/mutations';
import { RECENT_AUTH_SECONDS } from '@/lib/auth/sessions';
import { database } from '@/lib/db/client';

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
    await database.$transaction(async (transaction) => {
      await transaction.spotifyAccount.updateMany({
        where: { userId: session.userId },
        data: { state: 'DELETING' },
      });
      await transaction.appSession.updateMany({
        where: { userId: session.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await transaction.spotifyAccount.deleteMany({
        where: { userId: session.userId },
      });
      await transaction.track.deleteMany({ where: { history: { none: {} } } });
      await transaction.album.deleteMany({ where: { tracks: { none: {} } } });
      await transaction.artist.deleteMany({
        where: { tracks: { none: {} }, albums: { none: {} } },
      });
      await transaction.user.update({
        where: { id: session.userId },
        data: { status: 'DISCONNECTED' },
      });
    });
    return new NextResponse(null, {
      status: 204,
      headers: { 'X-Request-ID': requestId },
    });
  });
}
