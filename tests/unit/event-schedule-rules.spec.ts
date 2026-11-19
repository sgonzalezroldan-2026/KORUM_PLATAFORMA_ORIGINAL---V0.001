import { describe, expect, it } from 'vitest';
import { FOURTEEN_DAY_RULE_DAYS, fourteenDayDeadline } from '@/core/finance/fourteen-day-rule';
import { MAX_CAMPAIGN_DAYS_LIMIT } from '@/core/finance/campaign-window';
import { endOfDayInMadrid } from '@/core/studio/studio-draft';
import {
  cancelEventSchema,
  eventChangeProblem,
  eventOutcomeAtDate,
  heldEventMaintenanceCents,
  latestEventDate,
  latestRescheduleDay,
  readEventRefundToken,
  rescheduleDateFor,
  rescheduleEventSchema,
  signEventRefundToken,
  statusAfterReschedule
} from '@/core/ticketing/event-schedule-rules';

/**
 * Sprint 5.13 · reglas puras de un evento con entradas que llega a su fecha, se cancela o cambia de fecha (decisión 30 del promotor y decisiones de
 * apertura del 2026-11-19). La parte con base de datos está en `tests/integration/event-schedule.spec.ts` (QA-TKT10).
 */

const DAY = 86_400_000;
const SECRET = 'x'.repeat(64);

describe('QA-TKT10 · qué pasa cuando llega la fecha', () => {
  it('con algo vendido se liquida por lo vendido; sin nada, se cierra sin dinero', () => {
    expect(eventOutcomeAtDate(20_000)).toBe('SETTLE');
    expect(eventOutcomeAtDate(1)).toBe('SETTLE');
    expect(eventOutcomeAtDate(0)).toBe('CLOSE_EMPTY');
  });

  it('el mantenimiento baja en proporción a lo vendido, hacia abajo, y nunca pasa del publicado (decisión del 2026-11-19)', () => {
    // Ejemplo del promotor: 200 entradas a 5 €, 49 € de mantenimiento, 40 vendidas → 9,80 €.
    expect(heldEventMaintenanceCents(4_900, 20_000, 100_000)).toBe(980);
    expect(heldEventMaintenanceCents(4_900, 33_333, 100_000)).toBe(1_633);
    expect(heldEventMaintenanceCents(4_900, 100_000, 100_000)).toBe(4_900);
    expect(heldEventMaintenanceCents(4_900, 150_000, 100_000)).toBe(4_900);
    expect(heldEventMaintenanceCents(0, 20_000, 100_000)).toBe(0);
    expect(heldEventMaintenanceCents(4_900, 0, 100_000)).toBe(0);
    expect(heldEventMaintenanceCents(4_900, 20_000, 0)).toBe(0);
  });

  it('el mantenimiento proporcional nunca deja a la entidad sin nada ni negativo', () => {
    for (const raised of [1, 7, 99, 500, 4_899, 50_000]) {
      const maint = heldEventMaintenanceCents(4_900, raised, 100_000);
      expect(Number.isSafeInteger(maint)).toBe(true);
      expect(raised - maint).toBeGreaterThan(0);
    }
  });
});

describe('cancelar y cambiar la fecha', () => {
  it('solo eventos con entradas, vivos y sin liquidar', () => {
    expect(eventChangeProblem({ format: 'TICKETING', status: 'FUNDRAISING', payoutStatus: null })).toBeNull();
    expect(eventChangeProblem({ format: 'TICKETING', status: 'GOAL_REACHED', payoutStatus: null })).toBeNull();
    expect(eventChangeProblem({ format: 'TICKETING', status: 'GOAL_REACHED', payoutStatus: 'PENDING_DOUBLE_CHECK' })).toBeNull();
    expect(eventChangeProblem({ format: 'TICKETING', status: 'GOAL_REACHED', payoutStatus: 'APPROVED' })).toBe('ALREADY_SETTLED');
    expect(eventChangeProblem({ format: 'TICKETING', status: 'GOAL_REACHED', payoutStatus: 'EXECUTED' })).toBe('ALREADY_SETTLED');
    expect(eventChangeProblem({ format: 'BUDGET', status: 'FUNDRAISING', payoutStatus: null })).toBe('NOT_AN_EVENT');
    for (const status of ['BUDGETING', 'CLOSED', 'EXPIRED', 'REFUNDING', 'REFUNDED', 'CANCELLED']) expect(eventChangeProblem({ format: 'TICKETING', status, payoutStatus: null })).toBe('WRONG_STATUS');
  });

  it('tras cambiar la fecha, agotado sigue liquidable y si no vuelve a vender', () => {
    expect(statusAfterReschedule(true)).toBe('GOAL_REACHED');
    expect(statusAfterReschedule(false)).toBe('FUNDRAISING');
  });

  it('los datos de entrada se validan con Zod (nada de campos de más ni fechas con hora)', () => {
    expect(cancelEventSchema.safeParse({ initiativeId: 5 }).success).toBe(true);
    expect(cancelEventSchema.safeParse({ initiativeId: 5, organizationId: 'otra' }).success).toBe(false);
    expect(rescheduleEventSchema.safeParse({ initiativeId: 5, newDay: '2026-12-12' }).success).toBe(true);
    expect(rescheduleEventSchema.safeParse({ initiativeId: 5, newDay: '2026-12-12T10:00:00Z' }).success).toBe(false);
    expect(rescheduleEventSchema.safeParse({ initiativeId: -1, newDay: '2026-12-12' }).success).toBe(false);
  });
});

