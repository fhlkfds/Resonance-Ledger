import { randomUUID } from 'node:crypto';

const validRequestId = /^[A-Za-z0-9._-]{1,128}$/;

export function resolveRequestId(header: string | null): string {
  return header && validRequestId.test(header) ? header : randomUUID();
}
