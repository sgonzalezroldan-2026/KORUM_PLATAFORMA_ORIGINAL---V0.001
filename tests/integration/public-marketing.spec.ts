import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PUBLIC_PRICING } from '@/core/finance/public-pricing';
import type { KorumPrismaClient } from '@/lib/prisma';
import { listPublicDirectory } from '@/repositories/public.repository';
import { searchPublicEntities } from '@/services/marketing/entity-search';
import { loadPublicPlatformConfig } from '@/services/marketing/public-config';
import { invalidateSettingsCache } from '@/services/settings/settings.service';
import { createOrganization, createTestClient, uniqueId } from './test-database';

/** QA-SEO03 · el directorio público solo muestra lo que cada entidad acepta mostrar, y la web pública lee las tarifas de la consola. */

let db: KorumPrismaClient;
const marker = uniqueId('Zeta');
let visible: { id: string; slug: string };
let hidden: { id: string };
let archived: { id: string };

beforeAll(async () => {
  db = createTestClient();
  // La fila global la crea la semilla; en el esquema de pruebas se asegura con los valores por defecto del esquema de Prisma.
  await db.globalConfig.upsert({ where: { id: 'GLOBAL' }, create: { id: 'GLOBAL' }, update: {} });
  const base = { cif: uniqueId('G'), iban: 'ES91 2100 0418 4502 0005 1332', contactEmail: `${uniqueId('c')}@entidad.example`, contactPhone: '600000000' };
  visible = await createOrganization(db, { ...base, name: `Colegio ${marker} Visible`, province: 'Málaga', vertical: 'SCHOOL' });
  hidden = await createOrganization(db, { ...base, cif: uniqueId('G'), name: `Colegio ${marker} Oculto`, publicIndexing: false });
  archived = await createOrganization(db, { ...base, cif: uniqueId('G'), name: `Colegio ${marker} Archivado`, archivedAt: new Date() });
}, 120_000);

afterAll(async () => {
  await db.platformSetting.deleteMany({ where: { key: 'seo.verification.google' } });
  await db.$disconnect();
});

describe('directorio público del buscador', () => {
  it('lista solo entidades no archivadas que aceptan aparecer en buscadores', async () => {
    const slugs = (await listPublicDirectory(db)).map((entity) => entity.slug);
    expect(slugs).toContain(visible.slug);
    expect(slugs).not.toContain(hidden.id);
    expect(slugs).not.toContain(archived.id);
  });

  it('devuelve solo nombre, enlace, tipo y provincia: ni CIF, ni IBAN, ni contactos', async () => {
    const entity = (await listPublicDirectory(db)).find((candidate) => candidate.slug === visible.slug);
    expect(Object.keys(entity ?? {}).sort()).toEqual(['name', 'province', 'slug', 'vertical']);
    expect(JSON.stringify(await searchPublicEntities(db, marker))).not.toMatch(/ES91|@entidad\.example|600000000|cif/i);
  });

  it('la búsqueda encuentra por nombre y por provincia sin importar los acentos, y no encuentra a quien no se lista', async () => {
    expect((await searchPublicEntities(db, `${marker} visible`)).map((entity) => entity.slug)).toEqual([visible.slug]);
    expect((await searchPublicEntities(db, `${marker} malaga`)).map((entity) => entity.slug)).toEqual([visible.slug]);
    expect(await searchPublicEntities(db, `${marker} oculto`)).toEqual([]);
    expect(await searchPublicEntities(db, `${marker} archivado`)).toEqual([]);
    expect(await searchPublicEntities(db, 'a')).toEqual([]);
  });
});

describe('configuración pública desde la consola', () => {
  it('las tarifas de GlobalConfig coinciden con los valores de lanzamiento que usa la web como respaldo', async () => {
    const config = await loadPublicPlatformConfig(db);
    expect(config.source).toBe('console');
    expect(config.pricing).toEqual(DEFAULT_PUBLIC_PRICING);
  });

  it('lee la etiqueta de verificación de Google que guarda el Super-Admin', async () => {
    await db.platformSetting.create({ data: { key: 'seo.verification.google', valueJson: 'token-de-prueba-123' } });
    invalidateSettingsCache();
    expect((await loadPublicPlatformConfig(db)).verification).toEqual({ google: 'token-de-prueba-123' });
  });
});
