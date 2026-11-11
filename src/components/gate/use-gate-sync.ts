'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { gateSummaryAction, loadGateListAction, syncScansAction, type GateSummaryView } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/porteria/scan-actions';
import { decideOffline, type ScanOutcome } from '@/core/ticketing/gate-offline';
import { OFFLINE_QUEUE_MAX, SYNC_BATCH_MAX } from '@/core/ticketing/gate-rules';
import { getGateServerSnapshot, getGateStateSnapshot, localUseOf, subscribeGateState, writeGateState, type GateLocalState, type QueuedScan } from './gate-offline-store';

/**
 * Lista descargada, cola de lecturas sin enviar y sincronización de un móvil de portería (QA-S04). Con red, cada minuto refresca la lista y cada 10 s el
 * aforo; sin ella, valida contra la última lista y guarda lo leído. Al volver la red envía la cola por lotes y deja los conflictos a la vista. Una acción
 * que falla por la red marca el móvil como «sin conexión» aunque el navegador crea que la tiene (wifi sin Internet).
 */

export interface SyncConflict {
  clientScanId: string;
  serial: string;
  outcome: ScanOutcome;
}

const TICK_MS = 10_000;
const LIST_EVERY_TICKS = 6;

/** Lo que dice el navegador sobre la conexión; el servidor y el primer pintado suponen que hay. */
const subscribeConnection = (listener: () => void) => {
  window.addEventListener('online', listener);
  window.addEventListener('offline', listener);
  return () => {
    window.removeEventListener('online', listener);
    window.removeEventListener('offline', listener);
  };
};

export function useGateSync(eventId: number, onSummary: (summary: GateSummaryView) => void, onEnded: () => void) {
  // Lo guardado en este móvil (lista y cola) vive en `localStorage`; el estado lee de ahí, sin copiarlo a mano al montar.
  const state = useSyncExternalStore(subscribeGateState, () => getGateStateSnapshot(eventId), getGateServerSnapshot);
  const browserOnline = useSyncExternalStore(subscribeConnection, () => navigator.onLine, () => true);
  // El navegador puede creer que tiene red (wifi sin Internet): un fallo de una petición marca el móvil como «sin conexión» hasta que una vuelve a ir bien.
  const [unreachable, setUnreachable] = useState(false);
  const online = browserOnline && !unreachable;
  const [syncing, setSyncing] = useState(false);
  const [storageOk, setStorageOk] = useState(true);
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const syncingRef = useRef(false);
  const callbacks = useRef({ onSummary, onEnded });
  const setOnline = useCallback((value: boolean) => setUnreachable(!value), []);

  useEffect(() => {
    callbacks.current = { onSummary, onEnded };
  }, [onSummary, onEnded]);

  const current = useCallback(() => getGateStateSnapshot(eventId), [eventId]);
  const commit = useCallback(
    (next: GateLocalState) => {
      setStorageOk(writeGateState(eventId, next));
    },
    [eventId]
  );

  const refreshList = useCallback(async () => {
    try {
      const result = await loadGateListAction(eventId);
      if (result.status === 'OK') {
        commit({ ...current(), list: result.list });
        callbacks.current.onSummary(result.summary);
        setOnline(true);
      } else if (result.reason === 'NO_SESSION') callbacks.current.onEnded();
    } catch {
      setOnline(false);
    }
  }, [commit, current, eventId, setOnline]);

  const sync = useCallback(async () => {
    if (syncingRef.current || current().queue.length === 0) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      while (current().queue.length > 0) {
        const batch = current().queue.slice(0, SYNC_BATCH_MAX);
        const result = await syncScansAction(eventId, { scans: batch.map(({ clientScanId, payload, quantity, scannedAt }) => ({ clientScanId, payload, quantity, scannedAt })), listGeneratedAt: current().list?.generatedAt });
        if (result.status === 'ERROR') {
          if (result.reason === 'NO_SESSION') callbacks.current.onEnded();
          break;
        }
        const done = new Set(result.results.map((item) => item.clientScanId));
        const failed: SyncConflict[] = result.results
          .filter((item) => item.outcome.status !== 'ACCEPTED' && item.outcome.status !== 'DUPLICATE_SCAN')
          .map((item) => ({ clientScanId: item.clientScanId, serial: batch.find((scan) => scan.clientScanId === item.clientScanId)?.serial ?? '', outcome: item.outcome }));
        if (failed.length > 0) setConflicts((known) => [...known, ...failed]);
        commit({ ...current(), queue: current().queue.filter((scan) => !done.has(scan.clientScanId)) });
        if (result.ended) {
          callbacks.current.onEnded();
          break;
        }
        callbacks.current.onSummary(result.summary);
        setOnline(true);
        if (done.size === 0) break;
      }
    } catch {
      setOnline(false);
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [commit, current, eventId, setOnline]);

  // Al abrir la portería (y al volver la red) descarga la lista y envía lo que hubiera pendiente.
  useEffect(() => {
    // En un temporizador, no en el cuerpo del efecto: la descarga cambia el estado y no debe hacerlo mientras React aún pinta.
    const timer = setTimeout(() => {
      if (navigator.onLine) void refreshList().then(sync);
    }, 0);
    return () => clearTimeout(timer);
  }, [refreshList, sync]);

  useEffect(() => {
    const goOnline = () => {
      setUnreachable(false);
      void refreshList().then(sync);
    };
    window.addEventListener('online', goOnline);
    return () => window.removeEventListener('online', goOnline);
  }, [refreshList, sync]);

  // Latido: envía lo pendiente, refresca el aforo y, cada minuto, la lista. Si estaba «sin conexión» por un fallo de red, este intento la recupera.
  useEffect(() => {
    let ticks = 0;
    const timer = setInterval(() => {
      if (!navigator.onLine) return;
      ticks += 1;
      void (async () => {
        if (current().queue.length > 0) await sync();
        if (ticks % LIST_EVERY_TICKS === 0) {
          await refreshList();
          return;
        }
        try {
          const result = await gateSummaryAction(eventId);
          if (result.status === 'OK') {
            callbacks.current.onSummary(result.summary);
            setOnline(true);
          } else if (result.reason === 'NO_SESSION') callbacks.current.onEnded();
        } catch {
          setOnline(false);
        }
      })();
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [current, eventId, refreshList, setOnline, sync]);

  const decide = useCallback((payload: string, quantity: number | 'ASK'): Promise<ScanOutcome> => {
    const { list, queue } = current();
    return list ? decideOffline(list, localUseOf(queue), payload, quantity) : Promise.resolve<ScanOutcome>({ status: 'UNKNOWN' });
  }, [current]);

  /** Guarda una lectura admitida sin red para enviarla al volver. `false` si la cola está llena. */
  const enqueue = useCallback(
    (scan: QueuedScan): boolean => {
      if (current().queue.length >= OFFLINE_QUEUE_MAX) return false;
      commit({ ...current(), queue: [...current().queue, scan] });
      return true;
    },
    [commit, current]
  );

  const dismissConflicts = useCallback(() => setConflicts([]), []);

  return { list: state.list, pending: state.queue.length, online, setOnline, syncing, storageOk, conflicts, dismissConflicts, decide, enqueue, sync };
}
