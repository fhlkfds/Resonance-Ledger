import { z } from 'zod';
import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api/handler';
import { jsonResponse } from '@/lib/api/responses';
import { requireMutationSession } from '@/lib/auth/mutations';
import { requireSession } from '@/lib/auth/request-session';
import { ApiRepository } from '@/lib/db/repositories/api';
import { database } from '@/lib/db/client';
import { isValidTimeZone } from '@/lib/stats/dates';

const updateSchema = z
  .object({
    timezone: z.string().max(64).refine(isValidTimeZone).optional(),
    weekStartsOn: z.number().int().min(0).max(6).optional(),
    defaultRange: z
      .enum([
        'TODAY',
        'LAST_7_DAYS',
        'LAST_30_DAYS',
        'CURRENT_MONTH',
        'CURRENT_YEAR',
        'ALL_TIME',
      ])
      .optional(),
    theme: z.enum(['SYSTEM', 'LIGHT', 'DARK']).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);

export async function GET(request: Request): Promise<NextResponse> {
  return apiHandler(request, async (requestId) => {
    const session = await requireSession(request);
    const [settings, status] = await Promise.all([
      new ApiRepository(database).settings(session.userId),
      new ApiRepository(database).syncStatus(session.userId, 5),
    ]);
    return jsonResponse({ settings, connection: status }, requestId);
  });
}

export async function PATCH(request: Request): Promise<NextResponse> {
  return apiHandler(request, async (requestId) => {
    const session = await requireMutationSession(request);
    const body = updateSchema.safeParse(await request.json());
    if (!body.success)
      return NextResponse.json(
        {
          type: 'about:blank',
          title: 'Invalid settings',
          status: 400,
          code: 'INVALID_BODY',
          requestId,
        },
        {
          status: 400,
          headers: { 'Content-Type': 'application/problem+json' },
        },
      );
    const data = {
      ...(body.data.timezone ? { timezone: body.data.timezone } : {}),
      ...(body.data.weekStartsOn === undefined
        ? {}
        : { weekStartsOn: body.data.weekStartsOn }),
      ...(body.data.defaultRange
        ? { defaultRange: body.data.defaultRange }
        : {}),
      ...(body.data.theme ? { theme: body.data.theme } : {}),
    };
    const settings = await database.userSettings.update({
      where: { userId: session.userId },
      data,
    });
    return jsonResponse(settings, requestId);
  });
}
