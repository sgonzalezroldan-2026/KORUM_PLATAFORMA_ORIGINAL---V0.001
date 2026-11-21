import { clearFingerprintsOf } from '@/core/security/device-quorum.service';
import type { ConsentPurpose, Locale } from '@/generated/prisma/enums';
import { inTransaction, type Db } from '@/lib/db';

/**
 * Consentimientos (RGPD art. 7, QA-PRIV02). Cada cambio es una fila nueva de `ConsentRecord` —nunca se edita la anterior—, así queda la
 * prueba de qué aceptó la persona, cuándo, desde dónde y con qué versión de la política. Retirarlo cuesta lo mismo que darlo (una llamada)
 * y se aplica **en ese momento**: retirar la huella del dispositivo la borra de todos sus dispositivos en la misma transacción, sin
 * esperar a que vuelva a firmar una idea (deuda del Sprint 2.2).
 */

export const CONSENT_PURPOSES = ['ANALYTICS_COOKIES', 'DEVICE_FINGERPRINT', 'MARKETING_EMAILS', 'PUBLIC_SUPPORTER_NAME'] as const satisfies readonly ConsentPurpose[];

export const CONSENT_SOURCES = ['banner', 'checkout', 'ajustes', 'buzon', 'cuenta'] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

const POLICY_VERSION = /^\d{4}-\d{2}-\d{2}(\.\d+)?$/;

export class ConsentInputError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'ConsentInputError';
  }
}

export interface ConsentChange {
  userId: string;
  purpose: ConsentPurpose;
  granted: boolean;
  /**
   * Versión e idioma de la política de privacidad publicada que la persona tenía delante (`policyForUser`, Sprint 5.10a). Para **dar** un consentimiento son
   * obligatorios y tienen que estar en el archivo de textos legales. Para **retirarlo** pueden faltar (aún no hay ninguna publicada): se guarda con la versión y
   * el idioma con los que se dio y, si nunca se dio, no se escribe nada, pero sus efectos se aplican igual.
   */
  policyVersion: string | null;
  policyLocale?: Locale | null;
  source: ConsentSource;
  deviceId?: string | null;
}

/** Registra un consentimiento dado o retirado y aplica sus efectos. Repetir el mismo estado no crea filas nuevas. */
export async function recordConsent(db: Db, change: ConsentChange, now: Date = new Date()): Promise<{ changed: boolean }> {
  if (!CONSENT_PURPOSES.includes(change.purpose)) throw new ConsentInputError('Finalidad de consentimiento desconocida');
  if (change.policyVersion !== null && !POLICY_VERSION.test(change.policyVersion)) throw new ConsentInputError('La versión de la política debe ser una fecha AAAA-MM-DD');
  if (change.granted && (change.policyVersion === null || !change.policyLocale)) throw new ConsentInputError('No hay ninguna política de privacidad publicada');
  if (change.policyVersion !== null && !change.policyLocale) throw new ConsentInputError('Falta el idioma de la política de privacidad');
  if (!CONSENT_SOURCES.includes(change.source)) throw new ConsentInputError('Origen de consentimiento desconocido');
  return inTransaction(db, async (tx) => {
    // Bloquea a la persona: dos cambios a la vez no pueden dejar un estado distinto del último que se pidió.
    const user = await tx.user.update({ where: { id: change.userId }, data: { updatedAt: now }, select: { gdprAnonymizedAt: true } });
    if (user.gdprAnonymizedAt) throw new ConsentInputError('La cuenta está suprimida');
    // Nunca se registra un consentimiento, dado o retirado, con una versión de la política que no esté publicada (Sprint 5.10a, `QA-LEG01`).
    if (change.policyVersion !== null && change.policyLocale && (await tx.legalDocumentVersion.count({ where: { document: 'privacidad', locale: change.policyLocale, version: change.policyVersion } })) === 0) throw new ConsentInputError('Esa versión de la política de privacidad no está publicada');
    const latest = await tx.consentRecord.findFirst({ where: { userId: change.userId, purpose: change.purpose }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { granted: true, policyVersion: true, policyLocale: true } });
    const policyVersion = change.policyVersion ?? latest?.policyVersion ?? null;
    const policyLocale = change.policyVersion !== null ? (change.policyLocale ?? null) : (latest?.policyLocale ?? null);
    const unchanged = policyVersion === null || (latest !== null && latest.granted === change.granted && latest.policyVersion === policyVersion && latest.policyLocale === policyLocale);
    if (!unchanged) {
      await tx.consentRecord.create({
        data: { userId: change.userId, deviceId: change.deviceId ?? null, purpose: change.purpose, granted: change.granted, policyVersion, policyLocale, source: change.source, createdAt: now }
      });
    }
    // También si ya estaba retirado: garantiza que no queda ninguna huella aunque una versión anterior del código la hubiera dejado.
    if (change.purpose === 'DEVICE_FINGERPRINT' && !change.granted) await clearFingerprintsOf(tx, change.userId);
    return { changed: !unchanged };
  });
}

export interface ConsentState {
  purpose: ConsentPurpose;
  granted: boolean;
  policyVersion: string | null;
  updatedAt: Date | null;
}

/** Estado actual de cada finalidad. Sin registro, no hay consentimiento (`granted: false`): nunca se presume. */
export async function currentConsents(db: Db, userId: string): Promise<ConsentState[]> {
  const rows = await db.consentRecord.findMany({ where: { userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { purpose: true, granted: true, policyVersion: true, createdAt: true } });
  return CONSENT_PURPOSES.map((purpose) => {
    const latest = rows.find((row) => row.purpose === purpose);
    return { purpose, granted: latest?.granted ?? false, policyVersion: latest?.policyVersion ?? null, updatedAt: latest?.createdAt ?? null };
  });
}
