import { z } from 'zod';
import { ProblemError } from './errors';

const cursorSchema = z
  .object({ at: z.iso.datetime({ offset: true }), id: z.uuid() })
  .strict();
export type TimeCursor = z.infer<typeof cursorSchema>;

export function encodeCursor(cursor: TimeCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(value: string | null): TimeCursor | null {
  if (!value) return null;
  try {
    if (value.length > 1024) throw new Error('oversized');
    return cursorSchema.parse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
  } catch {
    throw new ProblemError(400, 'INVALID_CURSOR', 'Cursor is invalid');
  }
}

export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

export function decodeOffsetCursor(value: string | undefined): number {
  if (!value) return 0;
  try {
    const parsed = z
      .object({ offset: z.number().int().nonnegative().max(1_000_000) })
      .strict()
      .parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    return parsed.offset;
  } catch {
    throw new ProblemError(400, 'INVALID_CURSOR', 'Cursor is invalid');
  }
}
