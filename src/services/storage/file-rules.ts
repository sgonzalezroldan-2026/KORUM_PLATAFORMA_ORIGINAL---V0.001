import type { FilePurpose, FileVisibility, MemberRole } from '@/generated/prisma/enums';

/**
 * Qué ficheros admite cada uso y cómo se comprueba que son lo que dicen ser (QA-OPS02). Nunca se confía en el tipo ni en la extensión que
 * declara quien sube: el tipo sale de los primeros bytes del contenido. No se admite SVG (puede llevar scripts) ni HTML.
 */

export type DetectedType = 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/webp' | 'text/plain';

const EXTENSIONS: Record<DetectedType, readonly string[]> = {
  'application/pdf': ['pdf'],
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/webp': ['webp'],
  'text/plain': ['txt', '182']
};

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) => signature.every((value, index) => bytes[offset + index] === value);

const CONTROL_CHARACTERS = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]');

/** Texto plano válido: UTF-8 sin caracteres de control (salvo salto de línea, retorno y tabulador). */
function isPlainText(bytes: Uint8Array): boolean {
  try {
    return !CONTROL_CHARACTERS.test(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return false;
  }
}

export function detectFileType(bytes: Uint8Array): DetectedType | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return bytes.length > 0 && isPlainText(bytes) ? 'text/plain' : null;
}

export const extensionOf = (type: DetectedType): string => EXTENSIONS[type][0]!;

/** `true` si la extensión del nombre (si la hay) corresponde al tipo detectado. */
export function extensionMatches(fileName: string | undefined, type: DetectedType): boolean {
  const extension = fileName?.includes('.') ? fileName.split('.').pop()?.toLowerCase() : undefined;
  return extension === undefined || EXTENSIONS[type].includes(extension);
}

export interface FileRule {
  visibility: FileVisibility;
  types: readonly DetectedType[];
  maxBytes: number;
  /** Documento que la ley obliga a conservar: quien lo sube debe indicar hasta cuándo (`retainUntil`), o la purga no sabría su plazo. */
  retentionRequired: boolean;
  /** Quién puede abrirlo dentro de su entidad (solo cubo privado). El Super-Admin puede abrir todos, con registro. */
  readRoles: readonly MemberRole[];
}

const MB = 1024 * 1024;
const IMAGES: readonly DetectedType[] = ['image/png', 'image/jpeg', 'image/webp'];
const SIGNERS: readonly MemberRole[] = ['DIRECTOR', 'COSIGNER'];
const PUBLIC_RULE = { visibility: 'PUBLIC', types: IMAGES, retentionRequired: false, readRoles: [] } as const;

export const FILE_RULES: Record<FilePurpose, FileRule> = {
  ORG_LOGO: { ...PUBLIC_RULE, maxBytes: 2 * MB },
  // 4 MB: tope de 4,5 MB del cuerpo en Vercel (como el KYB); una portada se comprime antes.
  ORG_BANNER: { ...PUBLIC_RULE, maxBytes: 4 * MB },
  // 4 MB, como la portada: el cuerpo de una petición a Vercel no pasa de 4,5 MB (Sprint 4.4c).
  INITIATIVE_COVER: { ...PUBLIC_RULE, maxBytes: 4 * MB },
  // 4 MB, como el KYB: el cuerpo de una petición a una función de Vercel no pasa de 4,5 MB (heredado del 4.2c, Sprint 4.4a). La subida directa al almacén es del 6.1.
  INITIATIVE_BEFORE: { ...PUBLIC_RULE, maxBytes: 4 * MB },
  INITIATIVE_AFTER: { ...PUBLIC_RULE, maxBytes: 4 * MB },
  SPONSOR_LOGO: { ...PUBLIC_RULE, maxBytes: 2 * MB },
  // 4 MB: el cuerpo de una petición a una función de Vercel no puede pasar de 4,5 MB (auditoría del 4.2c); un PDF escaneado se comprime antes.
  KYB_DOCUMENT: { visibility: 'PRIVATE', types: ['application/pdf', ...IMAGES], maxBytes: 4 * MB, retentionRequired: true, readRoles: SIGNERS },
  PROVIDER_INVOICE: { visibility: 'PRIVATE', types: ['application/pdf', ...IMAGES], maxBytes: 4 * MB, retentionRequired: true, readRoles: SIGNERS },
  KORUM_INVOICE_PDF: { visibility: 'PRIVATE', types: ['application/pdf'], maxBytes: 5 * MB, retentionRequired: true, readRoles: SIGNERS },
  // El donante abrirá su propio certificado por una ruta propia (Sprint 3.7), con su sesión; aquí solo quienes firman en la entidad.
  TAX_CERTIFICATE: { visibility: 'PRIVATE', types: ['application/pdf'], maxBytes: 5 * MB, retentionRequired: true, readRoles: SIGNERS },
  MODEL182_EXPORT: { visibility: 'PRIVATE', types: ['text/plain'], maxBytes: 20 * MB, retentionRequired: true, readRoles: SIGNERS }
};
