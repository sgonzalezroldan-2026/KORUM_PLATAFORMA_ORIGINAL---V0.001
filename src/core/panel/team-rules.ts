import { z } from 'zod';
import { LINK_LIKE } from '@/core/onboarding/registration-rules';

/**
 * Reglas del equipo que firma (Sprint 4.2e). Funciones puras: el formulario las usa para avisar campo a campo y el servidor las vuelve a aplicar.
 *
 * - **Relevo** (decisión del promotor del 2026-11-12): cada persona firmante puede ceder su puesto, y cualquiera de las dos puede proponer el relevo
 *   de la otra (también la Cofirma sustituyendo a la Dirección). Sin esperas ni visto bueno de quien sale: la entidad lo resuelve y queda registrado.
 * - **Modo de firma:** la entidad elige entre dos firmas (Dirección y Cofirma) o una sola (Dirección), bajo su responsabilidad.
 * - **Cargo** (`roleLabel`): cada persona cambia el suyo; el de la persona nueva viaja en la invitación. Sin enlaces, dominios ni emails: sale en
 *   el email de invitación, firmado por KORUM (anti-suplantación, como en el alta).
 */

export const SEAT_ROLES = ['DIRECTOR', 'COSIGNER'] as const;
export type SeatRole = (typeof SEAT_ROLES)[number];

const plainText = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) => !LINK_LIKE.test(value));

export const roleLabelField = plainText(3, 60);
const personName = plainText(2, 80);
// Se limpia antes de validar: un espacio pegado al copiar el email no es un error de quien lo escribe.
const email = z.string().trim().toLowerCase().pipe(z.email().max(254));

/** Proponer quién ocupa un puesto: el propio (ceder) o el de la otra persona (necesita su visto bueno). */
export const handoverProposalSchema = z
  .object({
    role: z.enum(SEAT_ROLES),
    name: personName,
    email,
    roleLabel: roleLabelField
  })
  .strict();
export type HandoverProposalInput = z.infer<typeof handoverProposalSchema>;

/** Corregir la invitación de la cofirma mientras aún no la ha aceptado (email mal escrito, otra persona). */
export const cosignerCorrectionSchema = z.object({ name: personName, email, roleLabel: roleLabelField }).strict();
export type CosignerCorrectionInput = z.infer<typeof cosignerCorrectionSchema>;

export const ownRoleLabelSchema = z.object({ roleLabel: roleLabelField }).strict();

/** Campos con error de un formulario del equipo (para señalarlos uno a uno). */
export function invalidFields(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => String(issue.path[0] ?? 'form')))];
}

/**
 * Email a medias para el panel: lo justo para que la persona que da su visto bueno reconozca a quién se invita, sin enseñar la dirección completa
 * de alguien ajeno (`marta.gil@gmail.com` → `ma•••@gmail.com`).
 */
export function maskEmail(address: string): string {
  const [local = '', domain = ''] = address.split('@');
  if (!domain) return '•••';
  // Una parte local de una sola letra se oculta entera: enseñarla sería enseñar el email (auditoría del 4.2e, M7).
  if (local.length <= 1) return `•••@${domain}`;
  return `${local.slice(0, Math.min(2, local.length - 1))}•••@${domain}`;
}

/** Cambio del modo de firma de la entidad: solo lo cambia Dirección y la entidad lo confirma expresamente (el cambio es inmediato). */
export const signatureModeChangeSchema = z.object({ mode: z.enum(['DOUBLE', 'SINGLE']), confirm: z.literal(true) }).strict();
