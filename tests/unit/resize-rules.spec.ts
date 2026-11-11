import { describe, expect, it } from 'vitest';
import { bpsOf } from '@/core/finance/money';
import { calculatePublicBreakdown4Lines } from '@/core/finance/tco.service';
import { resizedFigures } from '@/core/resize/resize-figures';
import {
  castResizeVoteSchema,
  hasDuplicateOptions,
  launchResizeVoteSchema,
  parsePollOptions,
  pollClosesAt,
  readResizeVoteToken,
  RESIZE_MIN_WINDOW_DAYS,
  resizeVoteBlockers,
  signResizeVoteToken,
  tallyResizeVotes,
  windowDaysLeft
} from '@/core/resize/resize-rules';

/**
 * Sprint 4.4b · Reglas puras de las campañas vencidas: el recuento (los votos de devolución no compiten; sin votos o con empate, reembolso), las cifras de
 * la campaña redimensionada (comisión proporcional hacia abajo y 4 líneas que suman la meta, con 1.000 casos aleatorios), el enlace firmado, qué impide
 * votar y la validación de lo que llega del navegador.
 */

const SECRET = 'secreto-de-pruebas-unitarias-del-redimensionamiento';
const DAY = 86_400_000;

describe('recuento de la votación', () => {
  const option = (index: number) => ({ optionIndex: index, wantsRefund: false });
  const refund = { optionIndex: null, wantsRefund: true };

  it('gana la opción de proyecto más votada aunque haya más devoluciones que votos', () => {
    expect(tallyResizeVotes([option(1), option(1), option(0), refund, refund, refund], 2)).toEqual({ counts: [1, 2], refundVotes: 3, outcome: 'PROJECT', winningOptionIndex: 1 });
  });

  it('sin votos de proyecto o con empate no gana nadie', () => {
    expect(tallyResizeVotes([], 3)).toMatchObject({ outcome: 'NO_VOTES', winningOptionIndex: null });
    expect(tallyResizeVotes([refund, refund], 2)).toMatchObject({ outcome: 'NO_VOTES', refundVotes: 2 });
    expect(tallyResizeVotes([option(0), option(1), option(2), option(2), option(0)], 3)).toMatchObject({ outcome: 'TIE', counts: [2, 1, 2], winningOptionIndex: null });
  });

  it('un voto a una opción que no existe no cuenta', () => {
    expect(tallyResizeVotes([option(5), option(-1), option(0)], 2)).toMatchObject({ counts: [1, 0], winningOptionIndex: 0 });
  });
});

