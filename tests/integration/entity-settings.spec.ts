import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeExpiredFiles } from '@/core/privacy/retention-accounts';
import type { MemberRole } from '@/generated/prisma/enums';
import type { KorumPrismaClient } from '@/lib/prisma';
import { ResourceNotFoundError, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { loadEntitySettings } from '@/services/panel/entity-settings-data';
import { EntitySettingsError, saveEntitySettings } from '@/services/panel/entity-settings.service';
import { KYB_UPLOAD_RULE } from '@/lib/rate-limit-rules';
import { authorizeKybUpload, KybRejectedError, openKybDocument, saveKybIdentity, submitKyb, uploadKybDocument } from '@/services/panel/kyb.service';
import { MemoryStorage } from '@/services/storage/memory-storage';
import { containsText, jpegWithExif, SECRET_MARKERS } from './image-fixtures';
import { createOrganization, createTestClient, createUser, table, uniqueId } from './test-database';

/**
 * Sprint 4.2c · Documentos del titular (KYB) y ajustes de la entidad contra PostgreSQL real (QA-S02, QA-OPS02): los documentos van al cubo privado
 * con su plazo legal y sustituir uno no lo borra; se envían a revisión solo completos y con el CIF; enviados o verificados no se cambian; ninguna
 * persona de otra entidad (ni el Super-Admin en su nombre) los sube, y abrirlos pasa por la guardia. La base impide editar o borrar un documento
 * entregado y colgarle el fichero de otra entidad. Los ajustes guardan céntimos y, si baja el mínimo de firmas, pasan las ideas que ya lo cumplen.
 */

const DAY = 86_400_000;
let db: KorumPrismaClient;
let storage: MemoryStorage;
const createdOrganizations: string[] = [];

beforeAll(async () => {
  db = createTestClient();
  storage = new MemoryStorage();
});

afterAll(async () => {
  await db.outboxMessage.deleteMany({ where: { organizationId: { in: createdOrganizations }, status: 'PENDING' } });
  await db.$disconnect();
});

const actorFor = (userId: string, memberships: Array<{ organizationId: string; role: MemberRole }>, overrides: Partial<Extract<SessionActor, { kind: 'user' }>> = {}): SessionActor => ({ kind: 'user', userId, isSuperadmin: false, memberships, secondFactor: true, ...overrides });

const pdf = (label = 'documento') => new TextEncoder().encode(`%PDF-1.4\n% ${label} ${Math.random()}\n%%EOF\n`);

/** CIF con su dígito de control, distinto en cada llamada (G + 7 cifras + control). */
function validCif(): string {
  const digits = String(1_000_000 + Math.floor(Math.random() * 8_999_999));
  let sum = 0;
  for (let index = 0; index < 7; index += 1) {
    const value = Number(digits[index]);
    sum += index % 2 === 1 ? value : Math.floor((value * 2) / 10) + ((value * 2) % 10);
  }
  return `G${digits}${(10 - (sum % 10)) % 10}`;
}

async function team(overrides: Parameters<typeof createOrganization>[1] = {}) {
  const organization = await createOrganization(db, overrides);
  createdOrganizations.push(organization.id);
  const director = await createUser(db, { twoFactorEnabled: true });
  const cosigner = await createUser(db, { twoFactorEnabled: true });
  await db.organizationMember.createMany({ data: [{ organizationId: organization.id, userId: director.id, role: 'DIRECTOR' }, { organizationId: organization.id, userId: cosigner.id, role: 'COSIGNER' }] });
  return {
    organization,
    director: actorFor(director.id, [{ organizationId: organization.id, role: 'DIRECTOR' }]),
    cosigner: actorFor(cosigner.id, [{ organizationId: organization.id, role: 'COSIGNER' }])
  };
}

const upload = (actor: SessionActor, organizationId: string, kind: Parameters<typeof uploadKybDocument>[3]['kind'], now = new Date()) =>
  uploadKybDocument(db, storage, actor, { organizationId, kind, bytes: pdf(kind), declaredMimeType: 'application/pdf', fileName: `${kind}.pdf` }, now);

const BASE_KINDS = ['TAX_ID_CARD', 'STATUTES', 'REPRESENTATIVE_ID', 'ACCOUNT_OWNERSHIP'] as const;

describe('Documentos del titular: subir y sustituir', () => {
  it('cada documento va al cubo privado con su plazo legal; sustituirlo lo deja de vigente sin borrarlo y empieza a contar su plazo', async () => {
    const { organization, director, cosigner } = await team();
    const t0 = new Date('2026-11-01T10:00:00Z');
    const first = await upload(director, organization.id, 'STATUTES', t0);
    const stored = await db.kybDocument.findUniqueOrThrow({ where: { id: first.documentId }, include: { file: true } });
    expect(stored).toMatchObject({ kind: 'STATUTES', replacedAt: null, uploadedById: director.kind === 'user' ? director.userId : '' });
    expect(stored.file).toMatchObject({ purpose: 'KYB_DOCUMENT', visibility: 'PRIVATE', organizationId: organization.id, mimeType: 'application/pdf' });
    expect(stored.file.retainUntil?.toISOString()).toBe('2032-11-01T10:00:00.000Z');

    const t1 = new Date('2026-11-05T10:00:00Z');
    const second = await upload(cosigner, organization.id, 'STATUTES', t1);
    const old = await db.kybDocument.findUniqueOrThrow({ where: { id: first.documentId }, include: { file: true } });
    expect(old.replacedAt?.toISOString()).toBe(t1.toISOString());
    expect(old.file.deletedAt).toBeNull();
    expect(old.file.retainUntil?.toISOString()).toBe('2032-11-05T10:00:00.000Z');
    expect(await db.kybDocument.count({ where: { organizationId: organization.id, kind: 'STATUTES', replacedAt: null } })).toBe(1);

    const audit = await db.auditLog.findMany({ where: { organizationId: organization.id, action: 'kyb.document_uploaded' }, orderBy: { id: 'asc' } });
    expect(audit).toHaveLength(2);
    expect(audit[1]!.metadataJson).toMatchObject({ kind: 'STATUTES', replacedDocumentId: first.documentId });
    const data = await loadEntitySettings(db, director, organization.id);
    expect(data.kyb.documents.map((document) => document.id)).toEqual([second.documentId]);
    expect(data.kyb.replacedCount).toBe(1);
    // La vista no lleva la ruta del fichero en el almacén ni quién lo subió.
    expect(JSON.stringify(data)).not.toContain(stored.file.objectKey);
    expect(JSON.stringify(data)).not.toContain(stored.uploadedById!);
  });

  it('rechaza un fichero que no es lo que dice ser y no deja nada a medias', async () => {
    const { organization, director } = await team();
    const before = await db.fileAsset.count({ where: { organizationId: organization.id } });
    await expect(uploadKybDocument(db, storage, director, { organizationId: organization.id, kind: 'TAX_ID_CARD', bytes: new TextEncoder().encode('<html>no</html>'), declaredMimeType: 'application/pdf', fileName: 'cif.pdf' })).rejects.toMatchObject({ reason: 'TYPE_NOT_ALLOWED' });
    expect(await db.fileAsset.count({ where: { organizationId: organization.id } })).toBe(before);
    expect(await db.kybDocument.count({ where: { organizationId: organization.id } })).toBe(0);
  });

  it('la acreditación de la Ley 49/2002 solo se sube si la entidad la declara, y entonces es obligatoria para enviar', async () => {
    const plain = await team();
    await expect(upload(plain.director, plain.organization.id, 'LEY49_ACCREDITATION')).rejects.toMatchObject({ reason: 'NOT_REQUIRED' });

    const declared = await team({ ley49: true, cif: validCif() });
    for (const kind of BASE_KINDS) await upload(declared.director, declared.organization.id, kind);
    await expect(submitKyb(db, declared.director, declared.organization.id)).rejects.toMatchObject({ reason: 'INCOMPLETE', fields: ['LEY49_ACCREDITATION'] });
    await upload(declared.cosigner, declared.organization.id, 'LEY49_ACCREDITATION');
    await submitKyb(db, declared.cosigner, declared.organization.id);
    expect((await db.organization.findUniqueOrThrow({ where: { id: declared.organization.id } })).kybStatus).toBe('SUBMITTED');
  });
});

describe('Datos del titular y envío a revisión', () => {
  it('pide el CIF de una persona jurídica válido y único; con todo entregado pasa a SUBMITTED y queda bloqueado', async () => {
    const { organization, director } = await team({ kybStatus: 'REJECTED', kybReviewNote: 'Falta la segunda cara del DNI.' });
    for (const kind of BASE_KINDS) await upload(director, organization.id, kind);
    await expect(submitKyb(db, director, organization.id)).rejects.toMatchObject({ reason: 'INCOMPLETE', fields: ['cif'] });

    await expect(saveKybIdentity(db, director, organization.id, { legalName: 'AFA del CEIP', cif: '12345678Z' })).rejects.toMatchObject({ reason: 'INVALID', fields: ['cif'] });
    await expect(saveKybIdentity(db, director, organization.id, { legalName: 'AFA www.estafa.example', cif: validCif() })).rejects.toMatchObject({ reason: 'INVALID', fields: ['legalName'] });
    const taken = await createOrganization(db, { cif: validCif() });
    createdOrganizations.push(taken.id);
    await expect(saveKybIdentity(db, director, organization.id, { legalName: 'AFA del CEIP', cif: taken.cif! })).rejects.toMatchObject({ reason: 'CIF_IN_USE', fields: ['cif'] });

    const cif = validCif();
    await expect(saveKybIdentity(db, director, organization.id, { legalName: '  AFA del CEIP Cervantes  ', cif: `${cif.slice(0, 1)}-${cif.slice(1)}`.toLowerCase() })).resolves.toEqual({ legalName: 'AFA del CEIP Cervantes', cif });
    const now = new Date('2026-11-09T09:00:00Z');
    await submitKyb(db, director, organization.id, now);
    const stored = await db.organization.findUniqueOrThrow({ where: { id: organization.id } });
    expect(stored).toMatchObject({ kybStatus: 'SUBMITTED', kybReviewNote: null, legalName: 'AFA del CEIP Cervantes', cif });
    expect(stored.kybSubmittedAt?.toISOString()).toBe(now.toISOString());
    const audit = await db.auditLog.findFirstOrThrow({ where: { organizationId: organization.id, action: 'kyb.submitted' } });
    expect(audit.metadataJson).toMatchObject({ from: 'REJECTED' });
    expect(JSON.stringify((await db.auditLog.findFirstOrThrow({ where: { organizationId: organization.id, action: 'kyb.identity_updated' } })).metadataJson)).not.toContain(cif);

    // Enviados: ni documentos ni datos del titular se cambian, y el fichero de una subida rechazada no se queda en el almacén.
    const files = await db.fileAsset.count({ where: { organizationId: organization.id, deletedAt: null } });
    await expect(upload(director, organization.id, 'STATUTES')).rejects.toMatchObject({ reason: 'LOCKED' });
    await expect(saveKybIdentity(db, director, organization.id, { legalName: 'Otro nombre', cif })).rejects.toMatchObject({ reason: 'LOCKED' });
    await expect(submitKyb(db, director, organization.id)).rejects.toMatchObject({ reason: 'LOCKED' });
    expect(await db.fileAsset.count({ where: { organizationId: organization.id, deletedAt: null } })).toBe(files);
  });

  it('una subida y un envío a la vez se ordenan: el envío no deja fuera el documento ni lo acepta después', async () => {
    const { organization, director, cosigner } = await team({ cif: validCif() });
    for (const kind of BASE_KINDS.slice(0, 3)) await upload(director, organization.id, kind);
    const [uploaded, submitted] = await Promise.allSettled([upload(cosigner, organization.id, 'ACCOUNT_OWNERSHIP'), submitKyb(db, director, organization.id)]);
    const status = (await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).kybStatus;
    if (submitted.status === 'fulfilled') {
      // El envío fue después de la subida: tenía los cuatro.
      expect(uploaded.status).toBe('fulfilled');
      expect(status).toBe('SUBMITTED');
    } else {
      expect(submitted.reason).toBeInstanceOf(KybRejectedError);
      expect(status).toBe('PENDING');
    }
  });

  it('dos subidas del mismo tipo a la vez dejan un solo documento vigente', async () => {
    const { organization, director, cosigner } = await team();
    await Promise.allSettled([upload(director, organization.id, 'TAX_ID_CARD'), upload(cosigner, organization.id, 'TAX_ID_CARD')]);
    expect(await db.kybDocument.count({ where: { organizationId: organization.id, kind: 'TAX_ID_CARD', replacedAt: null } })).toBe(1);
  });
});

describe('Aislamiento y guardia', () => {
  it('nadie de otra entidad, sin segundo factor o el Super-Admin en su nombre sube documentos; los intentos quedan en la auditoría', async () => {
    const mine = await team();
    const other = await team();
    await expect(upload(other.director, mine.organization.id, 'STATUTES')).rejects.toBeInstanceOf(TenantAccessError);
    const superadmin = actorFor((await createUser(db, { isSuperadmin: true, twoFactorEnabled: true })).id, [], { isSuperadmin: true });
    await expect(upload(superadmin, mine.organization.id, 'STATUTES')).rejects.toBeInstanceOf(TenantAccessError);
    const withoutSecondFactor = { ...mine.director, secondFactor: false } as SessionActor;
    await expect(upload(withoutSecondFactor, mine.organization.id, 'STATUTES')).rejects.toBeInstanceOf(TenantAccessError);
    await expect(saveEntitySettings(db, superadmin, mine.organization.id, {})).rejects.toBeInstanceOf(TenantAccessError);
    await expect(submitKyb(db, other.cosigner, mine.organization.id)).rejects.toBeInstanceOf(TenantAccessError);
    await expect(saveKybIdentity(db, other.director, mine.organization.id, { legalName: 'AFA ajena', cif: validCif() })).rejects.toBeInstanceOf(TenantAccessError);
    await expect(saveKybIdentity(db, superadmin, mine.organization.id, { legalName: 'AFA ajena', cif: validCif() })).rejects.toBeInstanceOf(TenantAccessError);
    await expect(authorizeKybUpload(db, other.director, mine.organization.id)).rejects.toBeInstanceOf(TenantAccessError);
    expect(await db.kybDocument.count({ where: { organizationId: mine.organization.id } })).toBe(0);
    expect(await db.auditLog.count({ where: { organizationId: mine.organization.id, action: 'tenant.access_denied' } })).toBeGreaterThanOrEqual(4);
  });

  it('abrir un documento: las dos firmas y el Super-Admin (con registro) reciben un enlace de 5 minutos; de otra entidad, como si no existiera', async () => {
    const mine = await team();
    const other = await team();
    const { documentId } = await upload(mine.director, mine.organization.id, 'REPRESENTATIVE_ID');
    const url = await openKybDocument(db, storage, mine.cosigner, mine.organization.id, documentId);
    expect(storage.resolveSignedUrl(url)?.contentType).toBe('application/pdf');
    // Cada apertura queda en la auditoría (hay un DNI entre los documentos), y sin segundo factor no se abre.
    expect(await db.auditLog.findFirst({ where: { organizationId: mine.organization.id, action: 'kyb.document_opened', targetId: String(documentId) } })).toMatchObject({ metadataJson: { kind: 'REPRESENTATIVE_ID' } });
    await expect(openKybDocument(db, storage, { ...mine.cosigner, secondFactor: false } as SessionActor, mine.organization.id, documentId)).rejects.toBeInstanceOf(TenantAccessError);
    const superadmin = actorFor((await createUser(db, { isSuperadmin: true, twoFactorEnabled: true })).id, [], { isSuperadmin: true });
    await expect(openKybDocument(db, storage, superadmin, mine.organization.id, documentId)).resolves.toMatch(/^memory:\/\/signed\//);
    // El identificador de un documento de otra entidad, pedido desde la propia: no existe.
    await expect(openKybDocument(db, storage, other.director, other.organization.id, documentId)).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(openKybDocument(db, storage, other.director, mine.organization.id, documentId)).rejects.toBeInstanceOf(TenantAccessError);
    await expect(loadEntitySettings(db, other.director, mine.organization.id)).rejects.toBeInstanceOf(TenantAccessError);
    await expect(loadEntitySettings(db, superadmin, mine.organization.id)).resolves.toMatchObject({ kyb: { status: 'PENDING' } });
  });
});

describe('La base de datos protege los documentos entregados', () => {
  it('no se borran ni se editan; solo se marcan una vez como sustituidos; el fichero debe ser un KYB privado de la misma entidad', async () => {
    const mine = await team();
    const other = await team();
    const { documentId } = await upload(mine.director, mine.organization.id, 'STATUTES');
    await expect(db.$executeRawUnsafe(`DELETE FROM ${table('KybDocument')} WHERE id = ${documentId}`)).rejects.toThrow(/no se borra/);
    await expect(db.$executeRawUnsafe(`UPDATE ${table('KybDocument')} SET kind = 'TAX_ID_CARD' WHERE id = ${documentId}`)).rejects.toThrow(/sustituido/);
    await db.$executeRawUnsafe(`UPDATE ${table('KybDocument')} SET "replacedAt" = now() WHERE id = ${documentId}`);
    await expect(db.$executeRawUnsafe(`UPDATE ${table('KybDocument')} SET "replacedAt" = NULL WHERE id = ${documentId}`)).rejects.toThrow(/sustituido/);

    const foreign = await db.kybDocument.findUniqueOrThrow({ where: { id: documentId } });
    await expect(db.kybDocument.create({ data: { organizationId: other.organization.id, kind: 'STATUTES', fileId: uniqueId('missing') } })).rejects.toThrow();
    const otherFile = (await upload(other.director, other.organization.id, 'TAX_ID_CARD')).documentId;
    const otherFileId = (await db.kybDocument.findUniqueOrThrow({ where: { id: otherFile } })).fileId;
    await expect(db.$executeRawUnsafe(`INSERT INTO ${table('KybDocument')} ("organizationId", kind, "fileId") VALUES ('${mine.organization.id}', 'TAX_ID_CARD', '${otherFileId}')`)).rejects.toThrow(/no es un documento KYB privado/);
    expect(foreign.organizationId).toBe(mine.organization.id);
  });

  it('la purga no toca un documento vigente de una entidad activa aunque haya vencido su fecha, y sí uno sustituido', async () => {
    const { organization, director } = await team();
    const old = await upload(director, organization.id, 'ACCOUNT_OWNERSHIP', new Date('2010-01-01T00:00:00Z'));
    await upload(director, organization.id, 'ACCOUNT_OWNERSHIP', new Date('2011-01-01T00:00:00Z'));
    const current = await upload(director, organization.id, 'STATUTES', new Date('2010-01-01T00:00:00Z'));
    // Ambos ficheros con el plazo vencido a fecha de hoy (subidos y sustituidos hace más de 6 años).
    await purgeExpiredFiles(db, () => storage, new Date(), 500);
    const fileOf = async (id: number) => db.fileAsset.findUniqueOrThrow({ where: { id: (await db.kybDocument.findUniqueOrThrow({ where: { id } })).fileId } });
    expect((await fileOf(old.documentId)).deletedAt).not.toBeNull();
    expect((await fileOf(current.documentId)).deletedAt).toBeNull();
  });
});

describe('Correcciones de la auditoría de seguridad', () => {
  it('la foto de un documento se guarda sin metadatos (la ubicación del móvil), aunque vaya al cubo privado', async () => {
    const { organization, director } = await team();
    const { documentId } = await uploadKybDocument(db, storage, director, { organizationId: organization.id, kind: 'REPRESENTATIVE_ID', bytes: jpegWithExif(), declaredMimeType: 'image/jpeg', fileName: 'dni.jpg' });
    const url = await openKybDocument(db, storage, director, organization.id, documentId);
    const stored = storage.resolveSignedUrl(url)!.body;
    for (const marker of SECRET_MARKERS) expect(containsText(stored, marker)).toBe(false);
  });

  it('cada entidad tiene un tope de subidas por hora', async () => {
    const { organization, director } = await team();
    for (let attempt = 0; attempt < KYB_UPLOAD_RULE.limit; attempt += 1) await authorizeKybUpload(db, director, organization.id);
    await expect(authorizeKybUpload(db, director, organization.id)).rejects.toMatchObject({ reason: 'RATE_LIMITED' });
  });

  it('el vigente de una entidad archivada se conserva 6 años desde el archivo; pasados, se purga', async () => {
    const recent = await team();
    const old = await team();
    const recentDoc = await upload(recent.director, recent.organization.id, 'STATUTES', new Date('2010-01-01T00:00:00Z'));
    const oldDoc = await upload(old.director, old.organization.id, 'STATUTES', new Date('2010-01-01T00:00:00Z'));
    const now = new Date();
    await db.organization.update({ where: { id: recent.organization.id }, data: { archivedAt: new Date(now.getTime() - 365 * DAY) } });
    await db.organization.update({ where: { id: old.organization.id }, data: { archivedAt: new Date(now.getTime() - 7 * 365 * DAY) } });
    await purgeExpiredFiles(db, () => storage, now, 500);
    const fileOf = async (id: number) => db.fileAsset.findUniqueOrThrow({ where: { id: (await db.kybDocument.findUniqueOrThrow({ where: { id } })).fileId } });
    expect((await fileOf(recentDoc.documentId)).deletedAt).toBeNull();
    expect((await fileOf(oldDoc.documentId)).deletedAt).not.toBeNull();
  });

  it('la base no deja mover, cambiar de dueño ni borrar el fichero de un documento vigente', async () => {
    const mine = await team();
    const other = await team();
    const { documentId } = await upload(mine.director, mine.organization.id, 'TAX_ID_CARD');
    const { fileId } = await db.kybDocument.findUniqueOrThrow({ where: { id: documentId } });
    await expect(db.fileAsset.update({ where: { id: fileId }, data: { organizationId: other.organization.id } })).rejects.toThrow(/no cambia de sitio/);
    await expect(db.fileAsset.update({ where: { id: fileId }, data: { visibility: 'PUBLIC' } })).rejects.toThrow(/no cambia de sitio/);
    await expect(db.fileAsset.update({ where: { id: fileId }, data: { deletedAt: new Date() } })).rejects.toThrow(/vigente/);
    await expect(db.$executeRawUnsafe(`DELETE FROM ${table('FileAsset')} WHERE id = '${fileId}'`)).rejects.toThrow(/no se borra/);
    await expect(db.fileAsset.update({ where: { id: fileId }, data: { retainUntil: new Date('2040-01-01T00:00:00Z') } })).resolves.toMatchObject({ id: fileId });
  });
});

describe('Ajustes generales', () => {
  const valid = { donationPresetsEuros: [5, 15, 40], defaultDonationIdx: 2, minVotes: 20, maxIdeaDays: 30, sponsorTiersEuros: [80, 200, 600], phone: '+34 93 123 45 67', contentLocale: 'ca', publicIndexing: false };

  it('guarda en céntimos, sin el teléfono en la auditoría; los datos que no cuadran se señalan por campo', async () => {
    const { organization, cosigner } = await team();
    const result = await saveEntitySettings(db, cosigner, organization.id, valid);
    expect(result).toEqual({ ideasToDoubleCheck: [], portalChanged: true });
    expect(await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).toMatchObject({
      donationPresetsCents: [500, 1500, 4000],
      defaultDonationIdx: 2,
      minVotes: 20,
      maxIdeaDays: 30,
      sponsorTiersCents: [8000, 20000, 60000],
      phone: '+34931234567',
      contentLocale: 'ca',
      publicIndexing: false
    });
    const audit = await db.auditLog.findFirstOrThrow({ where: { organizationId: organization.id, action: 'organization.settings_updated' } });
    expect(JSON.stringify(audit.metadataJson)).not.toContain('931234567');
    expect(audit.metadataJson).toMatchObject({ phoneChanged: true });

    await expect(saveEntitySettings(db, cosigner, organization.id, { ...valid, donationPresetsEuros: [10, 10, 50], minVotes: 2, phone: '123' })).rejects.toMatchObject({ fields: ['donationPresetsEuros', 'minVotes', 'phone'] });
    await expect(saveEntitySettings(db, cosigner, organization.id, { ...valid, sponsorTiersEuros: [100, 250, 50_000] })).rejects.toBeInstanceOf(EntitySettingsError);
    await expect(saveEntitySettings(db, cosigner, organization.id, { ...valid, donationPresetsEuros: [1.5, 15, 40] })).rejects.toBeInstanceOf(EntitySettingsError);
    const reloaded = await loadEntitySettings(db, cosigner, organization.id);
    expect(reloaded.settings).toEqual({ ...valid, phone: '+34931234567' });
  });

  it('al bajar el mínimo de firmas, las ideas que ya lo cumplen pasan a la doble firma con su aviso; las caducadas o con pocas firmas, no', async () => {
    const { organization, director } = await team({ minVotes: 30 });
    const now = new Date();
    const idea = (verifiedVotes: number, expiresAt = new Date(now.getTime() + 5 * DAY)) =>
      db.idea.create({ data: { organizationId: organization.id, alias: `#FAM-${1000 + Math.floor(Math.random() * 9000)}`, authorCanonicalEmail: `${uniqueId('a')}@pruebas.example`, title: 'Huerto escolar', category: 'Patios', description: 'Un huerto para todos los cursos del colegio.', phase: 'PUBLIC_VOTING', verifiedVotes, expiresAt } });
    const ready = await idea(22);
    const short = await idea(10);
    const expired = await idea(25, new Date(now.getTime() - DAY));
    const result = await saveEntitySettings(db, director, organization.id, { ...valid, minVotes: 20, contentLocale: 'es', publicIndexing: true }, now);
    expect(result).toEqual({ ideasToDoubleCheck: [ready.id], portalChanged: false });
    const phases = await db.idea.findMany({ where: { id: { in: [ready.id, short.id, expired.id] } }, select: { id: true, phase: true, expiresAt: true } });
    expect(phases.find((row) => row.id === ready.id)).toMatchObject({ phase: 'DOUBLE_CHECK' });
    expect(phases.find((row) => row.id === ready.id)!.expiresAt.getTime()).toBe(now.getTime() + 30 * DAY);
    expect(phases.find((row) => row.id === short.id)?.phase).toBe('PUBLIC_VOTING');
    expect(phases.find((row) => row.id === expired.id)?.phase).toBe('PUBLIC_VOTING');
    expect(await db.outboxMessage.count({ where: { organizationId: organization.id, templateKey: 'idea.quorumReached' } })).toBe(2);
  });
});
