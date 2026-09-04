import { entityListHandler } from '@/lib/api/entities';
export const GET = (request: Request) => entityListHandler(request, 'track');