describe('cifras de una campaña redimensionada', () => {
  const base = { originalGoalCents: 20_000, bracketFeeCents: 1_000, maintFeeCents: 500, gatewayFeeCents: 900, costMatCents: 12_000, costInstCents: 4_000, contingencyBps: 1_000 };

  it('al 35 %: comisiones proporcionales hacia abajo y las 4 líneas suman la meta nueva', () => {
    const figures = resizedFigures({ ...base, newGoalCents: 7_000 });
    expect(figures).toMatchObject({ goalCents: 7_000, bracketFeeCents: 350, maintFeeCents: 175, gatewayFeeCents: 315 });
    const lines = calculatePublicBreakdown4Lines({ ...figures, contingencyBps: base.contingencyBps });
    expect(lines.line1ProviderCents + lines.line2InstallCents + lines.line3ContingencyCents + lines.line4EscrowAndGuaranteeCents).toBe(7_000);
    expect(lines.line4EscrowAndGuaranteeCents).toBe(figures.line4Cents);
  });

  it('con la meta entera no cambia nada y no acepta una meta mayor, nula o negativa', () => {
    expect(resizedFigures({ ...base, newGoalCents: 20_000 })).toMatchObject({ bracketFeeCents: 1_000, maintFeeCents: 500, gatewayFeeCents: 900, costMatCents: 12_000, costInstCents: 4_000, line4Cents: 2_400 });
    expect(() => resizedFigures({ ...base, newGoalCents: 20_001 })).toThrow(RangeError);
    expect(() => resizedFigures({ ...base, newGoalCents: 0 })).toThrow(RangeError);
    expect(() => resizedFigures({ ...base, newGoalCents: -5 })).toThrow(RangeError);
    expect(() => resizedFigures({ ...base, newGoalCents: 1.5 })).toThrow(RangeError);
  });

  it('1.000 campañas aleatorias: cuadra al céntimo, la comisión nunca supera la proporción y a la entidad le queda al menos su parte', () => {
    let seed = 20261111;
    const random = (max: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % (max + 1);
    };
    for (let round = 0; round < 1_000; round += 1) {
      const costMatCents = random(5_000_000);
      const costInstCents = random(1_000_000);
      const contingencyBps = random(3_000);
      const execution = costMatCents + costInstCents;
      const contingency = bpsOf(execution, contingencyBps);
      const bracketFeeCents = random(500_000);
      const maintFeeCents = random(15_000);
      const raw = execution + contingency + bracketFeeCents + maintFeeCents + random(200_000);
      const originalGoalCents = Math.max(100, Math.ceil(raw / 100) * 100);
      const gatewayFeeCents = originalGoalCents - execution - contingency - bracketFeeCents - maintFeeCents;
      const newGoalCents = 1 + random(originalGoalCents - 1);
      const figures = resizedFigures({ originalGoalCents, newGoalCents, bracketFeeCents, maintFeeCents, gatewayFeeCents, costMatCents, costInstCents, contingencyBps });
      const fees = figures.bracketFeeCents + figures.maintFeeCents + figures.gatewayFeeCents;
      // Proporción exacta con enteros: comisión nueva × meta original ≤ comisión original × meta nueva.
      expect(BigInt(fees) * BigInt(originalGoalCents) <= BigInt(bracketFeeCents + maintFeeCents + gatewayFeeCents) * BigInt(newGoalCents)).toBe(true);
      const lines = calculatePublicBreakdown4Lines({ costMatCents: figures.costMatCents, costInstCents: figures.costInstCents, contingencyBps, goalCents: figures.goalCents });
      expect(lines.line1ProviderCents + lines.line2InstallCents + lines.line3ContingencyCents + lines.line4EscrowAndGuaranteeCents).toBe(newGoalCents);
      // La línea 4 cubre las comisiones nuevas y, como mucho, un céntimo del redondeo de la reserva.
      expect(lines.line4EscrowAndGuaranteeCents - fees).toBeGreaterThanOrEqual(0);
      expect(lines.line4EscrowAndGuaranteeCents - fees).toBeLessThanOrEqual(1);
      for (const value of Object.values(figures)) expect(Number.isSafeInteger(value) && value >= 0).toBe(true);
    }
  });
});

describe('enlace personal de voto', () => {
  it('firma la votación y la donación; cualquier cambio lo invalida', () => {
    const token = signResizeVoteToken(SECRET, 12, 3_456);
    expect(readResizeVoteToken(SECRET, token)).toEqual({ pollId: 12, contributionId: 3_456 });
    expect(readResizeVoteToken('otro-secreto-distinto-de-pruebas-unitarias', token)).toBeNull();
    expect(readResizeVoteToken(SECRET, token.replace(/^12\./, '13.'))).toBeNull();
    expect(readResizeVoteToken(SECRET, token.replace('.3456.', '.3457.'))).toBeNull();
    expect(readResizeVoteToken(SECRET, `${token}0`)).toBeNull();
    expect(readResizeVoteToken(SECRET, 'basura')).toBeNull();
    expect(readResizeVoteToken(SECRET, `0.1.${'a'.repeat(64)}`)).toBeNull();
  });
});

