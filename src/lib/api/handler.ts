import type { NextResponse } from 'next/server';
import { problemResponse } from './responses';
import { resolveRequestId } from '@/lib/observability/request-id';

export async function apiHandler(
  request: Request,
  handler: (requestId: string) => Promise<NextResponse>,
): Promise<NextResponse> {
  const requestId = resolveRequestId(request.headers.get('x-request-id'));
  try {
    const response = await handler(requestId);
    response.headers.set('X-Request-ID', requestId);
    return response;
  } catch (error) {
    return problemResponse(error, requestId);
  }
}
