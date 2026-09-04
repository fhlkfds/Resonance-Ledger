import { NextResponse } from 'next/server';
import { database } from '@/lib/db/client';
import { resolveRequestId } from '@/lib/observability/request-id';

export async function GET(request: Request): Promise<NextResponse> {
  const requestId = resolveRequestId(request.headers.get('x-request-id'));
  try {
    await Promise.race([
      database.$queryRaw`SELECT 1`,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 1500),
      ),
    ]);
    return NextResponse.json(
      {
        status: 'ok',
        version: process.env.APP_VERSION ?? 'development',
        db: 'ok',
        requestId,
      },
      { headers: { 'Cache-Control': 'no-store', 'X-Request-ID': requestId } },
    );
  } catch {
    return NextResponse.json(
      {
        status: 'degraded',
        version: process.env.APP_VERSION ?? 'development',
        db: 'unavailable',
        requestId,
      },
      {
        status: 503,
        headers: { 'Cache-Control': 'no-store', 'X-Request-ID': requestId },
      },
    );
  }
}
