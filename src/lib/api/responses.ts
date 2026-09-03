import { NextResponse } from 'next/server';
import { ProblemError } from './errors';

export type ApiEnvelope<
  T,
  M extends Record<string, unknown> = Record<string, never>,
> = {
  data: T;
  meta: M & { requestId: string };
};

export function jsonResponse<
  T,
  M extends Record<string, unknown> = Record<string, never>,
>(data: T, requestId: string, meta?: M): NextResponse<ApiEnvelope<T, M>> {
  return NextResponse.json(
    { data, meta: { ...meta, requestId } } as ApiEnvelope<T, M>,
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}

export function problemResponse(
  error: unknown,
  requestId: string,
): NextResponse {
  const problem =
    error instanceof ProblemError
      ? error
      : new ProblemError(500, 'INTERNAL_ERROR', 'Internal server error');
  return NextResponse.json(
    {
      type: problem.type,
      title: problem.status === 500 ? 'Internal server error' : problem.message,
      status: problem.status,
      detail:
        problem.status === 500
          ? 'The request could not be completed.'
          : problem.message,
      code: problem.code,
      requestId,
    },
    {
      status: problem.status,
      headers: {
        'Content-Type': 'application/problem+json',
        'Cache-Control': 'no-store',
      },
    },
  );
}
