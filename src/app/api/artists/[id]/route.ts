import { entityDetailHandler } from '@/lib/api/entities';
export const GET = (
  request: Request,
  context: { params: Promise<{ id: string }> },
) =>
  context.params.then(({ id }) => entityDetailHandler(request, 'artist', id));
