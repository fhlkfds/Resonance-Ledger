import { z } from 'zod';
import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api/handler';
import { parseSearchParams } from '@/lib/api/query';
import { jsonResponse } from '@/lib/api/responses';
import { requireSession } from '@/lib/auth/request-session';
import { ApiRepository } from '@/lib/db/repositories/api';
import { database } from '@/lib/db/client';

const schema = z
  .object({ limit: z.coerce.number().int().min(1).max(20).default(10) })
  .strict();

export async function GET(request: Request): Promise<NextResponse> {
  return apiHandler(request, async (requestId) => {
    const session = await requireSession(request);
    const query = parseSearchParams(request.url, schema);
    return jsonResponse(
      await new ApiRepository(database).syncStatus(session.userId, query.limit),
      requestId,
    );
  });
}
