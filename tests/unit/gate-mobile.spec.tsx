import { screen } from '@testing-library/react';
import jsQR from 'jsqr';
import QRCode from 'qrcode';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GateResultPanel, isRedOutcome } from '@/components/gate/gate-result-panel';
import { clearGateState, getGateStateSnapshot, localUseOf, writeGateState, type QueuedScan } from '@/components/gate/gate-offline-store';
import { RATE_LIMIT_PURGE_RULES } from '@/core/jobs/handlers/housekeeping';
import { decideOffline, digestSignature, type GateList, type ScanOutcome } from '@/core/ticketing/gate-offline';
import { gateNetwork } from '@/core/ticketing/gate-limits';
import { GATE_CODE_PATTERN, generateGateCode } from '@/core/ticketing/gate-code';
import { extraRoundLimits } from '@/core/ticketing/raffle-extra';
import { signatureDigest } from '@/core/ticketing/gate-list.service';
import { clampScanTime, gatePinExpiry, GATE_PIN_GRACE_MS, MAX_SCAN_AGE_MS, raffleOpensAt, scanInputSchema, syncBatchSchema } from '@/core/ticketing/gate-rules';
import { toScanOutcome } from '@/core/ticketing/gate-sync.service';
import { buildPassQrPayload, parsePassQrPayload, signPass } from '@/core/ticketing/qr-signature';
import { startOfDayInMadrid, madridIsoDate } from '@/core/studio/studio-draft';
import { GATE_BLOCK_NOTICE_RULE, GATE_ENTRY_RULE, GATE_REJECTED_NOTICE_RULE, GATE_REQUEST_RULE } from '@/lib/rate-limit-rules';
import { renderWithIntl } from '../utils/render-with-intl';

const SECRET = 'secreto-de-pruebas-de-la-porteria-0123456789';
const UUID = '0d3c6b0e-5b4a-4a52-9d5e-6c6b8b1f2a11';

