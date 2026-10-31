import type { Db } from '@/lib/db';
import { openField, sealField } from '@/lib/encryption';
import type { PaymentProvider } from './payment-provider';

/**
 * Tarjetas tokenizadas (JET-ID) para Mi Hucha y la renovación de comercios. KORUM nunca recibe el número de la tarjeta: el formulario de
 * Paycomet entrega un token de un solo uso, que se cambia por `idUser` + `tokenUser`. Esos dos valores se guardan cifrados.
 */

const ID_USER_CONTEXT = 'paycomet:idUser';
const TOKEN_USER_CONTEXT = 'paycomet:tokenUser';

export interface CardEncryption {
  keyBase64: string;
  keyVersion: number;
}

export async function tokenizeAndStoreCard(
  db: Db,
  provider: PaymentProvider,
  input: { jetToken: string; userId: string | null; brand?: string; last4?: string; expiresMonth?: number; expiresYear?: number },
  encryption: CardEncryption
): Promise<{ paymentMethodTokenId: number }> {
  const { idUser, tokenUser } = await provider.tokenizeCard({ jetToken: input.jetToken });
  const row = await db.paymentMethodToken.create({
    data: {
      userId: input.userId,
      provider: provider.name,
      idUserEnc: sealField(String(idUser), encryption.keyBase64, ID_USER_CONTEXT),
      tokenUserEnc: sealField(tokenUser, encryption.keyBase64, TOKEN_USER_CONTEXT),
      keyVersion: encryption.keyVersion,
      brand: input.brand ?? null,
      last4: input.last4 ?? null,
      expiresMonth: input.expiresMonth ?? null,
      expiresYear: input.expiresYear ?? null
    },
    select: { id: true }
  });
  return { paymentMethodTokenId: row.id };
}

/** Devuelve el token para cobrar, solo a su propietario: una familia o un comercio. Un token revocado no se puede usar. */
export async function loadCardToken(db: Db, paymentMethodTokenId: number, owner: { userId: string } | { sponsorId: number }, encryption: CardEncryption): Promise<{ idUser: number; tokenUser: string }> {
  // Con un valor vacío, Prisma ignoraría el filtro y devolvería la tarjeta de cualquiera.
  if ('userId' in owner ? !owner.userId : !owner.sponsorId) throw new RangeError('Hace falta el propietario de la tarjeta');
  const row = await db.paymentMethodToken.findFirstOrThrow({ where: { id: paymentMethodTokenId, ...('userId' in owner ? { userId: owner.userId } : { sponsors: { some: { id: owner.sponsorId } } }) } });
  if (row.revokedAt) throw new RangeError(`La tarjeta ${paymentMethodTokenId} está revocada`);
  if (row.keyVersion !== encryption.keyVersion) throw new RangeError(`La tarjeta ${paymentMethodTokenId} está cifrada con otra versión de la clave`);
  return {
    idUser: Number(openField(row.idUserEnc, encryption.keyBase64, ID_USER_CONTEXT)),
    tokenUser: openField(row.tokenUserEnc, encryption.keyBase64, TOKEN_USER_CONTEXT)
  };
}
