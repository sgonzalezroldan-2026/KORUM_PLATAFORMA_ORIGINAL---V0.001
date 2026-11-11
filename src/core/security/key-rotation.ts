import { raiseAlert } from '@/core/jobs/ops-alerts';
import type { Db } from '@/lib/db';
import { CRYPTO_CONTEXT, DecryptionError, openParts, openValue, sealParts, sealValue, type Keyring } from './crypto';

/**
 * Rotación de la clave de cifrado (DECISIONES_TECNICAS §5). Procedimiento: (1) se genera una clave nueva; (2) se despliega con
 * `ENCRYPTION_KEY` = nueva, `ENCRYPTION_KEY_VERSION` + 1 y la anterior en `ENCRYPTION_PREVIOUS_KEYS`; (3) `OPS_HOUSEKEEPING` llama cada día
 * a `rotateEncryptedData`, que descifra con la anterior y vuelve a cifrar con la actual **con el mismo contexto**; (4) cuando
 * `countPendingRotation` llega a 0, se retira la clave anterior. Un valor que ninguna clave descifra abre la alerta `ENCRYPTION_KEY_MISSING`
 * y se salta, sin parar el resto.
 *
 * Cubre todo lo cifrado: secretos de la consola, tarjetas, NIF de donantes y de cuentas, NIF de destinatarios de factura y de comercios.
 * `QR_HMAC_SECRET` no se rota así: es una firma, no un cifrado, y cambiarlo invalida los pases ya emitidos (ver la skill de taquilla).
 */

type PlatformSecretRow = { key: string; ciphertext: string; iv: string; authTag: string; keyVersion: number };

/**
 * Vuelve a cifrar un secreto de la consola ya leído. Solo escribe si nadie lo ha cambiado desde la lectura: si el Super-Admin acaba de
 * guardar otro valor (`updateSecret`), se respeta el suyo y devuelve `false`.
 */
export async function reencryptPlatformSecret(db: Db, keyring: Keyring, row: PlatformSecretRow): Promise<boolean> {
  const context = CRYPTO_CONTEXT.platformSecret(row.key);
  const sealed = sealParts(keyring, openParts(keyring, row, context), context);
  const { count } = await db.platformSecret.updateMany({ where: { key: row.key, keyVersion: row.keyVersion, ciphertext: row.ciphertext }, data: { ciphertext: sealed.ciphertext, iv: sealed.iv, authTag: sealed.authTag, keyVersion: sealed.keyVersion } });
  return count === 1;
}

interface RotationTable {
  name: string;
  /** Filas pendientes con `id` mayor que el cursor, en orden. */
  pending(db: Db, keyring: Keyring, afterId: string | number | null, limit: number): Promise<Array<{ id: string | number }>>;
  count(db: Db, keyring: Keyring): Promise<number>;
  /** Vuelve a cifrar una fila. Lanza `DecryptionError` si no se puede descifrar. */
  rotate(db: Db, keyring: Keyring, id: string | number): Promise<void>;
}

/** Versión distinta de la actual, o sin versión (valores anteriores a guardarla): en SQL, `<>` no incluye los nulos. */
const staleVersion = <K extends string>(field: K, keyring: Keyring) => ({ OR: [{ [field]: { not: keyring.currentVersion } }, { [field]: null }] }) as { OR: Array<Record<K, { not: number } | null>> };

