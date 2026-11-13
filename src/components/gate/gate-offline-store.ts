import type { GateList, LocalUse } from '@/core/ticketing/gate-offline';
import { OFFLINE_QUEUE_MAX } from '@/core/ticketing/gate-rules';
import { parsePassQrPayload } from '@/core/ticketing/qr-payload';

/**
 * Lo que un móvil de portería guarda para seguir validando sin cobertura: la lista de pases descargada (identificadores, plazas y huellas) y la cola de
 * lecturas aún sin enviar, **que incluye el contenido completo de cada QR leído (con su firma)**: hasta que se envíe vale como credencial para las plazas que le
 * queden al pase. Ningún dato personal. Lo guardado caduca a los 3 días. Vive en `localStorage` (no en una cookie: no viaja al servidor) y se borra al cerrar la portería. Si el
 * navegador lo bloquea o se llena, la portería sigue funcionando en línea y avisa de que sin red no podrá validar.
 */

export interface QueuedScan {
  clientScanId: string;
  payload: string;
  quantity: number;
  /** Milisegundos desde 1970 en el reloj del móvil. */
  scannedAt: number;
  serial: string;
}

export interface GateLocalState {
  list: GateList | null;
  queue: QueuedScan[];
  /** Cuándo se guardó (ms): lo de hace más de 3 días ya no vale (una sesión dura como mucho 48 h) y se descarta al leerlo. */
  savedAt?: number;
}

const STATE_MAX_AGE_MS = 3 * 86_400_000;

const storageKey = (eventId: number) => `korum-gate:${eventId}`;
export const emptyGateState = (): GateLocalState => ({ list: null, queue: [] });
/** Una sola instancia para el servidor y para el primer pintado del navegador: `useSyncExternalStore` exige que no cambie entre llamadas. */
const EMPTY: GateLocalState = emptyGateState();

/** Lo último escrito o leído de cada evento, para devolver el mismo objeto mientras no cambie (requisito de `useSyncExternalStore`). Si el almacenamiento falla, aquí queda la copia que sigue funcionando. */
const cache = new Map<number, { raw: string | null; state: GateLocalState }>();
const listeners = new Set<() => void>();

function parse(raw: string | null, eventId: number): GateLocalState {
  if (!raw) return EMPTY;
  try {
    const parsed = JSON.parse(raw) as Partial<GateLocalState>;
    if (typeof parsed.savedAt === 'number' && Date.now() - parsed.savedAt > STATE_MAX_AGE_MS) return EMPTY;
    return { list: parsed.list && parsed.list.eventId === eventId ? parsed.list : null, queue: Array.isArray(parsed.queue) ? parsed.queue.slice(0, OFFLINE_QUEUE_MAX) : [] };
  } catch {
    return EMPTY;
  }
}

function readRaw(eventId: number): string | null | undefined {
  try {
    return window.localStorage.getItem(storageKey(eventId));
  } catch {
    return undefined;
  }
}

/** Lo guardado en este móvil para ese evento (o lo último que se pudo escribir, si el navegador bloquea el almacenamiento). */
export function getGateStateSnapshot(eventId: number): GateLocalState {
  if (typeof window === 'undefined') return EMPTY;
  const raw = readRaw(eventId);
  const cached = cache.get(eventId);
  if (raw === undefined) return cached?.state ?? EMPTY;
  if (cached && cached.raw === raw) return cached.state;
  const state = parse(raw, eventId);
  cache.set(eventId, { raw, state });
  return state;
}

export const getGateServerSnapshot = (): GateLocalState => EMPTY;

export function subscribeGateState(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith('korum-gate:')) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** `false` si no se pudo guardar (almacenamiento bloqueado o lleno): sigue funcionando en esta pestaña y quien llama lo avisa en pantalla. */
export function writeGateState(eventId: number, state: GateLocalState): boolean {
  let saved = true;
  let raw: string | null = null;
  try {
    raw = JSON.stringify({ ...state, savedAt: Date.now() });
    window.localStorage.setItem(storageKey(eventId), raw);
  } catch {
    saved = false;
  }
  cache.set(eventId, { raw: saved ? raw : (cache.get(eventId)?.raw ?? null), state });
  listeners.forEach((listener) => listener());
  return saved;
}

export function clearGateState(eventId: number): void {
  cache.delete(eventId);
  try {
    window.localStorage.removeItem(storageKey(eventId));
  } catch {
    // Sin almacenamiento no hay nada que borrar.
  }
  listeners.forEach((listener) => listener());
}

/** Lo que este móvil ya ha dejado entrar sin red y aún no ha enviado, por pase: se suma a lo que dice la lista descargada. */
export function localUseOf(queue: readonly QueuedScan[]): Record<string, LocalUse> {
  const use: Record<string, LocalUse> = {};
  for (const scan of queue) {
    const uuid = parsePassQrPayload(scan.payload)?.passUuid;
    if (!uuid) continue;
    const current = use[uuid];
    use[uuid] = { count: (current?.count ?? 0) + scan.quantity, firstAt: current?.firstAt === null || current === undefined ? scan.scannedAt : Math.min(current.firstAt, scan.scannedAt) };
  }
  return use;
}

/**
 * El aforo que se muestra: lo que dice el servidor más las personas que este móvil ya dejó entrar sin red y aún no ha enviado (el servidor todavía no las cuenta).
 * Sin esto, una respuesta del latido que llega después de una lectura sin red hacía bajar el contador por debajo de la realidad.
 */
export function summaryWithQueued<T extends { checkedIn: number }>(summary: T, queue: readonly QueuedScan[]): T {
  return { ...summary, checkedIn: summary.checkedIn + queue.reduce((total, scan) => total + scan.quantity, 0) };
}

export function newClientScanId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
