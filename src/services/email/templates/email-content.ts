import type { ZodType } from 'zod';
import type { EmailAttachment } from '../email-provider';

/**
 * Contenido de un email ya traducido y listo para pintar. Todas las plantillas del catálogo (EXPERIENCIA_DE_PRODUCTO §4) producen esta
 * misma forma, así que hay un único diseño (`EmailLayout`) y un único generador de texto plano: los emails no pueden divergir entre sí
 * ni entre idiomas. Regla del catálogo: un único botón principal.
 */
export interface EmailContent {
  subject: string;
  /** Primera línea que se ve en la bandeja de entrada, antes de abrir el email. */
  preheader: string;
  title: string;
  paragraphs: string[];
  facts: Array<{ label: string; value: string }>;
  button?: { label: string; url: string };
  /** Código de un solo uso que debe leerse y copiarse de un vistazo: se pinta grande, aparte de los datos. */
  highlight?: { label: string; value: string };
  footnote?: string;
  /** Pie legal: operación de la persona con una entidad (`transactional`), aviso a quien gestiona una entidad (`organization`) o acción sobre la cuenta (`account`). */
  footer: 'transactional' | 'organization' | 'account';
  attachments?: EmailAttachment[];
}

export type Translate = (key: string, values?: Record<string, string | number>) => string;

export interface TemplateContext {
  locale: 'es' | 'ca' | 'en';
  t: Translate;
  formatMoney: (cents: number) => string;
  formatDate: (value: Date | string) => string;
  /** Fecha y hora en Europe/Madrid, para plazos que vencen a una hora concreta. */
  formatDateTime: (value: Date | string) => string;
  /** URL pública absoluta de una ruta de la aplicación, con el prefijo del idioma. */
  url: (path: string) => string;
  /** Cuándo se escribió el mensaje en la bandeja (fecha estable para el calendario). */
  createdAt: Date;
  organization?: { name: string; legalName: string; slug: string };
  initiative?: {
    id: number;
    title: string;
    closesAt: Date;
    goalCents: number;
    raisedCents: number;
    totalContributions: number;
    ticketSubtype: 'EVENT' | 'RAFFLE' | null;
    ticketVenue: string | null;
    /** Estado al enviar el mensaje (no al escribirlo): un aviso que sale tarde dice lo que ya es verdad (Sprint 5.5b). */
    status?: string;
  };
  /** `QR_HMAC_SECRET`: solo lo usa la entrada, para componer su QR al enviar (el mensaje no lo lleva). */
  qrSecret?: string;
}

export interface TemplateDefinition<Payload> {
  /** Forma esperada de `payloadJson`. Un mensaje que no la cumple es un error nuestro y se marca como fallido, no se reintenta. */
  schema: ZodType<Payload>;
  /** Campos del payload que son secretos de un solo uso (enlaces, códigos): se borran del mensaje en cuanto se envía o se cancela. */
  secretFields?: readonly string[];
  /** Hace falta una iniciativa (`initiativeId` en el payload) o una entidad (`organizationId` del mensaje) para componer el texto. */
  needs?: 'initiative' | 'organization';
  /** Quién aparece como remitente: por defecto, la entidad («Entidad vía KORUM»); `platform` lo deja como KORUM (un texto que escribe el equipo de KORUM no debe parecer del centro). */
  sender?: 'organization' | 'platform';
  build: (payload: Payload, context: TemplateContext) => EmailContent | Promise<EmailContent>;
}
