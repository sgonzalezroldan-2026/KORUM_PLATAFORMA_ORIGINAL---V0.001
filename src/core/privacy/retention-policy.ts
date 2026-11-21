/**
 * Plazos de conservación de la [tabla única de plazos](docs/legal/tabla-de-plazos.md), validada por el promotor (decisión 61 y 2026-11-21), en un solo sitio
 * (Sprint 5.10b). La tabla manda: un plazo se cambia allí y aquí, y en ningún otro módulo. Lo aplican la tarea semanal `DATA_RETENTION_PURGE`, la limpieza diaria
 * `OPS_HOUSEKEEPING`, la duración de la sesión y los ficheros que deben conservarse (`retainUntil`). Cada entrada cita su apartado de la tabla.
 *
 * Los de «6 años desde el cierre del ejercicio» se cuentan por años naturales (tabla §2, regla 1): un dato de 2026 vence el 1 de enero de 2033.
 */

const DAY_MS = 86_400_000;

export const RETENTION = {
  /** §3.1 y §3.2: datos fiscales del donante (NIF, nombre, provincia), emails de sus compras y aportaciones unidas a una cuenta: 6 años desde el cierre del ejercicio. */
  fiscalYears: 6,
  /** §3.1: avisos de PAYCOMET con cada cobro, 6 años desde el cierre del ejercicio en que llegaron. */
  paymentWebhookYears: 6,
  /** §3.1: avisos de pago rechazados porque su firma no era válida: 90 días (limpieza diaria). */
  rejectedWebhookDays: 90,
  /** §3.1: factura o proforma del proveedor subida y no adjuntada a ninguna liquidación: 30 días. */
  unattachedInvoiceDays: 30,
  /** §3.1: códigos de un solo uso para firmar (enlace y clave): 7 días después de usarse, caducar o anularse (limpieza diaria). */
  signatureChallengeDays: 7,
  /** §3.3: cuenta sin actividad 3 años: aviso por email y supresión 30 días después si no vuelve. */
  inactiveAccountDays: 3 * 365,
  inactivityGraceDays: 30,
  /** §3.3: alta que nunca verificó su email, con lo que se creó con ella (la entidad y su aceptación de los textos): 7 días. */
  unverifiedSignupDays: 7,
  /** §3.3: sesiones abiertas: 30 días desde la última visita (la capa de acceso las renueva cada día de uso). */
  sessionDays: 30,
  /** §3.3: solicitudes de derechos: 3 años desde que se cierran (prescripción de las infracciones más graves, LOPDGDD art. 72). */
  privacyRequestDaysAfterClosed: 3 * 365,
  /** §3.3: consentimientos: mientras estén vigentes y 3 años más. */
  consentDaysAfterSuperseded: 3 * 365,
  /** §3.3: cuenta creada al invitar a alguien a firmar que nunca se activó: 30 días sin invitación abierta ni relevo pendiente. */
  unactivatedInviteeDays: 30,
  /** §3.4: autoría y firmas de una idea, mientras dure y 1 año más. */
  ideaSignatureDaysAfterIdea: 365,
  /** §3.4: conversación de una idea (mensajes de la familia y respuestas de la entidad) y descripción de la idea: mientras dure y 1 año más. */
  ideaChatDaysAfterIdea: 365,
  ideaDescriptionDaysAfterIdea: 365,
  /** §3.4: dispositivo reconocido por la cookie del buzón: 13 meses sin usarse (lo que dura la cookie). */
  deviceDays: 396,
  /** §3.1, §3.4 y §3.10: códigos seudónimos de la conexión, huella del navegador y navegador de cada anotación: 12 meses. */
  networkHashDays: 365,
  /** §3.5: consultas de soporte, 2 años desde que se resuelven (o desde que se abren, si nunca se resuelven). */
  supportTicketDaysAfterResolved: 2 * 365,
  /** §3.5: contenido y destinatario de los emails enviados: 12 meses (queda constancia del envío). */
  notificationDays: 365,
  /** §3.6: nombre que un voluntario da a su móvil de portería: 90 días desde que caduca su sesión. */
  gateDeviceLabelDaysAfterExpiry: 90,
  /** §3.6 (`L-124`): lecturas de la portería, canjes de vales y sesiones de los móviles: 1 año desde que se liquida el evento o la venta. */
  gateReadingDaysAfterSettlement: 365,
  /** §3.7: email copiado en el voto de una votación de redimensionamiento: 1 año desde que se cierra. */
  resizeVoteDaysAfterClose: 365,
  /** §3.8: comercio que empezó un pago y no lo completó: 30 días. */
  unpaidSponsorDays: 30,
  /** §3.9: documentación del titular: mientras la entidad esté en KORUM y 6 años más; el documento sustituido, 6 años desde que se sustituye. */
  ownerDocumentYears: 6,
  /** §3.10: rastros de seguridad (intentos fallidos de entrar y accesos denegados): 12 meses y se desvinculan de la cuenta (decisión 35). */
  securityTraceDays: 365,
  /** §3.10: alertas de operación y tareas del sistema: 12 meses desde que la alerta se resuelve o la tarea termina. */
  operationsDaysAfterClosed: 365
} as const;

export const daysBefore = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS);
export const daysAfter = (from: Date, days: number) => new Date(from.getTime() + days * DAY_MS);

/** Último ejercicio cuyos datos fiscales ya han vencido: con `now` en 2027, el 2020. */
export const lastExpiredFiscalYear = (now: Date) => now.getUTCFullYear() - RETENTION.fiscalYears - 1;

/** 1 de enero (UTC) del primer año que aún se conserva: lo anterior a esta fecha ha vencido. */
export const fiscalCutoff = (now: Date, years: number) => new Date(Date.UTC(now.getUTCFullYear() - years, 0, 1));

/** Hasta cuándo se conserva lo que vale «6 años desde el cierre del ejercicio» de `from`: un dato de 2026 se conserva hasta el 1 de enero de 2033. */
export const fiscalRetainUntil = (from: Date, years: number = RETENTION.fiscalYears) => new Date(Date.UTC(from.getUTCFullYear() + years + 1, 0, 1));

/** «Mientras dure la relación y 6 años más» (§3.9), contado desde `from`: 6 años naturales exactos. */
export function yearsAfter(from: Date, years: number): Date {
  const until = new Date(from.getTime());
  until.setUTCFullYear(until.getUTCFullYear() + years);
  return until;
}