describe('Fecha del evento: PIN y sorteo (QA-SEC09)', () => {
  it('el PIN caduca 6 horas después de la fecha del evento', () => {
    const end = new Date('2026-12-05T22:59:00Z');
    expect(gatePinExpiry(end).getTime() - end.getTime()).toBe(GATE_PIN_GRACE_MS);
    expect(GATE_PIN_GRACE_MS).toBe(6 * 3_600_000);
  });

  it('el día empieza a las 00:00 de España, también en los días de cambio de hora', () => {
    expect(startOfDayInMadrid('2026-12-05')?.toISOString()).toBe('2026-12-04T23:00:00.000Z');
    expect(startOfDayInMadrid('2026-07-15')?.toISOString()).toBe('2026-07-14T22:00:00.000Z');
    // Cambio a la hora de verano (29-3-2026, a las 02:00): la medianoche aún es de invierno.
    expect(startOfDayInMadrid('2026-03-29')?.toISOString()).toBe('2026-03-28T23:00:00.000Z');
    // Cambio a la hora de invierno (25-10-2026, a las 03:00): la medianoche aún es de verano.
    expect(startOfDayInMadrid('2026-10-25')?.toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(startOfDayInMadrid('2026-02-30')).toBeNull();
    expect(startOfDayInMadrid('no es una fecha')).toBeNull();
  });

  it('el sorteo se abre el día del evento, aunque la fecha límite sea el final de ese día', () => {
    const endOfDay = new Date('2026-12-05T22:59:00Z');
    expect(madridIsoDate(endOfDay)).toBe('2026-12-05');
    expect(raffleOpensAt(endOfDay).toISOString()).toBe('2026-12-04T23:00:00.000Z');
    // Una fecha límite a medianoche UTC también cae en el mismo día de España.
    expect(raffleOpensAt(new Date('2026-12-05T10:00:00Z')).toISOString()).toBe('2026-12-04T23:00:00.000Z');
  });
});

describe('Lecturas sin red: validación y hora', () => {
  it('la hora de una lectura se acota entre la apertura de la sesión y ahora, y no es de hace más de 48 h', () => {
    const now = new Date('2026-12-05T20:00:00Z');
    const opened = new Date('2026-12-05T18:00:00Z');
    expect(clampScanTime(now.getTime() + 600_000, now, opened)).toEqual(now);
    expect(clampScanTime(opened.getTime() - 600_000, now, opened)).toEqual(opened);
    expect(clampScanTime(Date.parse('2026-12-05T19:00:00Z'), now, opened).toISOString()).toBe('2026-12-05T19:00:00.000Z');
    // Una sesión muy antigua no deja retroceder más de 48 h.
    const ancient = new Date(now.getTime() - 10 * 86_400_000);
    expect(clampScanTime(0, now, ancient).getTime()).toBe(now.getTime() - MAX_SCAN_AGE_MS);
  });

  it('el lote de lecturas valida el formato, el tamaño y los identificadores', () => {
    const scan = { clientScanId: 'abcd1234-efgh', payload: 'korum://v1/pass/x', quantity: 2, scannedAt: 1_700_000_000_000 };
    expect(syncBatchSchema.safeParse({ scans: [scan] }).success).toBe(true);
    expect(syncBatchSchema.safeParse({ scans: [] }).success).toBe(false);
    expect(syncBatchSchema.safeParse({ scans: Array.from({ length: 101 }, () => scan) }).success).toBe(false);
    expect(syncBatchSchema.safeParse({ scans: [{ ...scan, clientScanId: 'corto' }] }).success).toBe(false);
    expect(syncBatchSchema.safeParse({ scans: [{ ...scan, quantity: 0 }] }).success).toBe(false);
    expect(syncBatchSchema.safeParse({ scans: [{ ...scan, quantity: 51 }] }).success).toBe(false);
    expect(syncBatchSchema.safeParse({ scans: [{ ...scan, payload: 'x'.repeat(201) }] }).success).toBe(false);
    expect(scanInputSchema.safeParse({ payload: 'x', quantity: 'ASK' }).success).toBe(true);
    expect(scanInputSchema.safeParse({ payload: 'x', quantity: 'TODOS' }).success).toBe(false);
    expect(scanInputSchema.safeParse({ payload: 'x', quantity: 1.5 }).success).toBe(false);
  });

  it('la huella de la firma es la misma en el servidor y en el móvil, y la lista nunca lleva la firma', async () => {
    const signature = signPass(SECRET, UUID);
    expect(await digestSignature(signature)).toBe(signatureDigest(signature));
    expect(signatureDigest(signature)).toHaveLength(22);
    expect(signatureDigest(signature)).not.toContain(signature.slice(0, 10));
    expect(parsePassQrPayload(buildPassQrPayload(SECRET, UUID))).toEqual({ passUuid: UUID, signature });
  });

  it('decide como el servidor: elegir cuántas entran, parcial, agotado y firma falsa', async () => {
    const signature = signPass(SECRET, UUID);
    const payload = buildPassQrPayload(SECRET, UUID);
    const list: GateList = { eventId: 7, generatedAt: 1, passes: [{ u: UUID, q: 4, c: 1, h: signatureDigest(signature) }] };
    expect(await decideOffline(list, {}, payload, 'ASK')).toMatchObject({ status: 'CHOOSE', remaining: 3, quantity: 4 });
    expect(await decideOffline(list, {}, payload, 3)).toMatchObject({ status: 'ACCEPTED', entered: 3, remaining: 0 });
    expect(await decideOffline(list, { [UUID]: { count: 2, firstAt: 5 } }, payload, 'ASK')).toMatchObject({ status: 'ACCEPTED', entered: 1, remaining: 0 });
    expect(await decideOffline(list, { [UUID]: { count: 3, firstAt: 5 } }, payload, 'ASK')).toEqual({ status: 'EXHAUSTED', quantity: 4, firstAccessAt: 5 });
    expect(await decideOffline(list, {}, payload, 4)).toEqual({ status: 'INSUFFICIENT', remaining: 3, quantity: 4, firstAccessAt: null });
    expect(await decideOffline({ ...list, passes: [{ ...list.passes[0]!, h: 'otra-huella-distinta-xx' }] }, {}, payload, 'ASK')).toEqual({ status: 'UNKNOWN' });
    expect(await decideOffline({ ...list, passes: [] }, {}, payload, 'ASK')).toEqual({ status: 'UNKNOWN' });
  });

  it('las fechas de las respuestas del servidor viajan como milisegundos', () => {
    const at = new Date('2026-12-05T20:15:00Z');
    expect(toScanOutcome({ status: 'EXHAUSTED', quantity: 2, firstAccessAt: at })).toEqual({ status: 'EXHAUSTED', quantity: 2, firstAccessAt: at.getTime() });
    expect(toScanOutcome({ status: 'INSUFFICIENT', remaining: 1, quantity: 2, firstAccessAt: null })).toEqual({ status: 'INSUFFICIENT', remaining: 1, quantity: 2, firstAccessAt: null });
    expect(toScanOutcome({ status: 'ACCEPTED', entered: 1, remaining: 0, quantity: 1, serialCode: '#PASE-2026-0001' })).toMatchObject({ serial: '#PASE-2026-0001' });
    expect(toScanOutcome({ status: 'INVALID_SIGNATURE' })).toEqual({ status: 'INVALID_SIGNATURE' });
  });
});

describe('Lector de respaldo (iOS)', () => {
  it('jsQR lee el QR firmado de un pase, que es lo que usa Safari al no tener BarcodeDetector', () => {
    const payload = buildPassQrPayload(SECRET, UUID);
    const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' });
    const modules = qr.modules.size;
    const scale = 6;
    const quiet = 4;
    const size = (modules + quiet * 2) * scale;
    const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
    for (let row = 0; row < modules; row += 1) {
      for (let column = 0; column < modules; column += 1) {
        if (!qr.modules.get(row, column)) continue;
        for (let y = 0; y < scale; y += 1) {
          for (let x = 0; x < scale; x += 1) {
            const index = (((row + quiet) * scale + y) * size + (column + quiet) * scale + x) * 4;
            pixels[index] = 0;
            pixels[index + 1] = 0;
            pixels[index + 2] = 0;
          }
        }
      }
    }
    expect(jsQR(pixels, size, size, { inversionAttempts: 'dontInvert' })?.data).toBe(payload);
  });
});

describe('Lo que guarda el móvil', () => {
  const scan = (quantity: number, scannedAt: number): QueuedScan => ({ clientScanId: `lectura-${scannedAt}`, payload: buildPassQrPayload(SECRET, UUID), quantity, scannedAt, serial: UUID.slice(0, 8) });

  beforeEach(() => {
    window.localStorage.clear();
    clearGateState(7);
  });

  it('suma lo leído sin enviar por pase y guarda la primera hora', () => {
    expect(localUseOf([scan(1, 300), scan(2, 100)])).toEqual({ [UUID]: { count: 3, firstAt: 100 } });
    expect(localUseOf([])).toEqual({});
  });

  it('guarda y recupera la cola de un evento, sin mezclarla con la de otro, y devuelve el mismo objeto mientras no cambie', () => {
    const state = { list: { eventId: 7, generatedAt: 5, passes: [] }, queue: [scan(1, 100)] };
    expect(writeGateState(7, state)).toBe(true);
    expect(getGateStateSnapshot(7)).toBe(getGateStateSnapshot(7));
    expect(getGateStateSnapshot(7).queue).toHaveLength(1);
    expect(getGateStateSnapshot(8).queue).toHaveLength(0);
    clearGateState(7);
    expect(getGateStateSnapshot(7).queue).toHaveLength(0);
  });

  it('si el navegador no deja guardar, sigue funcionando en memoria y avisa', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('lleno', 'QuotaExceededError');
    });
    try {
      expect(writeGateState(7, { list: null, queue: [scan(1, 100)] })).toBe(false);
      expect(getGateStateSnapshot(7).queue).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('un contenido guardado que no es válido se ignora', () => {
    window.localStorage.setItem('korum-gate:9', '{no es json');
    expect(getGateStateSnapshot(9)).toEqual({ list: null, queue: [] });
    window.localStorage.setItem('korum-gate:9', JSON.stringify({ list: { eventId: 10, generatedAt: 1, passes: [] }, queue: 'mal' }));
    expect(getGateStateSnapshot(9)).toEqual({ list: null, queue: [] });
  });
});

describe('Red de una petición (QA-SEC09)', () => {
  it('una IPv4 es ella misma y en IPv6 cuenta el prefijo /64: quien cambia de dirección dentro de su bloque sigue siendo la misma red', () => {
    expect(gateNetwork('203.0.113.7')).toBe('203.0.113.7');
    expect(gateNetwork('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(gateNetwork('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe(gateNetwork('2001:db8:1:2::1'));
    expect(gateNetwork('2001:db8:1:2::1')).not.toBe(gateNetwork('2001:db8:1:3::1'));
    expect(gateNetwork('2001:db8:1:2::1%eth0')).toBe(gateNetwork('2001:db8:1:2::1'));
    expect(gateNetwork('no es una ip')).toBeNull();
  });

  it('lo guardado en el móvil caduca a los 3 días', () => {
    const queued = (id: string) => [{ clientScanId: id, payload: 'x', quantity: 1, scannedAt: 1, serial: 'x' }];
    window.localStorage.setItem('korum-gate:11', JSON.stringify({ list: null, queue: queued('lectura-vieja-1'), savedAt: Date.now() - 4 * 86_400_000 }));
    expect(getGateStateSnapshot(11).queue).toHaveLength(0);
    window.localStorage.setItem('korum-gate:12', JSON.stringify({ list: null, queue: queued('lectura-nueva-1'), savedAt: Date.now() - 86_400_000 }));
    expect(getGateStateSnapshot(12).queue).toHaveLength(1);
  });
});

describe('Ronda extra: límites', () => {
  const base = { prizeCount: 3, ordinaryDrawn: 3, extraDrawn: 0, replaceable: 3, replaceableRefunded: 0, entriesLeft: 10 };

  it('nunca más extras que premios, que premios normales sorteados, que números sin sustituir ni que papeletas libres; el reembolso exige un ganador reembolsado sin sustituir', () => {
    expect(extraRoundLimits(base)).toEqual({ PRIZE_UNCLAIMED: 3, WINNER_REFUNDED: 0 });
    expect(extraRoundLimits({ ...base, ordinaryDrawn: 2, replaceable: 2 })).toEqual({ PRIZE_UNCLAIMED: 2, WINNER_REFUNDED: 0 });
    expect(extraRoundLimits({ ...base, extraDrawn: 1, replaceable: 2 })).toEqual({ PRIZE_UNCLAIMED: 2, WINNER_REFUNDED: 0 });
    expect(extraRoundLimits({ ...base, entriesLeft: 1 })).toEqual({ PRIZE_UNCLAIMED: 1, WINNER_REFUNDED: 0 });
    expect(extraRoundLimits({ ...base, replaceableRefunded: 2 })).toEqual({ PRIZE_UNCLAIMED: 3, WINNER_REFUNDED: 2 });
    expect(extraRoundLimits({ ...base, replaceableRefunded: 3, extraDrawn: 2, replaceable: 1 })).toEqual({ PRIZE_UNCLAIMED: 1, WINNER_REFUNDED: 1 });
    expect(extraRoundLimits({ ...base, extraDrawn: 3, replaceable: 0 })).toEqual({ PRIZE_UNCLAIMED: 0, WINNER_REFUNDED: 0 });
    expect(extraRoundLimits({ ...base, entriesLeft: 0 })).toEqual({ PRIZE_UNCLAIMED: 0, WINNER_REFUNDED: 0 });
  });

  it('el código de la puerta tiene 10 caracteres en base 32, no se repite y es el único formato aceptado', () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateGateCode()));
    expect(codes.size).toBe(500);
    for (const code of codes) expect(code).toMatch(GATE_CODE_PATTERN);
    for (const bad of ['', 'abcdefghij1', 'ABCDEFGHIJ', 'abcdefghi', 'abcdefghijk', 'abcd1fghij', '../..//abc', '2']) expect(GATE_CODE_PATTERN.test(bad), bad).toBe(false);
  });
});

