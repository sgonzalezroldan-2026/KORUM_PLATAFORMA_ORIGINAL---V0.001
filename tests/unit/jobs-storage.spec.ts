import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/cron/[job]/route';
import { academicYearFor, isLaterAcademicYear } from '@/core/finance/academic-year';
import { reconcileCharges, type LocalCharge } from '@/core/finance/reconciliation';
import { listChargesInChunks } from '@/core/jobs/handlers/psp-reconciliation';
import { JOB_HANDLERS } from '@/core/jobs/job-registry';
import { drainBatches, MAX_BATCHES_PER_EXECUTION } from '@/core/jobs/job-drain';
import { JOB_SPECS, jobTypeFromSlug, retryDelayMs, slotKey, VERCEL_PLAN } from '@/core/jobs/job-schedule';
import type { JobResult } from '@/core/jobs/job-types';
import type { MemberRole } from '@/generated/prisma/enums';
import type { Db } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { ResourceNotFoundError, type SessionActor } from '@/repositories/tenant-guard';
import { redactText, scrubEvent } from '@/lib/error-reporting';
import { PaycometAdapter } from '@/services/payments/paycomet.adapter';
import { PaymentProviderError, type PaymentProvider, type PspCharge } from '@/services/payments/payment-provider';
import { detectFileType, extensionMatches, FILE_RULES } from '@/services/storage/file-rules';
import { FileRejectedError, getFileUrl, uploadFile } from '@/services/storage/file-asset.service';
import { MemoryStorage } from '@/services/storage/memory-storage';
import { PRIVATE_BUCKET, PUBLIC_BUCKET } from '@/services/storage/storage-provider';
import { SupabaseStorage } from '@/services/storage/supabase-storage';

const bytes = (...values: number[]) => new Uint8Array(values);
const PDF = new Uint8Array([...new TextEncoder().encode('%PDF-1.7\n'), ...new Uint8Array(32)]);
/** PNG mínimo pero válido (IHDR, IDAT, IEND): las imágenes públicas pasan por el limpiador de metadatos y uno truncado se rechaza. */
const pngChunk = (type: string, body: number[]) => [0, 0, 0, body.length, ...type.split('').map((letter) => letter.charCodeAt(0)), ...body, 0, 0, 0, 0];
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...pngChunk('IHDR', new Array(13).fill(0)), ...pngChunk('IDAT', [1, 2, 3, 4]), ...pngChunk('IEND', [])]);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46);
const WEBP = bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38);

