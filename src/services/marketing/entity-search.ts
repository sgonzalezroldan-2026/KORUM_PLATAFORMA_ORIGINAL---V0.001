import { cleanSearchQuery, filterEntities, type PublicEntityHit } from '@/lib/entity-search';
import type { KorumPrismaClient } from '@/lib/prisma';
import { listPublicDirectory } from '@/repositories/public.repository';

export async function searchPublicEntities(db: KorumPrismaClient, rawQuery: string): Promise<PublicEntityHit[]> {
  if (!cleanSearchQuery(rawQuery)) return [];
  return filterEntities(await listPublicDirectory(db), rawQuery);
}