describe('Límites de la portería', () => {
  it('cada contador con ventana de la portería se purga en la limpieza diaria', () => {
    expect(RATE_LIMIT_PURGE_RULES).toEqual(expect.arrayContaining([GATE_ENTRY_RULE, GATE_REQUEST_RULE, GATE_BLOCK_NOTICE_RULE, GATE_REJECTED_NOTICE_RULE]));
    expect(GATE_ENTRY_RULE).toMatchObject({ limit: 60, windowMs: 15 * 60_000 });
    expect(GATE_BLOCK_NOTICE_RULE.limit).toBe(1);
    expect(GATE_REJECTED_NOTICE_RULE).toMatchObject({ limit: 1, windowMs: 6 * 3_600_000 });
    const prefixes = [GATE_ENTRY_RULE, GATE_REQUEST_RULE, GATE_BLOCK_NOTICE_RULE, GATE_REJECTED_NOTICE_RULE].map((rule) => rule.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});

describe('Resultado de una lectura en pantalla', () => {
  const noop = () => undefined;

  it('una alerta roja se anuncia al momento, dice la hora del primer acceso y no deja entrar', () => {
    renderWithIntl(<GateResultPanel outcome={{ status: 'EXHAUSTED', quantity: 4, firstAccessAt: Date.parse('2026-12-05T20:15:00Z') }} serial={null} offline={false} onNext={noop} onChoose={noop} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('data-outcome', 'EXHAUSTED');
    expect(screen.getByRole('heading', { name: /ALERTA ROJA: PASE YA UTILIZADO/ })).toBeInTheDocument();
    expect(alert).toHaveTextContent(/Primer acceso a las \d{1,2}:\d{2}/);
    expect(screen.getByRole('button', { name: 'Siguiente pase' })).toBeInTheDocument();
  });

  it('una firma inválida es roja y un pase bueno es verde con lo que queda por entrar', () => {
    const { unmount } = renderWithIntl(<GateResultPanel outcome={{ status: 'INVALID_SIGNATURE' }} serial={null} offline={false} onNext={noop} onChoose={noop} />);
    expect(screen.getByRole('alert')).toHaveTextContent('FIRMA INVÁLIDA');
    unmount();
    renderWithIntl(<GateResultPanel outcome={{ status: 'ACCEPTED', entered: 2, remaining: 2, quantity: 4, serial: '#PASE-2026-0001' }} serial="#PASE-2026-0001" offline={false} onNext={noop} onChoose={noop} />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Entran 2 · pase de 4 · quedan 2 por entrar');
    expect(screen.getByText('#PASE-2026-0001')).toBeInTheDocument();
  });

  it('con varias plazas pregunta cuántas entran, sube y baja de uno en uno y no pasa de las que quedan', async () => {
    const onChoose = vi.fn();
    renderWithIntl(<GateResultPanel outcome={{ status: 'CHOOSE', remaining: 3, quantity: 4, serial: '#PASE-2026-0002' }} serial="#PASE-2026-0002" offline={false} onNext={noop} onChoose={onChoose} />);
    const user = userEvent.setup();
    expect(screen.getByTestId('gate-people')).toHaveTextContent('3');
    expect(screen.getByRole('button', { name: 'Una persona más' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Una persona menos' }));
    expect(screen.getByTestId('gate-people')).toHaveTextContent('2');
    await user.click(screen.getByRole('button', { name: 'Dejar entrar a 2 personas' }));
    expect(onChoose).toHaveBeenCalledWith(2);
  });

  it('sin red avisa de que la lectura queda guardada en el móvil', () => {
    renderWithIntl(<GateResultPanel outcome={{ status: 'ACCEPTED', entered: 1, remaining: 0, quantity: 1, serial: 'abcd1234' }} serial="abcd1234" offline onNext={noop} onChoose={noop} />);
    expect(screen.getByText(/Guardado en este móvil/)).toBeInTheDocument();
  });

  it('solo es roja la que no deja entrar: lo que pide decidir o comprobar no lo es', () => {
    const red: ScanOutcome['status'][] = ['EXHAUSTED', 'INSUFFICIENT', 'INVALID_SIGNATURE', 'OTHER_EVENT', 'REVOKED', 'NOT_PAID', 'NOT_APPLICABLE', 'EVENT_CLOSED', 'INVALID_FORMAT'];
    for (const status of red) expect(isRedOutcome({ status } as ScanOutcome), status).toBe(true);
    expect(isRedOutcome({ status: 'UNKNOWN' })).toBe(false);
    expect(isRedOutcome({ status: 'CHOOSE', remaining: 2, quantity: 2, serial: 'x' })).toBe(false);
    expect(isRedOutcome({ status: 'ACCEPTED', entered: 1, remaining: 0, quantity: 1, serial: 'x' })).toBe(false);
  });
});