const TABLES: RotationTable[] = [
  {
    name: 'PlatformSecret',
    pending: (db, keyring, afterId, take) => db.platformSecret.findMany({ where: { keyVersion: { not: keyring.currentVersion }, ...(afterId === null ? {} : { key: { gt: String(afterId) } }) }, orderBy: { key: 'asc' }, take, select: { key: true } }).then((rows) => rows.map((row) => ({ id: row.key }))),
    count: (db, keyring) => db.platformSecret.count({ where: { keyVersion: { not: keyring.currentVersion } } }),
    rotate: async (db, keyring, id) => {
      await reencryptPlatformSecret(db, keyring, await db.platformSecret.findUniqueOrThrow({ where: { key: String(id) } }));
    }
  },
  {
    name: 'PaymentMethodToken',
    pending: (db, keyring, afterId, take) => db.paymentMethodToken.findMany({ where: { keyVersion: { not: keyring.currentVersion }, NOT: { idUserEnc: '' }, id: { gt: Number(afterId ?? 0) } }, orderBy: { id: 'asc' }, take, select: { id: true } }),
    count: (db, keyring) => db.paymentMethodToken.count({ where: { keyVersion: { not: keyring.currentVersion }, NOT: { idUserEnc: '' } } }),
    rotate: async (db, keyring, id) => {
      const row = await db.paymentMethodToken.findUniqueOrThrow({ where: { id: Number(id) } });
      const idUser = sealValue(keyring, openValue(keyring, row.idUserEnc, row.keyVersion, CRYPTO_CONTEXT.cardIdUser(row.id)), CRYPTO_CONTEXT.cardIdUser(row.id));
      const tokenUser = sealValue(keyring, openValue(keyring, row.tokenUserEnc, row.keyVersion, CRYPTO_CONTEXT.cardTokenUser(row.id)), CRYPTO_CONTEXT.cardTokenUser(row.id));
      // Si en medio se borró en Paycomet (tokens vaciados), no se vuelven a escribir.
      await db.paymentMethodToken.updateMany({ where: { id: row.id, keyVersion: row.keyVersion, idUserEnc: row.idUserEnc, providerDeletedAt: null }, data: { idUserEnc: idUser.sealed, tokenUserEnc: tokenUser.sealed, keyVersion: idUser.keyVersion } });
    }
  },
  {
    name: 'Contribution',
    pending: (db, keyring, afterId, take) => db.contribution.findMany({ where: { donorTaxIdEnc: { not: null }, ...staleVersion('donorTaxIdKeyVersion', keyring), id: { gt: Number(afterId ?? 0) } }, orderBy: { id: 'asc' }, take, select: { id: true } }),
    count: (db, keyring) => db.contribution.count({ where: { donorTaxIdEnc: { not: null }, ...staleVersion('donorTaxIdKeyVersion', keyring) } }),
    rotate: async (db, keyring, id) => {
      const row = await db.contribution.findUniqueOrThrow({ where: { id: Number(id) }, select: { id: true, donorTaxIdEnc: true, donorTaxIdKeyVersion: true } });
      if (!row.donorTaxIdEnc) return;
      const sealed = sealValue(keyring, openValue(keyring, row.donorTaxIdEnc, row.donorTaxIdKeyVersion, CRYPTO_CONTEXT.donorTaxId), CRYPTO_CONTEXT.donorTaxId);
      await db.contribution.updateMany({ where: { id: row.id, donorTaxIdEnc: row.donorTaxIdEnc }, data: { donorTaxIdEnc: sealed.sealed, donorTaxIdKeyVersion: sealed.keyVersion } });
    }
  },
  {
    name: 'User',
    pending: (db, keyring, afterId, take) => db.user.findMany({ where: { nifEnc: { not: null }, ...staleVersion('nifKeyVersion', keyring), ...(afterId === null ? {} : { id: { gt: String(afterId) } }) }, orderBy: { id: 'asc' }, take, select: { id: true } }),
    count: (db, keyring) => db.user.count({ where: { nifEnc: { not: null }, ...staleVersion('nifKeyVersion', keyring) } }),
    rotate: async (db, keyring, id) => {
      const row = await db.user.findUniqueOrThrow({ where: { id: String(id) }, select: { id: true, nifEnc: true, nifKeyVersion: true } });
      if (!row.nifEnc) return;
      const context = CRYPTO_CONTEXT.userTaxId(row.id);
      const sealed = sealValue(keyring, openValue(keyring, row.nifEnc, row.nifKeyVersion, context), context);
      await db.user.updateMany({ where: { id: row.id, nifEnc: row.nifEnc }, data: { nifEnc: sealed.sealed, nifKeyVersion: sealed.keyVersion } });
    }
  },
  {
    name: 'Invoice',
    pending: (db, keyring, afterId, take) => db.invoice.findMany({ where: { recipientTaxIdEnc: { not: null }, ...staleVersion('recipientTaxIdKeyVersion', keyring), id: { gt: Number(afterId ?? 0) } }, orderBy: { id: 'asc' }, take, select: { id: true } }),
    count: (db, keyring) => db.invoice.count({ where: { recipientTaxIdEnc: { not: null }, ...staleVersion('recipientTaxIdKeyVersion', keyring) } }),
    rotate: async (db, keyring, id) => {
      const row = await db.invoice.findUniqueOrThrow({ where: { id: Number(id) }, select: { id: true, invoiceNumber: true, recipientTaxIdEnc: true, recipientTaxIdKeyVersion: true } });
      if (!row.recipientTaxIdEnc) return;
      const context = CRYPTO_CONTEXT.invoiceRecipientTaxId(row.invoiceNumber);
      const sealed = sealValue(keyring, openValue(keyring, row.recipientTaxIdEnc, row.recipientTaxIdKeyVersion, context), context);
      await db.invoice.updateMany({ where: { id: row.id, recipientTaxIdEnc: row.recipientTaxIdEnc }, data: { recipientTaxIdEnc: sealed.sealed, recipientTaxIdKeyVersion: sealed.keyVersion } });
    }
  },
  {
    name: 'Sponsor',
    pending: (db, keyring, afterId, take) => db.sponsor.findMany({ where: { cifEnc: { not: null }, ...staleVersion('cifKeyVersion', keyring), id: { gt: Number(afterId ?? 0) } }, orderBy: { id: 'asc' }, take, select: { id: true } }),
    count: (db, keyring) => db.sponsor.count({ where: { cifEnc: { not: null }, ...staleVersion('cifKeyVersion', keyring) } }),
    rotate: async (db, keyring, id) => {
      const row = await db.sponsor.findUniqueOrThrow({ where: { id: Number(id) }, select: { id: true, organizationId: true, cifEnc: true, cifKeyVersion: true } });
      if (!row.cifEnc) return;
      const context = CRYPTO_CONTEXT.sponsorTaxId(row.organizationId);
      const sealed = sealValue(keyring, openValue(keyring, row.cifEnc, row.cifKeyVersion, context), context);
      await db.sponsor.updateMany({ where: { id: row.id, cifEnc: row.cifEnc }, data: { cifEnc: sealed.sealed, cifKeyVersion: sealed.keyVersion } });
    }
  },
  {
    // IBAN y CIF del proveedor de una liquidación (Sprint 4.4a): se cifran juntos y comparten versión. Su huella (`beneficiaryDigest`) no cambia.
    name: 'EscrowPayout',
    pending: (db, keyring, afterId, take) => db.escrowPayout.findMany({ where: { beneficiaryIbanEnc: { not: null }, ...staleVersion('beneficiaryKeyVersion', keyring), id: { gt: Number(afterId ?? 0) } }, orderBy: { id: 'asc' }, take, select: { id: true } }),
    count: (db, keyring) => db.escrowPayout.count({ where: { beneficiaryIbanEnc: { not: null }, ...staleVersion('beneficiaryKeyVersion', keyring) } }),
    rotate: async (db, keyring, id) => {
      const row = await db.escrowPayout.findUniqueOrThrow({ where: { id: Number(id) }, select: { id: true, initiativeId: true, beneficiaryIbanEnc: true, providerCifEnc: true, beneficiaryKeyVersion: true } });
      if (!row.beneficiaryIbanEnc || !row.providerCifEnc) return;
      const ibanContext = CRYPTO_CONTEXT.payoutIban(row.initiativeId);
      const taxContext = CRYPTO_CONTEXT.payoutTaxId(row.initiativeId);
      const iban = sealValue(keyring, openValue(keyring, row.beneficiaryIbanEnc, row.beneficiaryKeyVersion, ibanContext), ibanContext);
      const taxId = sealValue(keyring, openValue(keyring, row.providerCifEnc, row.beneficiaryKeyVersion, taxContext), taxContext);
      await db.escrowPayout.updateMany({ where: { id: row.id, beneficiaryIbanEnc: row.beneficiaryIbanEnc }, data: { beneficiaryIbanEnc: iban.sealed, providerCifEnc: taxId.sealed, beneficiaryKeyVersion: iban.keyVersion } });
    }
  }
];

