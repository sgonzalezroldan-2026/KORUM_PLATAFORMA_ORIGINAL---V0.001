/**
 * Plazos de conservación de CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD §6 (propuesta a validar por el abogado), en un solo sitio. La tarea
 * `DATA_RETENTION_PURGE` los aplica; ningún otro módulo debe escribir estos números.
 *
 * Los de «6 años desde el cierre del ejercicio» se cuentan por años naturales: un dato del ejercicio 2020 vence el 1 de enero de 2027.
 */

const DAY_MS = 86_400_000;

export const RETENTION = {
  /** Datos fiscales del donante (NIF, nombre, provincia) y emails de sus compras: 6 años desde el cierre del ejercicio. */
  fiscalYears: 6,
  /** Webhooks de pago: 6 años desde el cierre del ejercicio en que llegaron. */
  paymentWebhookYears: 6,
  /** Cuenta sin actividad: 3 años, aviso y anonimización 30 días después si no vuelve. */
  inactiveAccountDays: 3 * 365,
  inactivityGraceDays: 30,
  /** Auditoría de firmas de ideas: vida de la idea + 1 año. */
  ideaSignatureDaysAfterIdea: 365,
  /** Cookie de dispositivo: 13 meses (y con ella, el dispositivo). */
  deviceDays: 396,
  /** HMAC de IP y huella del navegador: 12 meses. */
  networkHashDays: 365,
  /** Chat de una idea (mensajes de la familia): vida de la idea + 1 año, como su auditoría de firmas. */
  ideaChatDaysAfterIdea: 365,
  /** Consultas de soporte: 2 años desde que se cerraron (o desde que se abrieron, si nunca se resuelven); después pierden el email y el texto (queda el hecho de la consulta). */
  supportTicketDaysAfterResolved: 2 * 365,
  /** Nombre que un voluntario da a su móvil de portería («Puerta norte»; puede ser un nombre de persona): se vacía 90 días después de que la sesión caduque (Sprint 4.5). */
  gateDeviceLabelDaysAfterExpiry: 90,
  /** Contenido de las notificaciones enviadas: 12 meses (se conserva el hecho del envío). */
  notificationDays: 365,
  /** Consentimientos: mientras estén vigentes + 3 años. */
  consentDaysAfterSuperseded: 3 * 365,
  /** Comercio que empezó a patrocinar y nunca pagó (contacto y CIF cifrado sin ningún cobro detrás): 30 días (heredado del Sprint 3.5, punto 6). */
  unpaidSponsorDays: 30,
  /**
   * Cuenta creada al invitar a alguien a firmar (cofirma o relevo, Sprint 4.2e) que nunca se activó: nombre y email que escribió otra persona, sin
   * ningún servicio detrás. 30 días sin invitación abierta ni relevo pendiente (auditoría del 4.2e, I6).
   */
  unactivatedInviteeDays: 30,
  /**
   * Votos de redimensionamiento (Sprint 4.4b, heredado del 2.5): el email canónico de quien votó, 1 año desde que se cerró la votación. Después queda el
   * voto anónimo (el recuento se puede rehacer) y la devolución de quien la pidió sigue en su aportación, su asiento y la auditoría.
   */
  resizeVoteDaysAfterClose: 365
} as const;

export const daysBefore = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS);

/** Último ejercicio cuyos datos fiscales ya han vencido: con `now` en 2027, el 2020. */
export const lastExpiredFiscalYear = (now: Date) => now.getUTCFullYear() - RETENTION.fiscalYears - 1;

/** 1 de enero (UTC) del primer año que aún se conserva: lo anterior a esta fecha ha vencido. */
export const fiscalCutoff = (now: Date, years: number) => new Date(Date.UTC(now.getUTCFullYear() - years, 0, 1));
