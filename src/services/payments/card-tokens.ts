import { CRYPTO_CONTEXT, DecryptionError, openValue, sealValue, type Keyring } from '@/core/security/crypto';
import { inTransaction, type Db } from '@/lib/db';
import { PaymentProviderError, type PaymentProvider } from './payment-provider';

/**
 * Tarjetas tokenizadas (JET-ID) para Mi Hucha y la renovación de comercios. KORUM nunca recibe el número de la tarjeta: el formulario de
 * Paycomet entrega un token de un solo uso, que se cambia por `idUser` + `tokenUser`. Esos dos valores se guardan cifrados **con el
 * identificador de su fila en el contexto**: copiados a la tarjeta de otra persona, no se pueden descifrar.
 */

/** La fila se crea vacía y se rellena en la misma transacción, porque el contexto de cifrado necesita su identificador. */
export async function tokenizeAndStoreCard(
  db: Db,
  provider: PaymentProvider,
  input: { jetToken: string; userId: string | null; brand?: string; last4?: string; expiresMonth?: number; expiresYear?: number },
  keyring: Keyring
): Promise<{ paymentMethodTokenId: number }> {
  const { idUser, tokenUser } = await provider.tokenizeCard({ jetToken: input.jetToken });
  return inTransaction(db, async (tx) => {
    const row = await tx.paymentMethodToken.create({
      data: {
        userId: input.userId,
        provider: provider.name,
        idUserEnc: '',
        tokenUserEnc: '',
        keyVersion: keyring.currentVersion,
        brand: input.brand ?? null,
        last4: input.last4 ?? null,
        expiresMonth: input.expiresMonth ?? null,
        expiresYear: input.expiresYear ?? null
      },
      select: { id: true }
    });
    const idUserSealed = sealValue(keyring, String(idUser), CRYPTO_CONTEXT.cardIdUser(row.id));
    const tokenUserSealed = sealValue(keyring, tokenUser, CRYPTO_CONTEXT.cardTokenUser(row.id));
    await tx.paymentMethodToken.update({ where: { id: row.id }, data: { idUserEnc: idUserSealed.sealed, tokenUserEnc: tokenUserSealed.sealed, keyVersion: idUserSealed.keyVersion } });
    return { paymentMethodTokenId: row.id };
  });
}

function openCard(keyring: Keyring, row: { id: number; idUserEnc: string; tokenUserEnc: string; keyVersion: number }): { idUser: number; tokenUser: string } {
  return {
    idUser: Number(openValue(keyring, row.idUserEnc, row.keyVersion, CRYPTO_CONTEXT.cardIdUser(row.id))),
    tokenUser: openValue(keyring, row.tokenUserEnc, row.keyVersion, CRYPTO_CONTEXT.cardTokenUser(row.id))
  };
}

/** Devuelve el token para cobrar, solo a su propietario: una familia o un comercio. Un token revocado no se puede usar. */
export async function loadCardToken(db: Db, paymentMethodTokenId: number, owner: { userId: string } | { sponsorId: number }, keyring: Keyring): Promise<{ idUser: number; tokenUser: string }> {
  // Con un valor vacío, Prisma ignoraría el filtro y devolvería la tarjeta de cualquiera.
  if ('userId' in owner ? !owner.userId : !owner.sponsorId) throw new RangeError('Hace falta el propietario de la tarjeta');
  const row = await db.paymentMethodToken.findFirstOrThrow({ where: { id: paymentMethodTokenId, ...('userId' in owner ? { userId: owner.userId } : { sponsors: { some: { id: owner.sponsorId } } }) } });
  if (row.revokedAt) throw new RangeError(`La tarjeta ${paymentMethodTokenId} está revocada`);
  return openCard(keyring, row);
}

/** `UNREADABLE`: ninguna clave descifra el token (no se puede pedir el borrado); sigue revocada y quien llama abre una alerta. */
export type CardDeletionOutcome = 'DELETED' | 'FAILED' | 'UNREADABLE';

/**
 * Supresión de una cuenta: cada tarjeta guardada se revoca al momento y se pide a Paycomet que la borre. Si Paycomet no lo confirma, la
 * tarjeta sigue revocada (ya no se puede cobrar con ella) y se conserva su token cifrado **solo** para volver a pedir el borrado; la purga
 * semanal lo reintenta. Cuando Paycomet confirma, el token se vacía.
 */
export async function deleteStoredCard(db: Db, provider: PaymentProvider, keyring: Keyring, paymentMethodTokenId: number, now: Date = new Date()): Promise<CardDeletionOutcome> {
  const row = await db.paymentMethodToken.findUniqueOrThrow({ where: { id: paymentMethodTokenId } });
  if (!row.revokedAt) await db.paymentMethodToken.update({ where: { id: row.id }, data: { revokedAt: now } });
  if (row.providerDeletedAt || row.idUserEnc === '') return 'DELETED';
  let card: { idUser: number; tokenUser: string };
  try {
    card = openCard(keyring, row);
  } catch (error) {
    if (error instanceof DecryptionError) return 'UNREADABLE';
    throw error;
  }
  try {
    await provider.deleteCard(card);
  } catch (error) {
    if (error instanceof PaymentProviderError) return 'FAILED';
    throw error;
  }
  await db.paymentMethodToken.update({ where: { id: row.id }, data: { idUserEnc: '', tokenUserEnc: '', providerDeletedAt: now, brand: null, last4: null, expiresMonth: null, expiresYear: null } });
  return 'DELETED';
}
