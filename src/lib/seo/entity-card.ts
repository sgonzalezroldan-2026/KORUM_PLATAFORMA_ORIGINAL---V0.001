import { createHash } from 'node:crypto';

/** Forma de la versión de la tarjeta de una entidad en su URL (`?v=`): 12 cifras hexadecimales. Otra cosa responde `404`. */
export const ENTITY_CARD_VERSION_PATTERN = /^[0-9a-f]{12}$/;

/**
 * Versión de la tarjeta social de una entidad (Sprint 5.5a, auditoría de seguridad H5): una huella corta de **solo lo que se dibuja** (nombre,
 * vertical, logotipo y color). No se usa la fecha de modificación de la entidad porque cambia con cualquier escritura interna (cupos, comercios,
 * KYB) y la publicaría al milisegundo en cada `og:image`, además de obligar a WhatsApp a pedir una imagen igual. Solo servidor (`node:crypto`).
 */
export function entityCardVersion(organization: { name: string; vertical: string; logoFileId: string | null; brandPrimary: string | null }): string {
  const drawn = [organization.name, organization.vertical, organization.logoFileId ?? '', organization.brandPrimary ?? ''].join('\u0000');
  return createHash('sha256').update(drawn).digest('hex').slice(0, 12);
}
