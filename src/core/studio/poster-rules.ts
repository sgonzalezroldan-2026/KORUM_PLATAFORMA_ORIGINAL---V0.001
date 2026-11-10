/**
 * Cartel A4 con QR (Sprint 4.3, `poster-modal` del prototipo). El cartel invita a aportar a una campaña que ya está recaudando: el QR lleva a su ficha
 * pública, que solo existe mientras recauda, así que antes de publicarla (o tras cerrarla) no se genera un cartel cuyo QR no llevaría a ningún sitio.
 */

export const POSTER_LIMITS = { titleMax: 90, messageMax: 200 } as const;

/** Solo una campaña recaudando tiene un enlace al que invitar a entrar. */
export function canPrintPoster(status: string): boolean {
  return status === 'FUNDRAISING';
}

/** La dirección impresa bajo el QR: sin `https://` ni barra final, para teclearla a mano. */
export function printedUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}