describe('calendario de tareas programadas', () => {
  it('una ejecución por hueco de tiempo: la misma clave dentro del hueco y otra al cambiar', () => {
    const base = new Date('2026-11-04T10:07:00Z');
    expect(slotKey('MASS_REFUND', base)).toBe(slotKey('MASS_REFUND', new Date('2026-11-04T10:09:59Z')));
    expect(slotKey('MASS_REFUND', base)).not.toBe(slotKey('MASS_REFUND', new Date('2026-11-04T10:10:00Z')));
    expect(slotKey('CAMPAIGN_EXPIRY', base)).toBe('CAMPAIGN_EXPIRY:2026-11-04T10:00:00.000Z');
    expect(slotKey('PSP_RECONCILIATION', base)).toBe('PSP_RECONCILIATION:2026-11-04T00:00:00.000Z');
  });

  it('la espera entre reintentos crece al doble y tiene tope de 6 horas', () => {
    expect([1, 2, 3, 4, 5].map((attempt) => retryDelayMs(attempt))).toEqual([60_000, 120_000, 240_000, 480_000, 960_000]);
    expect(retryDelayMs(9)).toBe(15_360_000);
    expect(retryDelayMs(10)).toBe(6 * 3_600_000);
    expect(retryDelayMs(500)).toBe(6 * 3_600_000);
    // La espera de las devoluciones parte del intervalo de la tarea (10 min): 10, 20, 40, 80 y 160 min.
    expect([1, 2, 3, 4, 5].map((attempt) => retryDelayMs(attempt, 10 * 60_000))).toEqual([600_000, 1_200_000, 2_400_000, 4_800_000, 9_600_000]);
    expect(() => retryDelayMs(0)).toThrow(RangeError);
    expect(() => retryDelayMs(1.5)).toThrow(RangeError);
  });

  it('cada nombre de URL es único y se traduce al tipo de tarea', () => {
    const slugs = Object.values(JOB_SPECS).map((spec) => spec.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(jobTypeFromSlug('mass-refund')).toBe('MASS_REFUND');
    expect(jobTypeFromSlug('nope')).toBeNull();
  });

  it('vercel.json programa exactamente las tareas que tienen manejador, con la frecuencia del calendario', () => {
    const { crons } = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as { crons: { path: string; schedule: string }[] };
    const scheduled = Object.fromEntries(crons.map((cron) => [cron.path.replace('/api/cron/', ''), cron.schedule]));
    const registered = Object.fromEntries(Object.keys(JOB_HANDLERS).map((type) => [JOB_SPECS[type as keyof typeof JOB_SPECS].slug, JOB_SPECS[type as keyof typeof JOB_SPECS].cron]));
    expect(scheduled).toEqual(registered);
  });

  it('con el plan gratuito de Vercel ninguna tarea corre más de una vez al día (si no, el despliegue falla)', () => {
    expect(VERCEL_PLAN).toBe('hobby');
    for (const spec of Object.values(JOB_SPECS)) {
      const [minute = '', hour = ''] = spec.cron.split(' ');
      // Minuto y hora fijos (números): una sola vez al día como máximo. `*`, `*/n`, rangos y listas correrían varias veces.
      expect(minute, `${spec.slug}: minuto`).toMatch(/^\d+$/);
      expect(hour, `${spec.slug}: hora`).toMatch(/^\d+$/);
    }
  });

  it('cada tarea guarda la frecuencia que usará en el plan Pro', () => {
    expect(JOB_SPECS.MASS_REFUND.proCron).toBe('*/10 * * * *');
    expect(JOB_SPECS.OUTBOX_DISPATCH.proCron).toBe('* * * * *');
    for (const spec of Object.values(JOB_SPECS)) expect(spec.proCron.split(' ')).toHaveLength(5);
  });
});

describe('vaciado de lotes en una ejecución', () => {
  const batch = (processed: number, hasMore: boolean, detail?: Record<string, number>): JobResult => (detail ? { processed, hasMore, detail } : { processed, hasMore });

  it('repite el manejador mientras queden registros y suma los recuentos', async () => {
    const results = [batch(25, true, { refunded: 20, failed: 5 }), batch(25, true, { refunded: 25 }), batch(7, false, { refunded: 7 })];
    const run = vi.fn(async () => results.shift() ?? batch(0, false));
    expect(await drainBatches(run, Date.now() + 240_000)).toEqual({ processed: 57, hasMore: false, detail: { refunded: 52, failed: 5 } });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('no repite si el último lote no avanzó, aunque diga que quedan más (reintentos con espera)', async () => {
    const run = vi.fn(async () => batch(0, true));
    expect(await drainBatches(run, Date.now() + 240_000)).toEqual({ processed: 0, hasMore: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('se detiene en el tope de lotes y avisa de que quedan más para la siguiente llamada', async () => {
    const run = vi.fn(async () => batch(1, true));
    expect(await drainBatches(run, Date.now() + 240_000)).toEqual({ processed: MAX_BATCHES_PER_EXECUTION, hasMore: true });
    expect(run).toHaveBeenCalledTimes(MAX_BATCHES_PER_EXECUTION);
  });

  it('no empieza otro lote si no queda margen de tiempo', async () => {
    let now = 0;
    const run = vi.fn(async () => {
      now += 120_000;
      return batch(5, true);
    });
    // Límite a 240 s con margen de 30 s: tras el primer lote (120 s) cabe otro; tras el segundo (240 s) ya no.
    expect(await drainBatches(run, 240_000, () => now)).toEqual({ processed: 10, hasMore: true });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('un fallo a mitad de vaciado se propaga para que la tarea se reintente', async () => {
    const results: (JobResult | Error)[] = [batch(3, true), new Error('Paycomet caído')];
    const run = vi.fn(async () => {
      const next = results.shift();
      if (next instanceof Error) throw next;
      return next ?? batch(0, false);
    });
    await expect(drainBatches(run, Date.now() + 240_000)).rejects.toThrow('Paycomet caído');
  });
});

describe('curso de los cupos', () => {
  it('el curso nuevo empieza el 22 de agosto, no antes', () => {
    expect(academicYearFor(new Date('2026-08-21T23:59:59Z'))).toBe('2025-2026');
    expect(academicYearFor(new Date('2026-08-22T00:00:00Z'))).toBe('2026-2027');
    expect(academicYearFor(new Date('2026-11-04T10:00:00Z'))).toBe('2026-2027');
    expect(academicYearFor(new Date('2027-01-02T10:00:00Z'))).toBe('2026-2027');
    expect(academicYearFor(new Date('2027-08-21T12:00:00Z'))).toBe('2026-2027');
  });

  it('solo avanza', () => {
    expect(isLaterAcademicYear('2027-2028', '2026-2027')).toBe(true);
    expect(isLaterAcademicYear('2026-2027', '2026-2027')).toBe(false);
    expect(isLaterAcademicYear('2025-2026', '2026-2027')).toBe(false);
    expect(isLaterAcademicYear('2026-2027', null)).toBe(true);
  });
});

describe('QA-OPS02 · conciliación de cobros', () => {
  const now = new Date('2026-11-04T12:00:00Z');
  const from = new Date(now.getTime() - 48 * 3_600_000);
  const old = new Date(now.getTime() - 5 * 3_600_000);
  const options = { now, from, graceMs: 3_600_000 };
  const psp = (order: string, amountCents: number, authCode: string | null = 'A1', occurredAt = old): PspCharge => ({ order, amountCents, authCode, occurredAt });
  const local = (order: string, totalChargedCents: number, authCode: string | null = 'A1', createdAt = old): LocalCharge => ({ contributionId: 1, organizationId: 'org', order, totalChargedCents, authCode, createdAt });

  it('si todo cuadra no hay diferencias', () => {
    expect(reconcileCharges([psp('O1', 2_500)], [local('O1', 2_500)], options)).toEqual([]);
  });

  it('detecta un cobro de Paycomet que KORUM no tiene', () => {
    expect(reconcileCharges([psp('O1', 2_500)], [], options)).toEqual([{ kind: 'MISSING_LOCALLY', order: 'O1', amountCents: 2_500 }]);
  });

  it('detecta un cobro de KORUM que Paycomet no conoce', () => {
    expect(reconcileCharges([], [local('O1', 2_500)], options)).toEqual([{ kind: 'MISSING_AT_PSP', order: 'O1', contributionId: 1, organizationId: 'org', amountCents: 2_500 }]);
  });

  it('detecta un importe distinto, con los dos importes', () => {
    expect(reconcileCharges([psp('O1', 2_600)], [local('O1', 2_500)], options)).toEqual([{ kind: 'AMOUNT_MISMATCH', order: 'O1', contributionId: 1, organizationId: 'org', pspCents: 2_600, localCents: 2_500 }]);
  });

  it('detecta un AuthCode distinto', () => {
    expect(reconcileCharges([psp('O1', 2_500, 'A2')], [local('O1', 2_500, 'A1')], options)).toEqual([{ kind: 'AUTHCODE_MISMATCH', order: 'O1', contributionId: 1, organizationId: 'org' }]);
    expect(reconcileCharges([psp('O1', 2_500, null)], [local('O1', 2_500, 'A1')], options)).toHaveLength(1);
  });

  it('ignora lo de la última hora (el aviso puede estar en camino) y lo anterior a la ventana', () => {
    const recent = new Date(now.getTime() - 10 * 60_000);
    expect(reconcileCharges([psp('O1', 2_500, 'A1', recent)], [], options)).toEqual([]);
    expect(reconcileCharges([], [local('O2', 2_500, 'A1', recent)], options)).toEqual([]);
    expect(reconcileCharges([], [local('O3', 2_500, 'A1', new Date(from.getTime() - 1))], options)).toEqual([]);
  });
});

describe('QA-OPS02 · ficheros: el tipo sale del contenido', () => {
  it('reconoce PDF, PNG, JPEG, WebP y texto plano por sus primeros bytes', () => {
    expect(detectFileType(PDF)).toBe('application/pdf');
    expect(detectFileType(PNG)).toBe('image/png');
    expect(detectFileType(JPEG)).toBe('image/jpeg');
    expect(detectFileType(WEBP)).toBe('image/webp');
    expect(detectFileType(new TextEncoder().encode('línea 1\r\nlínea 2\t'))).toBe('text/plain');
  });

  it('no reconoce binarios desconocidos, vacíos ni SVG como imagen', () => {
    expect(detectFileType(new Uint8Array())).toBeNull();
    expect(detectFileType(bytes(0, 1, 2, 3, 0xff, 0xfe))).toBeNull();
    expect(detectFileType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBe('text/plain');
    expect(FILE_RULES.ORG_LOGO.types).not.toContain('text/plain');
  });

  it('la extensión debe corresponder al tipo detectado', () => {
    expect(extensionMatches('factura.pdf', 'application/pdf')).toBe(true);
    expect(extensionMatches('foto.JPG', 'image/jpeg')).toBe(true);
    expect(extensionMatches('factura.pdf', 'image/png')).toBe(false);
    expect(extensionMatches('sin-extension', 'image/png')).toBe(true);
    expect(extensionMatches(undefined, 'image/png')).toBe(true);
  });

  it('los usos públicos solo admiten imágenes y los privados nunca van al cubo público', () => {
    for (const [purpose, rule] of Object.entries(FILE_RULES)) {
      if (rule.visibility === 'PUBLIC') expect(rule.types.every((type) => type.startsWith('image/')), purpose).toBe(true);
    }
    expect(FILE_RULES.KYB_DOCUMENT.visibility).toBe('PRIVATE');
    expect(FILE_RULES.PROVIDER_INVOICE.visibility).toBe('PRIVATE');
    expect(FILE_RULES.MODEL182_EXPORT.visibility).toBe('PRIVATE');
  });
});

describe('QA-OPS02 · subida de ficheros y URL firmadas', () => {
  const RETAIN_UNTIL = new Date('2033-01-01T00:00:00Z');

  function fakeDb(overrides: { create?: () => Promise<unknown>; find?: unknown } = {}) {
    const create = vi.fn(overrides.create ?? (async () => ({ id: 'file-1' })));
    const findUnique = vi.fn(async () => overrides.find ?? null);
    const audit = vi.fn(async () => ({}));
    return { db: { fileAsset: { create, findUnique }, auditLog: { create: audit } } as unknown as KorumPrismaClient, create, audit };
  }
  const auditedActions = (audit: ReturnType<typeof vi.fn>) => audit.mock.calls.map((call) => (call[0] as { data: { action: string } }).data.action);
  const upload = (db: KorumPrismaClient, storage: MemoryStorage, input: Partial<Parameters<typeof uploadFile>[2]> = {}) =>
    uploadFile(db as unknown as Db, storage, { purpose: 'KYB_DOCUMENT', bytes: PDF, declaredMimeType: 'application/pdf', fileName: 'estatutos.pdf', organizationId: 'org-1', uploadedById: 'user-1', retainUntil: RETAIN_UNTIL, ...input });

  it('un PDF de KYB va al cubo privado, con su huella y su tipo verificado', async () => {
    const storage = new MemoryStorage();
    const { db, create } = fakeDb();
    await upload(db, storage);
    expect(create).toHaveBeenCalledTimes(1);
    const data = (create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data).toMatchObject({ bucket: PRIVATE_BUCKET, visibility: 'PRIVATE', purpose: 'KYB_DOCUMENT', mimeType: 'application/pdf', sizeBytes: PDF.length, organizationId: 'org-1', retainUntil: RETAIN_UNTIL });
    expect(data.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(String(data.objectKey)).toMatch(/^org-1\/kyb_document\/[0-9a-f-]{36}\.pdf$/);
    expect(storage.has(PRIVATE_BUCKET, String(data.objectKey))).toBe(true);
  });

  it('un logo va al cubo público y no necesita fecha de conservación', async () => {
    const storage = new MemoryStorage();
    const { db, create } = fakeDb();
    await upload(db, storage, { purpose: 'ORG_LOGO', bytes: PNG, declaredMimeType: 'image/png', fileName: 'logo.png', retainUntil: undefined });
    expect((create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data).toMatchObject({ bucket: PUBLIC_BUCKET, visibility: 'PUBLIC', retainUntil: null });
  });

  it.each(['KYB_DOCUMENT', 'PROVIDER_INVOICE', 'KORUM_INVOICE_PDF', 'TAX_CERTIFICATE', 'MODEL182_EXPORT'] as const)('un documento legal (%s) sin fecha de conservación se rechaza: la purga no sabría su plazo', async (purpose) => {
    const storage = new MemoryStorage();
    const { db, create } = fakeDb();
    const isText = purpose === 'MODEL182_EXPORT';
    await expect(upload(db, storage, { purpose, bytes: isText ? new TextEncoder().encode('registro') : PDF, declaredMimeType: isText ? 'text/plain' : 'application/pdf', fileName: undefined, retainUntil: undefined })).rejects.toMatchObject({ reason: 'RETENTION_REQUIRED' });
    expect(create).not.toHaveBeenCalled();
    expect(storage.size).toBe(0);
  });

  it('todo uso con conservación obligatoria es privado y de lectura restringida a quienes firman', () => {
    for (const [purpose, rule] of Object.entries(FILE_RULES)) {
      if (rule.retentionRequired) {
        expect(rule.visibility, purpose).toBe('PRIVATE');
        expect([...rule.readRoles].sort(), purpose).toEqual(['COSIGNER', 'DIRECTOR']);
      }
    }
  });

  it.each([
    ['una imagen con extensión de PDF', { bytes: PNG, declaredMimeType: 'image/png', fileName: 'estatutos.pdf' }, 'EXTENSION_MISMATCH'],
    ['una imagen que se declara PDF', { bytes: PNG, declaredMimeType: 'application/pdf', fileName: 'estatutos.pdf' }, 'MIME_MISMATCH'],
    ['un PDF que se declara imagen', { bytes: PDF, declaredMimeType: 'image/png', fileName: 'x.png' }, 'MIME_MISMATCH'],
    ['texto que se hace pasar por PDF', { bytes: new TextEncoder().encode('hola'), declaredMimeType: 'application/pdf', fileName: 'x.pdf' }, 'TYPE_NOT_ALLOWED'],
    ['un binario desconocido', { bytes: bytes(0, 1, 2, 3), declaredMimeType: 'application/pdf', fileName: 'x.pdf' }, 'UNRECOGNIZED_TYPE'],
    ['un fichero vacío', { bytes: new Uint8Array(), declaredMimeType: 'application/pdf' }, 'EMPTY'],
    ['un fichero demasiado grande', { bytes: new Uint8Array(FILE_RULES.KYB_DOCUMENT.maxBytes + 1).fill(0x25), declaredMimeType: 'application/pdf' }, 'TOO_LARGE']
  ])('rechaza %s y no guarda nada', async (_name, input, reason) => {
    const storage = new MemoryStorage();
    const { db, create } = fakeDb();
    await expect(upload(db, storage, input)).rejects.toMatchObject({ name: 'FileRejectedError', reason });
    expect(create).not.toHaveBeenCalled();
    expect(storage.size).toBe(0);
  });

  it('un PNG no es válido como PDF de factura propia', async () => {
    const { db } = fakeDb();
    await expect(upload(db, new MemoryStorage(), { purpose: 'KORUM_INVOICE_PDF', bytes: PNG, declaredMimeType: 'image/png', fileName: 'f.png' })).rejects.toBeInstanceOf(FileRejectedError);
  });

  it('si falla el registro, no queda el objeto huérfano en el almacén', async () => {
    const storage = new MemoryStorage();
    const { db } = fakeDb({ create: async () => Promise.reject(new Error('base de datos caída')) });
    await expect(upload(db, storage)).rejects.toThrow('base de datos caída');
    expect(storage.size).toBe(0);
  });

  describe('getFileUrl · quién puede abrir un fichero', () => {
    const asset = (overrides: Record<string, unknown> = {}) => ({ id: 'file-1', bucket: PRIVATE_BUCKET, objectKey: 'org-1/kyb_document/a.pdf', visibility: 'PRIVATE', purpose: 'KYB_DOCUMENT', organizationId: 'org-1', deletedAt: null, ...overrides });
    const member = (organizationId: string, role: MemberRole): SessionActor => ({ kind: 'user', userId: `user-${role}`, isSuperadmin: false, memberships: [{ organizationId, role }] });
    const superadmin: SessionActor = { kind: 'user', userId: 'admin', isSuperadmin: true, memberships: [] };
    const anonymous: SessionActor = { kind: 'anonymous' };

    async function storageWith(current: () => Date = () => new Date()) {
      const storage = new MemoryStorage(current);
      await storage.put({ bucket: PRIVATE_BUCKET, objectKey: 'org-1/kyb_document/a.pdf', body: PDF, contentType: 'application/pdf' });
      return storage;
    }

    it('quien firma en la entidad recibe una URL firmada que caduca a los 5 minutos', async () => {
      let current = new Date('2026-11-04T10:00:00Z');
      const storage = await storageWith(() => current);
      const { db } = fakeDb({ find: asset() });
      const url = await getFileUrl(db, storage, member('org-1', 'DIRECTOR'), 'file-1');
      expect(url).toContain('/signed/');
      expect(storage.resolveSignedUrl(url)?.contentType).toBe('application/pdf');
      current = new Date(current.getTime() + 299_000);
      expect(storage.resolveSignedUrl(url)).not.toBeNull();
      current = new Date(current.getTime() + 2_000);
      expect(storage.resolveSignedUrl(url)).toBeNull();
    });

    it('la caducidad pedida nunca pasa de 15 minutos', async () => {
      let current = new Date('2026-11-04T10:00:00Z');
      const storage = await storageWith(() => current);
      const { db } = fakeDb({ find: asset() });
      const url = await getFileUrl(db, storage, member('org-1', 'COSIGNER'), 'file-1', { expiresInSeconds: 86_400 });
      current = new Date(current.getTime() + 901_000);
      expect(storage.resolveSignedUrl(url)).toBeNull();
    });

    it('un miembro sin rol de firma recibe 403 y queda en la auditoría', async () => {
      const { db, audit } = fakeDb({ find: asset() });
      await expect(getFileUrl(db, await storageWith(), member('org-1', 'FAMILY'), 'file-1')).rejects.toMatchObject({ name: 'TenantAccessError', reason: 'ROLE_NOT_ALLOWED' });
      expect(auditedActions(audit)).toEqual(['tenant.access_denied']);
    });

    it('quien no es de la entidad, o no ha iniciado sesión, recibe 404 como si no existiera, y se registra el intento', async () => {
      for (const actor of [member('org-2', 'DIRECTOR'), anonymous]) {
        const { db, audit } = fakeDb({ find: asset() });
        await expect(getFileUrl(db, await storageWith(), actor, 'file-1')).rejects.toBeInstanceOf(ResourceNotFoundError);
        expect(auditedActions(audit)).toEqual(['tenant.resource_outside_tenant']);
      }
    });

    it('un fichero privado sin entidad solo lo abre el Super-Admin; null no es una entidad más', async () => {
      const orphan = asset({ organizationId: null });
      const storage = await storageWith();
      for (const actor of [member('org-1', 'DIRECTOR'), anonymous]) {
        const { db, audit } = fakeDb({ find: orphan });
        await expect(getFileUrl(db, storage, actor, 'file-1')).rejects.toMatchObject({ name: 'TenantAccessError', reason: 'SUPERADMIN_ONLY' });
        expect(auditedActions(audit)).toEqual(['tenant.access_denied']);
      }
      const allowed = fakeDb({ find: orphan });
      expect(await getFileUrl(allowed.db, storage, superadmin, 'file-1')).toContain('/signed/');
      expect(auditedActions(allowed.audit)).toEqual(['superadmin.access']);
    });

    it('el Super-Admin abre los de cualquier entidad, con registro', async () => {
      const { db, audit } = fakeDb({ find: asset() });
      expect(await getFileUrl(db, await storageWith(), superadmin, 'file-1')).toContain('/signed/');
      expect(auditedActions(audit)).toEqual(['superadmin.access']);
    });

    it('un fichero borrado o inexistente responde 404 y queda registrado', async () => {
      for (const find of [asset({ deletedAt: new Date() }), null]) {
        const { db, audit } = fakeDb({ find });
        await expect(getFileUrl(db, await storageWith(), member('org-1', 'DIRECTOR'), 'file-1')).rejects.toBeInstanceOf(ResourceNotFoundError);
        expect(auditedActions(audit)).toEqual(['file.not_available']);
      }
    });

    it('una sesión de portería de otra entidad recibe el mismo 404 que si no existiera', async () => {
      const gate: SessionActor = { kind: 'gate', gateSessionId: 'g1', organizationId: 'org-2', initiativeId: 7 };
      const { db, audit } = fakeDb({ find: asset() });
      await expect(getFileUrl(db, await storageWith(), gate, 'file-1')).rejects.toBeInstanceOf(ResourceNotFoundError);
      expect(auditedActions(audit)).toEqual(['tenant.resource_outside_tenant']);
    });

    it('una sesión de portería de la propia entidad no abre documentos privados', async () => {
      const gate: SessionActor = { kind: 'gate', gateSessionId: 'g1', organizationId: 'org-1', initiativeId: 7 };
      const { db } = fakeDb({ find: asset() });
      await expect(getFileUrl(db, await storageWith(), gate, 'file-1')).rejects.toMatchObject({ name: 'TenantAccessError' });
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -50])('una duración pedida no válida (%s) nunca llega al almacén: se usa la de por defecto o el mínimo', async (expiresInSeconds) => {
      const current = new Date('2026-11-04T10:00:00Z');
      const storage = await storageWith(() => current);
      const { db } = fakeDb({ find: asset() });
      const url = await getFileUrl(db, storage, member('org-1', 'DIRECTOR'), 'file-1', { expiresInSeconds });
      expect(url).toContain('/signed/');
      expect(storage.resolveSignedUrl(url)).not.toBeNull();
    });

    it('un fichero público da su URL permanente a cualquiera, sin firmar', async () => {
      const pub = asset({ bucket: PUBLIC_BUCKET, objectKey: 'org-1/org_logo/a.png', visibility: 'PUBLIC', purpose: 'ORG_LOGO' });
      expect(await getFileUrl(fakeDb({ find: pub }).db, new MemoryStorage(), anonymous, 'f')).toBe(`memory://public/${PUBLIC_BUCKET}/org-1/org_logo/a.png`);
    });
  });
});

describe('adaptador de Supabase Storage', () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const respond = (body: unknown, status = 200) =>
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;

  afterEach(() => {
    calls.length = 0;
  });

  it('sube con la clave del servicio, sin pisar nada y con la ruta codificada', async () => {
    const storage = new SupabaseStorage('https://abc.supabase.co/', 'service-key', respond({ Key: 'ok' }));
    await storage.put({ bucket: PRIVATE_BUCKET, objectKey: 'org 1/kyb/a b.pdf', body: PDF, contentType: 'application/pdf' });
    expect(calls[0]?.url).toBe('https://abc.supabase.co/storage/v1/object/korum-private/org%201/kyb/a%20b.pdf');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers).toMatchObject({ Authorization: 'Bearer service-key', apikey: 'service-key', 'x-upsert': 'false', 'Content-Type': 'application/pdf' });
    expect(calls[0]?.init.redirect).toBe('error');
  });

  it('firma una URL y devuelve la dirección completa', async () => {
    const storage = new SupabaseStorage('https://abc.supabase.co', 'service-key', respond({ signedURL: '/object/sign/korum-private/o/k.pdf?token=abc' }));
    expect(await storage.createSignedUrl(PRIVATE_BUCKET, 'o/k.pdf', 300)).toBe('https://abc.supabase.co/storage/v1/object/sign/korum-private/o/k.pdf?token=abc');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ expiresIn: 300 });
  });

  it('rechaza respuestas de error o inesperadas', async () => {
    await expect(new SupabaseStorage('https://abc.supabase.co', 'k', respond({}, 500)).put({ bucket: 'b', objectKey: 'k', body: PDF, contentType: 'application/pdf' })).rejects.toMatchObject({ code: '500' });
    await expect(new SupabaseStorage('https://abc.supabase.co', 'k', respond({ signedURL: 'https://otro.example/x' })).createSignedUrl('b', 'k', 60)).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
    const offline = vi.fn(async () => Promise.reject(new TypeError('fallo de red'))) as unknown as typeof fetch;
    await expect(new SupabaseStorage('https://abc.supabase.co', 'k', offline).remove('b', 'k')).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('la URL del cubo público no lleva firma', () => {
    expect(new SupabaseStorage('https://abc.supabase.co', 'k').publicUrl(PUBLIC_BUCKET, 'o/logo.png')).toBe('https://abc.supabase.co/storage/v1/object/public/korum-public/o/logo.png');
  });
});

describe('adaptador de Paycomet: consulta de operaciones para la conciliación', () => {
  const credentials = { apiKey: 'key', merchantCode: 'M', terminal: '7', notificationPassword: 'p' };
  const operation = (overrides: Record<string, unknown> = {}) => ({ order: 'O1', amount: '2500', authCode: 'A1', timestamp: '20261104101500', state: 1, operationType: 1, ...overrides });

  function adapterReturning(body: unknown) {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    return { adapter: new PaycometAdapter('sandbox', credentials, fetchImpl), calls };
  }

  it('pide solo autorizaciones correctas de la ventana y devuelve céntimos y fechas UTC', async () => {
    const { adapter, calls } = adapterReturning({ errorCode: 0, operations: [operation(), operation({ order: 'O2', operationType: 2 }), operation({ order: 'O3', state: 0 })] });
    const result = await adapter.listCharges({ from: new Date('2026-11-02T10:00:00Z'), to: new Date('2026-11-04T10:00:00Z') });
    expect(calls[0]?.url).toBe('https://rest.paycomet.com/v1/payments/search');
    expect(calls[0]?.body).toMatchObject({ terminal: 7, operations: [1], state: 1, currency: 'EUR', fromDate: '20261102100000', toDate: '20261104100000' });
    expect(result).toEqual([{ order: 'O1', amountCents: 2_500, authCode: 'A1', occurredAt: new Date('2026-11-04T10:15:00Z') }]);
  });

  it('falla si la lista puede estar recortada, en lugar de conciliar con datos incompletos', async () => {
    const { adapter } = adapterReturning({ errorCode: 0, operations: Array.from({ length: 10_000 }, (_, index) => operation({ order: `O${index}` })) });
    await expect(adapter.listCharges({ from: new Date(0), to: new Date() })).rejects.toMatchObject({ code: 'SEARCH_TRUNCATED' });
  });

  it('una respuesta que no se entiende falla como resultado desconocido', async () => {
    const { adapter } = adapterReturning({ errorCode: 0, operations: [{ order: 'O1' }] });
    await expect(adapter.listCharges({ from: new Date(0), to: new Date() })).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });
});

describe('observabilidad: Sentry sin datos personales', () => {
  it('limpia emails, NIF, IBAN, tarjetas, IP y tokens dentro de los textos', () => {
    const text = 'Fallo con ana.garcia@correo.es, NIF 12345678Z, IBAN ES9121000418450200051332, tarjeta 4111 1111 1111 1111, IP 192.168.1.20 y token aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5hJ7k';
    const clean = redactText(text);
    for (const secret of ['ana.garcia', '12345678Z', 'ES9121000418450200051332', '4111 1111', '192.168.1.20', 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5hJ7k']) expect(clean).not.toContain(secret);
    expect(clean).toContain('Fallo con');
  });

  it.each([
    ['NIF con guion', 'NIF 12345678-Z del donante', '12345678-Z'],
    ['NIF con espacio', 'NIF 12345678 Z del donante', '12345678 Z'],
    ['IPv6 comprimida', 'desde 2a02:9130:84a0::1 hoy', '2a02:9130:84a0::1'],
    ['IPv6 comprimida corta', 'desde 2001:db8::1 hoy', '2001:db8::1'],
    ['IPv6 completa', 'desde 2001:0db8:85a3:0000:0000:8a2e:0370:7334 hoy', '2001:0db8:85a3'],
    ['teléfono con prefijo y espacios', 'llamar al +34 612 34 56 78 ya', '612 34 56 78'],
    ['teléfono seguido', 'llamar al 612345678 ya', '612345678'],
    ['teléfono español en grupos de tres', 'llamar al 612 345 678 ya', '612 345 678'],
    ['teléfono español con guiones', 'llamar al 612-34-56-78 ya', '612-34-56-78'],
    ['teléfono fijo con espacios', 'llamar al 912 34 56 78 ya', '912 34 56 78'],
    ['JWT con tramos cortos', 'token eyJhbGciOi.eyJzdWIiOjE.c2lnbmF0dXJl fin', 'eyJhbGciOi']
  ])('limpia %s', (_name, text, secret) => {
    expect(redactText(text)).not.toContain(secret);
  });

  it('un texto enorme no bloquea el servidor: se recorta antes de limpiarlo y cualquier entrada adversaria termina en milisegundos', () => {
    const adversarial = ['a'.repeat(1_000_000), 'a.'.repeat(500_000), 'a-'.repeat(500_000), '1.'.repeat(500_000), '1 '.repeat(500_000), 'a'.repeat(1_000) + '@' + 'b.'.repeat(500_000), 'f:'.repeat(500_000), 'eyJ' + 'a'.repeat(1_000_000)];
    for (const text of adversarial) {
      const started = performance.now();
      const clean = redactText(text);
      expect(performance.now() - started).toBeLessThan(250);
      expect(clean.length).toBeLessThan(20_000);
    }
  });

  it('el evento sale sin petición, usuario, migas de pan, transacción ni datos extra', () => {
    const event = scrubEvent({
      type: undefined,
      message: 'Error al enviar a luis@correo.es',
      transaction: 'GET /firmar/aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5hJ7k',
      fingerprint: ['{{ default }}', 'fallo-de-luis@correo.es'],
      request: { url: 'https://korum.example/acceso?token=secreto', headers: { cookie: 'sesion=abc' }, data: { email: 'luis@correo.es' } },
      user: { email: 'luis@correo.es', ip_address: '10.0.0.2' },
      breadcrumbs: [{ message: 'clic en luis@correo.es' }],
      extra: { nif: '12345678Z' },
      contexts: { device: { name: 'portátil de Luis' } },
      server_name: 'mi-servidor',
      exception: { values: [{ type: 'Error', value: 'Fallo para 12345678Z', stacktrace: { frames: [{ function: 'enviar', filename: 'app.js', vars: { destinatario: 'luis@correo.es' } }] } }] },
      tags: { route: '/panel/[orgSlug]', owner: 'luis@correo.es' }
    });
    expect(event.request).toBeUndefined();
    expect(event.user).toBeUndefined();
    expect(event.breadcrumbs).toBeUndefined();
    expect(event.extra).toBeUndefined();
    expect(event.contexts).toBeUndefined();
    expect(event.server_name).toBeUndefined();
    expect(event.transaction).toBeUndefined();
    expect(event.exception?.values?.[0]?.stacktrace?.frames?.[0]).toEqual({ function: 'enviar', filename: 'app.js' });
    expect(JSON.stringify(event)).not.toMatch(/luis@|12345678Z|secreto|sesion=abc|aB3dE5gH7jK9/);
    expect(event.tags).toMatchObject({ route: '/panel/[orgSlug]' });
    expect(event.fingerprint).toEqual(['{{ default }}', '[redactado]']);
  });
});

describe('QA-OPS01 · la ruta de tareas exige CRON_SECRET', () => {
  const secret = randomBytes(32).toString('base64');
  const call = (headers: Record<string, string> = {}, job = 'mass-refund') => GET(new Request(`https://korum.example/api/cron/${job}`, { headers }), { params: Promise.resolve({ job }) });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sin CRON_SECRET en el servidor responde 401 aunque se envíe una cabecera', async () => {
    vi.stubEnv('CRON_SECRET', '');
    expect((await call({ authorization: 'Bearer ' })).status).toBe(401);
    expect((await call({ authorization: 'Bearer undefined' })).status).toBe(401);
  });

  it('sin cabecera, con otro secreto o sin el prefijo Bearer responde 401', async () => {
    vi.stubEnv('CRON_SECRET', secret);
    expect((await call()).status).toBe(401);
    expect((await call({ authorization: `Bearer ${randomBytes(32).toString('base64')}` })).status).toBe(401);
    expect((await call({ authorization: secret })).status).toBe(401);
    expect((await call({ authorization: `bearer ${secret}` })).status).toBe(401);
  });

  it('un secreto corto en el servidor nunca autoriza', async () => {
    vi.stubEnv('CRON_SECRET', 'corto');
    expect((await call({ authorization: 'Bearer corto' })).status).toBe(401);
  });

  it('con el secreto correcto, una tarea desconocida responde 404', async () => {
    vi.stubEnv('CRON_SECRET', secret);
    const headers = { authorization: `Bearer ${secret}` };
    expect((await call(headers, 'no-existe')).status).toBe(404);
  });
});

describe('QA-OPS02 · conciliación con mucho volumen', () => {
  const HOUR = 3_600_000;
  const charge = (order: string, at: Date): PspCharge => ({ order, amountCents: 100, authCode: 'A', occurredAt: at });

  /** Paycomet que se niega a dar más de `limit` horas de golpe (como si el rango superara su tope de resultados). */
  function limitedProvider(limitHours: number, all: PspCharge[]) {
    const ranges: number[] = [];
    const provider = {
      listCharges: async ({ from, to }: { from: Date; to: Date }) => {
        const span = to.getTime() - from.getTime();
        ranges.push(span);
        if (span > limitHours * HOUR) throw new PaymentProviderError('Límite alcanzado', 'SEARCH_TRUNCATED');
        return all.filter((entry) => entry.occurredAt >= from && entry.occurredAt <= to);
      }
    } as unknown as PaymentProvider;
    return { provider, ranges };
  }

  it('si la consulta alcanza el máximo de resultados, parte el rango y reúne todos los cobros sin duplicarlos', async () => {
    const from = new Date('2026-11-01T00:00:00Z');
    const to = new Date('2026-11-03T00:00:00Z');
    const all = Array.from({ length: 48 }, (_, hour) => charge(`O${hour}`, new Date(from.getTime() + hour * HOUR + 1_000)));
    const { provider, ranges } = limitedProvider(6, all);
    const result = await listChargesInChunks(provider, from, to);
    expect(result.map((entry) => entry.order).sort()).toEqual(all.map((entry) => entry.order).sort());
    expect(ranges.length).toBeGreaterThan(1);
  });

  it('no parte sin fin: un tramo mínimo que sigue truncado falla en vez de conciliar con datos recortados', async () => {
    const { provider } = limitedProvider(0, []);
    await expect(listChargesInChunks(provider, new Date('2026-11-01T00:00:00Z'), new Date('2026-11-01T00:30:00Z'))).rejects.toMatchObject({ code: 'SEARCH_TRUNCATED' });
  });

  it('otros errores del proveedor se propagan tal cual, sin partir el rango', async () => {
    const provider = { listCharges: vi.fn(async () => Promise.reject(new PaymentProviderError('Paycomet caído', 'NETWORK', true))) } as unknown as PaymentProvider;
    await expect(listChargesInChunks(provider, new Date(0), new Date(10 * HOUR))).rejects.toMatchObject({ code: 'NETWORK' });
    expect(provider.listCharges).toHaveBeenCalledTimes(1);
  });
});
