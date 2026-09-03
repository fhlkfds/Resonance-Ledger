import { z } from 'zod';

const imageSchema = z
  .object({
    url: z.url(),
    height: z.number().int().nullable().optional(),
    width: z.number().int().nullable().optional(),
  })
  .passthrough();
const artistSchema = z
  .object({
    id: z.string().nullable(),
    name: z.string().min(1).max(1000),
    uri: z.string().nullable().optional(),
  })
  .passthrough();
const albumSchema = z
  .object({
    id: z.string().nullable(),
    name: z.string().min(1).max(2000),
    album_type: z.string().nullable().optional(),
    release_date: z.string().nullable().optional(),
    release_date_precision: z
      .enum(['year', 'month', 'day'])
      .nullable()
      .optional(),
    uri: z.string().nullable().optional(),
    images: z.array(imageSchema).max(20).default([]),
    artists: z.array(artistSchema).min(1).max(100),
  })
  .passthrough();

const trackSchema = z
  .object({
    id: z.string().nullable(),
    name: z.string().min(1).max(2000),
    duration_ms: z.number().int().nonnegative().max(86_400_000),
    disc_number: z.number().int().positive().nullable().optional(),
    track_number: z.number().int().positive().nullable().optional(),
    explicit: z.boolean().default(false),
    is_local: z.boolean().default(false),
    uri: z.string().nullable().optional(),
    external_ids: z
      .object({ isrc: z.string().nullable().optional() })
      .passthrough()
      .optional(),
    artists: z.array(artistSchema).min(1).max(100),
    album: albumSchema.nullable().optional(),
  })
  .passthrough();

export const recentlyPlayedPageSchemaV1 = z
  .object({
    items: z
      .array(
        z
          .object({
            played_at: z.iso.datetime({ offset: true }),
            track: trackSchema,
          })
          .passthrough(),
      )
      .max(50),
    next: z.url().nullable(),
    cursors: z
      .object({
        after: z.string().nullable().optional(),
        before: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type SpotifyPlayedItem = z.infer<
  typeof recentlyPlayedPageSchemaV1
>['items'][number];