describe('qué impide lanzar la votación', () => {
  const now = new Date('2026-11-20T10:00:00Z');
  it('solo presupuesto, con donaciones, una sola vez y con margen en la ventana de 90 días', () => {
    const ok = { format: 'BUDGET', firstPayinAt: new Date(now.getTime() - 40 * DAY), donations: 3, hasPoll: false };
    expect(resizeVoteBlockers(ok, now)).toEqual([]);
    expect(resizeVoteBlockers({ ...ok, format: 'TICKETING' }, now)).toEqual(['NOT_BUDGET']);
    expect(resizeVoteBlockers({ ...ok, donations: 0 }, now)).toEqual(['NO_DONATIONS']);
    expect(resizeVoteBlockers({ ...ok, hasPoll: true }, now)).toEqual(['POLL_EXISTS']);
    expect(resizeVoteBlockers({ ...ok, firstPayinAt: new Date(now.getTime() - (90 - RESIZE_MIN_WINDOW_DAYS) * DAY) }, now)).toEqual([]);
    expect(resizeVoteBlockers({ ...ok, firstPayinAt: new Date(now.getTime() - (91 - RESIZE_MIN_WINDOW_DAYS) * DAY) }, now)).toEqual(['WINDOW_TOO_SHORT']);
    expect(windowDaysLeft(new Date(now.getTime() - 100 * DAY), now)).toBe(0);
    expect(pollClosesAt(now).toISOString()).toBe('2026-11-27T10:00:00.000Z');
  });
});

describe('lo que llega del navegador', () => {
  it('2 a 4 opciones de 10 a 160 caracteres, limpias de caracteres de control; opciones repetidas se detectan', () => {
    expect(launchResizeVoteSchema.parse({ initiativeId: 5, options: ['  Comprar\u0007 14 tablets  ', 'Comprar‮ 10 tablets y armario'] }).options).toEqual(['Comprar 14 tablets', 'Comprar 10 tablets y armario']);
    expect(launchResizeVoteSchema.safeParse({ initiativeId: 5, options: ['Una sola opción larga'] }).success).toBe(false);
    expect(launchResizeVoteSchema.safeParse({ initiativeId: 5, options: ['corta', 'Otra opción válida'] }).success).toBe(false);
    expect(launchResizeVoteSchema.safeParse({ initiativeId: 5, options: Array.from({ length: 5 }, (_, index) => `Opción número ${index}`) }).success).toBe(false);
    expect(launchResizeVoteSchema.safeParse({ initiativeId: 5, options: ['Opción número uno', 'Opción número dos'], extra: true }).success).toBe(false);
    expect(hasDuplicateOptions(['Comprar 14 tablets', 'comprar  14 TABLETS'])).toBe(true);
    expect(hasDuplicateOptions(['Comprar 14 tablets', 'Comprar 10 tablets'])).toBe(false);
  });

  it('un voto es una opción (0 a 3) o la devolución, sin campos de más', () => {
    const token = signResizeVoteToken(SECRET, 1, 2);
    expect(castResizeVoteSchema.safeParse({ orgSlug: 'ceip', token, choice: { kind: 'REFUND' } }).success).toBe(true);
    expect(castResizeVoteSchema.safeParse({ orgSlug: 'ceip', token, choice: { kind: 'OPTION', index: 3 } }).success).toBe(true);
    expect(castResizeVoteSchema.safeParse({ orgSlug: 'ceip', token, choice: { kind: 'OPTION', index: 4 } }).success).toBe(false);
    expect(castResizeVoteSchema.safeParse({ orgSlug: 'ceip', token, choice: { kind: 'REFUND', index: 0 } }).success).toBe(false);
    expect(castResizeVoteSchema.safeParse({ orgSlug: 'ceip', token, choice: { kind: 'OPTION', index: 0 }, amountCents: 1 }).success).toBe(false);
  });

  it('las opciones guardadas se leen solo si son una lista de textos', () => {
    expect(parsePollOptions(['A opción', 'B opción'])).toEqual(['A opción', 'B opción']);
    expect(parsePollOptions({ a: 1 })).toEqual([]);
    expect(parsePollOptions([1, 2])).toEqual([]);
  });
});
