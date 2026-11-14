import { RESIZE_MIN_WINDOW_DAYS } from './resize-limits';

/**
 * Recordatorio escalado de una campaña vencida (`EXPIRED`) que sigue sin decisión (Sprint 5.5b, heredado del 4.4b). La entidad decide si lanza la votación de
 * redimensionamiento o devuelve el 100 %; mientras no decide, el dinero sigue en la hucha de la iniciativa en PAYCOMET y la ventana de 90 días de reparto corre.
 *
 * - `VOTE_CLOSING`: últimos días para poder lanzar la votación (le hacen falta `RESIZE_MIN_WINDOW_DAYS` de ventana). Solo si la votación es posible.
 * - `DAYS_14`, `DAYS_7`, `DAYS_3`, `DAYS_1`: cada vez más cerca del final de la ventana. Cada etapa se avisa una sola vez a quienes firman.
 * - La alerta de la consola del Super-Admin (`EXPIRED_DECISION_PENDING`) se abre a 14 días y pasa a crítica a 7 (o con la ventana ya vencida).
 *
 * Nunca el mismo día del vencimiento: ese día ya sale el aviso `initiative.expired`, que explica las dos opciones.
 */

export const VOTE_CLOSING_NOTICE_DAYS = 3;
const DAY_THRESHOLDS = [1, 3, 7, 14] as const;
export const EXPIRED_ALERT_DAYS = 14;
export const EXPIRED_CRITICAL_DAYS = 7;
const DAY_MS = 86_400_000;

export type ExpiredReminderStage = 'VOTE_CLOSING' | `DAYS_${(typeof DAY_THRESHOLDS)[number]}`;

export interface ExpiredReminderInput {
  /** Días que quedan de la ventana de 90 días desde el primer cobro (0 si ya venció). */
  windowDaysLeft: number;
  /** ¿Podría lanzar la votación si tuviera ventana? (campaña de presupuesto, con donaciones y sin votación previa). */
  voteEligible: boolean;
  /** Cuándo venció (rastro `initiative.expired`); `null` si no hay rastro. */
  expiredAt: Date | null;
  now: Date;
}

export interface ExpiredReminderPlan {
  stage: ExpiredReminderStage | null;
  /** Aún se puede lanzar la votación hoy. */
  canVote: boolean;
  /** Último día (incluido) en que se puede lanzar la votación, en días desde hoy; `null` si ya no se puede. */
  voteDaysLeft: number | null;
  alert: 'NONE' | 'WARNING' | 'CRITICAL';
}

export function planExpiredReminder(input: ExpiredReminderInput): ExpiredReminderPlan {
  const canVote = input.voteEligible && input.windowDaysLeft >= RESIZE_MIN_WINDOW_DAYS;
  const voteDaysLeft = canVote ? input.windowDaysLeft - RESIZE_MIN_WINDOW_DAYS : null;
  const alert = input.windowDaysLeft <= EXPIRED_CRITICAL_DAYS ? 'CRITICAL' : input.windowDaysLeft <= EXPIRED_ALERT_DAYS ? 'WARNING' : 'NONE';
  // Vencida hace menos de un día: el aviso de vencimiento acaba de salir. Sin rastro del vencimiento (datos anteriores a la auditoría) se avisa igualmente.
  const fresh = input.expiredAt !== null && input.now.getTime() - input.expiredAt.getTime() < DAY_MS;
  let stage: ExpiredReminderStage | null = null;
  if (!fresh) {
    if (voteDaysLeft !== null && voteDaysLeft <= VOTE_CLOSING_NOTICE_DAYS) stage = 'VOTE_CLOSING';
    else {
      const threshold = DAY_THRESHOLDS.find((days) => input.windowDaysLeft <= days);
      if (threshold !== undefined) stage = `DAYS_${threshold}`;
    }
  }
  return { stage, canVote, voteDaysLeft, alert };
}
