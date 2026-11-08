import { randomBytes } from 'node:crypto';

/**
 * Referencia de una hucha (`WLT-ESC-XXXXXX`): la de cada entidad (`Organization.walletId`) y la de cada iniciativa (`Initiative.walletEscrowId`).
 * Seis caracteres al azar del generador criptográfico, sin los que se confunden al dictarlos (0/O, 1/I): unos mil millones de combinaciones.
 */
const WALLET_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function newWalletId(): string {
  return `WLT-ESC-${[...randomBytes(6)].map((byte) => WALLET_ALPHABET[byte % WALLET_ALPHABET.length]).join('')}`;
}