export interface RotationResult {
  rotated: number;
  /** Valores que ninguna clave del llavero descifra: alerta abierta, siguen cifrados como estaban. */
  undecryptable: number;
  hasMore: boolean;
}

const MAX_ROUNDS = 20;

export async function rotateEncryptedData(db: Db, keyring: Keyring, limit: number, now: Date = new Date()): Promise<RotationResult> {
  const result: RotationResult = { rotated: 0, undecryptable: 0, hasMore: false };
  for (const table of TABLES) {
    let cursor: string | number | null = null;
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const rows = await table.pending(db, keyring, cursor, limit);
      for (const row of rows) {
        try {
          await table.rotate(db, keyring, row.id);
          result.rotated += 1;
        } catch (error) {
          if (!(error instanceof DecryptionError)) throw error;
          result.undecryptable += 1;
          // Una alerta por tabla (no una por fila): cada repetición suma una ocurrencia y guarda la última fila afectada.
          await raiseAlert(db, { type: 'ENCRYPTION_KEY_MISSING', severity: 'CRITICAL', dedupeKey: `key-missing:${table.name}`, targetType: table.name, targetId: String(row.id), detail: { table: table.name, lastId: String(row.id), currentVersion: keyring.currentVersion } }, now);
        }
      }
      if (rows.length < limit) break;
      cursor = rows[rows.length - 1]!.id;
      if (round === MAX_ROUNDS - 1) result.hasMore = true;
    }
  }
  return result;
}

/** Valores pendientes de volver a cifrar con la clave actual, por tabla. Con todo a 0 se puede retirar la clave anterior. */
export async function countPendingRotation(db: Db, keyring: Keyring): Promise<Record<string, number>> {
  const counts = await Promise.all(TABLES.map(async (table) => [table.name, await table.count(db, keyring)] as const));
  return Object.fromEntries(counts);
}
