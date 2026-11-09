import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orderedGroupNames } from '@/core/public/course-challenge';
import type { MemberRole } from '@/generated/prisma/enums';
import type { KorumPrismaClient } from '@/lib/prisma';
import { getPublicInitiativeCard, getPublicOrganization } from '@/repositories/public.repository';
import { TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { loadEntitySettings } from '@/services/panel/entity-settings-data';
import { EntityBrandingError, publishEntityImage, removeEntityImage } from '@/services/panel/entity-branding.service';
import { ParticipationGroupsError, saveParticipationGroups } from '@/services/panel/participation-groups.service';
import { FileRejectedError } from '@/services/storage/file-asset.service';
import { MemoryStorage } from '@/services/storage/memory-storage';
import { containsText, jpegWithExif, SECRET_MARKERS } from './image-fixtures';
import { createInitiative, createOrganization, createTestClient, createUser } from './test-database';

/**
 * Sprint 4.2e · Grupos de participación e identidad visual contra PostgreSQL real: las dos personas firmantes cambian los grupos (sin identificadores
 * repetidos, con el antes y el después en la auditoría) y el logotipo y la portada, que se publican sin metadatos, sustituyen al anterior (que se
 * retira del almacén) y salen en la lectura pública solo mientras son públicos. Nadie de otra entidad ni el Super-Admin los cambia.
 */

let db: KorumPrismaClient;
let storage: MemoryStorage;

beforeAll(() => {
  db = createTestClient();
  storage = new MemoryStorage();
});

afterAll(async () => {
  await db.$disconnect();
});

const actorFor = (userId: string, organizationId: string, role: MemberRole, secondFactor = true): SessionActor => ({ kind: 'user', userId, isSuperadmin: false, memberships: [{ organizationId, role }], secondFactor });

async function team(vertical: 'SCHOOL' | 'SPORTS_CLUB' = 'SCHOOL') {
  const organization = await createOrganization(db, { vertical });
  const [director, cosigner] = await Promise.all([createUser(db, { twoFactorEnabled: true }), createUser(db, { twoFactorEnabled: true })]);
  await db.organizationMember.createMany({ data: [{ organizationId: organization.id, userId: director.id, role: 'DIRECTOR' }, { organizationId: organization.id, userId: cosigner.id, role: 'COSIGNER' }] });
  return { organization, director: actorFor(director.id, organization.id, 'DIRECTOR'), cosigner: actorFor(cosigner.id, organization.id, 'COSIGNER') };
}

const png = () => {
  // PNG mínimo de 1×1 válido.
  const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  return new Uint8Array(Buffer.from(base64, 'base64'));
};

describe('grupos de participación', () => {
  it('sin personalizar, el formulario parte de la plantilla de su vertical; al guardar, el portal y el checkout usan los nuevos', async () => {
    const { organization, cosigner } = await team('SPORTS_CLUB');
    const initial = await loadEntitySettings(db, cosigner, organization.id);
    expect(initial.groups.customized).toBe(false);
    expect(initial.groups.blocks.flatMap((block) => block.items)).toContain('Alevín');

    const blocks = [
      { group: 'Fútbol base', items: ['Prebenjamín', 'Benjamín', ' Alevín A ', 'Alevín B'] },
      { group: 'Afición', items: ['Socio / Afición'] }
    ];
    await saveParticipationGroups(db, cosigner, organization.id, { blocks });
    const stored = await db.organization.findUniqueOrThrow({ where: { id: organization.id }, select: { participationGroupsJson: true } });
    expect(orderedGroupNames('SPORTS_CLUB', stored.participationGroupsJson)).toEqual(['Prebenjamín', 'Benjamín', 'Alevín A', 'Alevín B', 'Socio / Afición']);
    expect((await loadEntitySettings(db, cosigner, organization.id)).groups.customized).toBe(true);
    const audit = await db.auditLog.findFirstOrThrow({ where: { organizationId: organization.id, action: 'organization.groups_updated' } });
    expect(audit.metadataJson).toMatchObject({ before: null, after: [{ group: 'Fútbol base' }, { group: 'Afición' }] });
  });

  it('no guarda dos grupos con el mismo enlace, enlaces en los nombres ni nada sin segundo factor o desde otra entidad', async () => {
    const { organization, director } = await team();
    const other = await team();
    const duplicated = await saveParticipationGroups(db, director, organization.id, { blocks: [{ group: 'Primaria', items: ['3º de Primaria', '3º Primaria'] }] }).catch((error: unknown) => error);
    expect(duplicated).toBeInstanceOf(ParticipationGroupsError);
    expect((duplicated as ParticipationGroupsError).issues).toEqual([{ code: 'DUPLICATE', names: ['3º de Primaria', '3º Primaria'] }]);
    const linked = await saveParticipationGroups(db, director, organization.id, { blocks: [{ group: 'Primaria', items: ['1º', 'Ver https://x.es'] }] }).catch((error: unknown) => error);
    expect((linked as ParticipationGroupsError).fields).toEqual(['blocks.0.items']);
    await expect(saveParticipationGroups(db, other.director, organization.id, { blocks: [{ group: 'X', items: ['Y'] }] })).rejects.toBeInstanceOf(TenantAccessError);
    await expect(saveParticipationGroups(db, { ...director, secondFactor: false } as SessionActor, organization.id, { blocks: [{ group: 'X', items: ['Y'] }] })).rejects.toBeInstanceOf(TenantAccessError);
    expect((await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).participationGroupsJson).toBeNull();
  });
});

describe('logotipo y portada', () => {
  it('se publican sin metadatos y públicos; el nuevo sustituye al anterior, que sale del almacén; la lectura pública los ve', async () => {
    const { organization, director, cosigner } = await team();
    const initiative = await createInitiative(db, organization.id, { status: 'FUNDRAISING' });
    const first = await publishEntityImage(db, storage, director, { organizationId: organization.id, kind: 'logo', bytes: jpegWithExif(), declaredMimeType: 'image/jpeg', fileName: 'escudo.jpg' });
    const asset = await db.fileAsset.findUniqueOrThrow({ where: { id: first.fileId } });
    expect(asset).toMatchObject({ purpose: 'ORG_LOGO', visibility: 'PUBLIC', organizationId: organization.id, mimeType: 'image/jpeg' });
    const object = storage.readPublic(asset.bucket, asset.objectKey);
    for (const marker of SECRET_MARKERS) expect(containsText(object!.body, marker), marker).toBe(false);
    expect((await getPublicOrganization(db, organization.slug)).logoFileId).toBe(first.fileId);
    expect((await getPublicInitiativeCard(db, initiative.id)).organization.logoFileId).toBe(first.fileId);

    const second = await publishEntityImage(db, storage, cosigner, { organizationId: organization.id, kind: 'logo', bytes: png(), declaredMimeType: 'image/png', fileName: 'escudo.png' });
    expect((await db.fileAsset.findUniqueOrThrow({ where: { id: first.fileId } })).deletedAt).not.toBeNull();
    expect(storage.readPublic(asset.bucket, asset.objectKey)).toBeNull();
    expect((await getPublicOrganization(db, organization.slug)).logoFileId).toBe(second.fileId);

    const banner = await publishEntityImage(db, storage, director, { organizationId: organization.id, kind: 'banner', bytes: png(), declaredMimeType: 'image/png', fileName: 'portada.png', noMinorsConfirmed: true });
    expect((await db.fileAsset.findUniqueOrThrow({ where: { id: banner.fileId } })).purpose).toBe('ORG_BANNER');
    expect((await loadEntitySettings(db, director, organization.id)).brand).toMatchObject({ logoFileId: second.fileId, bannerFileId: banner.fileId });

    expect(await removeEntityImage(db, storage, cosigner, organization.id, 'logo')).toBe(true);
    expect(await removeEntityImage(db, storage, cosigner, organization.id, 'logo')).toBe(false);
    expect((await getPublicOrganization(db, organization.slug)).logoFileId).toBeNull();
    expect((await getPublicOrganization(db, organization.slug)).bannerFileId).toBe(banner.fileId);
    expect(await db.auditLog.count({ where: { organizationId: organization.id, action: { in: ['organization.image_published', 'organization.image_removed'] } } })).toBe(4);
  });

  it('un fichero que no es imagen, una imagen ilegible o alguien de otra entidad no publican nada', async () => {
    const { organization, director } = await team();
    const other = await team();
    const pdf = new TextEncoder().encode('%PDF-1.4\n%%EOF\n');
    await expect(publishEntityImage(db, storage, director, { organizationId: organization.id, kind: 'logo', bytes: pdf, declaredMimeType: 'application/pdf', fileName: 'logo.pdf' })).rejects.toBeInstanceOf(EntityBrandingError);
    const truncated = jpegWithExif().slice(0, 30);
    await expect(publishEntityImage(db, storage, director, { organizationId: organization.id, kind: 'logo', bytes: truncated, declaredMimeType: 'image/jpeg', fileName: 'logo.jpg' })).rejects.toBeInstanceOf(EntityBrandingError);
    await expect(publishEntityImage(db, storage, other.director, { organizationId: organization.id, kind: 'banner', bytes: png(), declaredMimeType: 'image/png', fileName: 'portada.png', noMinorsConfirmed: true })).rejects.toBeInstanceOf(TenantAccessError);
    await expect(publishEntityImage(db, storage, director, { organizationId: organization.id, kind: 'logo', bytes: png(), declaredMimeType: 'image/jpeg', fileName: 'logo.jpg' })).rejects.toBeInstanceOf(FileRejectedError);
    // La portada sin la confirmación de que no salen menores reconocibles no se publica.
    await expect(publishEntityImage(db, storage, director, { organizationId: organization.id, kind: 'banner', bytes: png(), declaredMimeType: 'image/png', fileName: 'portada.png' })).rejects.toMatchObject({ reason: 'MINORS_NOT_CONFIRMED' });
    expect(await db.fileAsset.count({ where: { organizationId: organization.id, deletedAt: null } })).toBe(0);
    expect((await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).logoFileId).toBeNull();
  });
});
