import { describe, expect, it } from 'vitest';
import { chooseEmail, EMAIL_GRACE_MS, EMAIL_MARGIN_MS, type MailFile } from '../e2e/email-pick';

const SINCE = 1_000_000;
const mail = (text: string, time: number): MailFile => ({ text, time });

describe('arnés E2E: qué email vale para una prueba', () => {
  it('un email posterior a «since» se devuelve al momento, aunque haya otro anterior dentro del margen', () => {
    // El código con el que se acaba de entrar (300 ms antes) y el que se pide ahora: manda el nuevo.
    expect(chooseEmail([mail('viejo', SINCE - 300), mail('nuevo', SINCE + 200)], SINCE, 0)).toBe('nuevo');
  });

  it('con solo un email del margen no se devuelve de inmediato: puede ser el código viejo que el servidor ya sustituyó', () => {
    expect(chooseEmail([mail('viejo', SINCE - 300)], SINCE, 0)).toBeNull();
    expect(chooseEmail([mail('viejo', SINCE - 300)], SINCE, EMAIL_GRACE_MS - 1)).toBeNull();
  });

  it('si en el plazo de gracia no llega otro, el del margen vale (la prueba tomó la hora justo después de pulsar)', () => {
    expect(chooseEmail([mail('pedido', SINCE - 300)], SINCE, EMAIL_GRACE_MS)).toBe('pedido');
    expect(chooseEmail([mail('a', SINCE - 900), mail('b', SINCE - 100)], SINCE, EMAIL_GRACE_MS)).toBe('b');
  });

  it('lo anterior al margen no cuenta nunca, y sin emails se sigue esperando', () => {
    expect(chooseEmail([mail('antiguo', SINCE - EMAIL_MARGIN_MS - 1)], SINCE, EMAIL_GRACE_MS * 10)).toBeNull();
    expect(chooseEmail([], SINCE, 0)).toBeNull();
  });

  it('entre varios posteriores, el último', () => {
    expect(chooseEmail([mail('primero', SINCE + 10), mail('segundo', SINCE + 900)], SINCE, 0)).toBe('segundo');
  });
});
