import { z } from 'zod';
import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api/handler';
import { ProblemError } from '@/lib/api/errors';
import { rangeFields } from '@/lib/api/ranges';
import { requestRange } from '@/lib/api/request-range';
import { jsonResponse } from '@/lib/api/responses';
import { requireSession } from '@/lib/auth/request-session';
import { database } from '@/lib/db/client';
import { ApiRepository } from '@/lib/db/repositories/api';
import { analyticsData } from '@/lib/stats/analytics';

const metric = z.enum([
  'plays',
  'estimatedDurationMs',
  'uniqueTracks',
  'uniqueAlbums',
  'uniqueArtists',
]);
const dimension = z.enum([
  'time',
  'hour',
  'weekday',
  'hourWeekday',
  'month',
  'yearOverYear',
  'artist',
  'album',
  'track',
  'artistDistribution',
  'albumDistribution',
]);
const schema = z
  .object({
    ...rangeFields,
    granularity: z.enum(['hour', 'day', 'week', 'month', 'year']).optional(),
    entityId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    distributionLimit: z.coerce.number().int().min(1).max(25).default(10),
    years: z.string().max(100).optional(),
  })
  .strict();

function listValues(parameters: URLSearchParams, name: string) {
  return [
    ...parameters.getAll(`${name}[]`),
    ...(parameters.get(name)?.split(',') ?? []),
  ];
}

export async function GET(request: Request): Promise<NextResponse> {
  return apiHandler(request, async (requestId) => {
    const session = await requireSession(request);
    const url = new URL(request.url);
    const allowed = new Set([
      ...Object.keys(rangeFields),
      'metrics',
      'metrics[]',
      'dimensions',
      'dimensions[]',
      'granularity',
      'entityId',
      'limit',
      'distributionLimit',
      'years',
      'years[]',
    ]);
    if ([...url.searchParams.keys()].some((key) => !allowed.has(key)))
      throw new ProblemError(
        400,
        'INVALID_QUERY',
        'Query parameters are invalid',
      );
    const rangeParameters = new URLSearchParams(url.searchParams);
    for (const name of [
      'metrics',
      'metrics[]',
      'dimensions',
      'dimensions[]',
      'years[]',
    ])
      rangeParameters.delete(name);
    const requestUrl = new URL(url);
    requestUrl.search = rangeParameters.toString();
    const { query, range, settings } = await requestRange(
      session.userId,
      requestUrl.toString(),
      schema,
    );
    const metricValues = listValues(url.searchParams, 'metrics');
    const dimensionValues = listValues(url.searchParams, 'dimensions');
    const yearValues = listValues(url.searchParams, 'years');
    const lists = z
      .object({
        metrics: z
          .array(metric)
          .min(1)
          .max(5)
          .refine((values) => new Set(values).size === values.length),
        dimensions: z
          .array(dimension)
          .min(1)
          .max(11)
          .refine((values) => new Set(values).size === values.length),
        years: z
          .array(z.coerce.number().int().min(1970).max(9999))
          .min(1)
          .max(20)
          .refine((values) => new Set(values).size === values.length)
          .optional(),
      })
      .strict()
      .safeParse({
        metrics: metricValues.length
          ? metricValues
          : ['plays', 'estimatedDurationMs'],
        dimensions: dimensionValues.length ? dimensionValues : ['time'],
        ...(yearValues.length ? { years: yearValues } : {}),
      });
    if (!lists.success)
      throw new ProblemError(
        400,
        'INVALID_QUERY',
        'Query parameters are invalid',
      );
    const { metrics, dimensions, years } = lists.data;
    let entity: { kind: 'track' | 'artist' | 'album'; id: string } | undefined;
    if (query.entityId) {
      const repository = new ApiRepository(database);
      for (const kind of ['track', 'artist', 'album'] as const) {
        if (
          await repository.entityForUser(session.userId, kind, query.entityId)
        ) {
          entity = { kind, id: query.entityId };
          break;
        }
      }
      if (!entity)
        throw new ProblemError(404, 'ENTITY_NOT_FOUND', 'Entity not found');
    }
    const result = await analyticsData(
      database,
      session.userId,
      range,
      settings.weekStartsOn,
      {
        ...(query.granularity ? { granularity: query.granularity } : {}),
        rankingLimit: query.limit,
        distributionLimit: query.distributionLimit,
        ...(years ? { years } : {}),
        ...(entity ? { entity } : {}),
      },
    );
    const allSeries = {
      time: result.time,
      hour: result.hourly,
      weekday: result.weekday,
      hourWeekday: result.hourWeekday,
      month: result.month,
      yearOverYear: result.yearOverYear,
      artist: result.rankings.artists,
      album: result.rankings.albums,
      track: result.rankings.tracks,
      artistDistribution: result.distributions.artists,
      albumDistribution: result.distributions.albums,
    };
    return jsonResponse(
      {
        metrics,
        series: Object.fromEntries(
          dimensions.map((name) => [name, allSeries[name]]),
        ),
        totals: result.totals,
        bucketDefinitions: result.bucketDefinitions,
      },
      requestId,
      {
        timezone: range.timezone,
        range,
        metricCaveat:
          'Estimated listening time sums each track full duration. Spotify provides no actual played milliseconds.',
        artistCreditCaveat:
          'Each credited artist receives one play credit, so collaborative artist totals overlap.',
      },
    );
  });
}