describe('límite de la fecha nueva (decisión del 2026-11-19: el máximo de la campaña desde su publicación)', () => {
  const published = new Date('2026-11-01T10:00:00Z');
  const latest = latestEventDate(published, 60);
  const now = new Date('2026-11-10T09:00:00Z');
  const current = endOfDayInMadrid('2026-11-20') as Date;

  it('el último instante es la publicación más los días máximos, sin pasar nunca de 75', () => {
    expect(latest.getTime() - published.getTime()).toBe(60 * DAY);
    expect(latestEventDate(published, 200).getTime() - published.getTime()).toBe(MAX_CAMPAIGN_DAYS_LIMIT * DAY);
  });

  it('el plazo de 14 días es un valor único', () => {
    expect(FOURTEEN_DAY_RULE_DAYS).toBe(14);
    expect(fourteenDayDeadline(now).getTime() - now.getTime()).toBe(14 * DAY);
  });

  it('acepta una fecha futura dentro del máximo y la cierra al final de ese día en España', () => {
    const chosen = rescheduleDateFor('2026-11-27', current, latest, now);
    expect(chosen).toEqual({ newDate: endOfDayInMadrid('2026-11-27') });
  });

  it('rechaza fechas que no existen, pasadas, la misma o demasiado lejanas', () => {
    expect(rescheduleDateFor('2026-02-30', current, latest, now)).toEqual({ problem: 'DATE_INVALID' });
    expect(rescheduleDateFor('2026-11-09', current, latest, now)).toEqual({ problem: 'DATE_IN_PAST' });
    expect(rescheduleDateFor('2026-11-20', current, latest, now)).toEqual({ problem: 'SAME_DATE' });
    expect(rescheduleDateFor('2026-12-31', current, latest, now)).toEqual({ problem: 'DATE_TOO_LATE' });
  });

  it('si los 14 días de devolución ya no caben antes del máximo, no se puede cambiar a ninguna fecha', () => {
    const late = new Date(latest.getTime() - 13 * DAY);
    expect(rescheduleDateFor('2026-12-30', current, latest, late)).toEqual({ problem: 'DATE_TOO_LATE' });
    expect(latestRescheduleDay(latest, late)).toBeNull();
  });

  it('el último día elegible acaba antes del máximo (si el día del máximo termina después, se queda en la víspera)', () => {
    const day = latestRescheduleDay(latest, now);
    expect(day).toBe('2026-12-30');
    expect((endOfDayInMadrid(day as string) as Date) <= latest).toBe(true);
    expect(rescheduleDateFor(day as string, current, latest, now)).toEqual({ newDate: endOfDayInMadrid(day as string) });
  });
});

describe('enlace personal de devolución', () => {
  it('firma el cambio de fecha y la compra, y no acepta otro secreto ni un enlace retocado', () => {
    const token = signEventRefundToken(SECRET, 3, 41);
    expect(readEventRefundToken(SECRET, token)).toEqual({ rescheduleId: 3, contributionId: 41 });
    expect(readEventRefundToken('y'.repeat(64), token)).toBeNull();
    expect(readEventRefundToken(SECRET, token.replace(/^3\./, '4.'))).toBeNull();
    expect(readEventRefundToken(SECRET, token.replace('.41.', '.42.'))).toBeNull();
    expect(readEventRefundToken(SECRET, '')).toBeNull();
    expect(readEventRefundToken(SECRET, `${token}0`)).toBeNull();
  });

  it('no se confunde con el enlace de voto: cada uno firma con su propio propósito', async () => {
    const { signResizeVoteToken } = await import('@/core/resize/resize-rules');
    expect(readEventRefundToken(SECRET, signResizeVoteToken(SECRET, 3, 41))).toBeNull();
  });
});
