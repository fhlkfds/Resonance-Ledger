import { z } from 'zod';
import { pageFields } from './query';
import { rangeFields } from './ranges';

export const historyQuerySchema = z
  .object({
    ...rangeFields,
    ...pageFields,
    q: z.string().trim().min(1).max(200).optional(),
    artistId: z.uuid().optional(),
    albumId: z.uuid().optional(),
    trackId: z.uuid().optional(),
    explicit: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
  })
  .strict();
