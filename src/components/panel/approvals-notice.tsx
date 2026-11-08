'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Aviso de éxito de la bandeja de aprobaciones, por encima de las listas (revisión de experiencia del 4.2a). Al aprobar, desestimar o revalidar,
 * la idea cambia de lista y su tarjeta se vuelve a montar: un aviso dentro de ella se perdería y el foco caería al documento. Aquí el aviso
 * sobrevive al refresco, se anuncia (`role="status"`) y recibe el foco.
 */

const NoticeContext = createContext<(message: string) => void>(() => undefined);

export function ApprovalsNoticeProvider({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState<{ message: string; at: number } | null>(null);
  const region = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (notice) region.current?.focus();
  }, [notice]);

  return (
    <NoticeContext.Provider value={(message) => setNotice({ message, at: Date.now() })}>
      <div ref={region} tabIndex={-1} role="status" aria-live="polite" data-testid="approvals-notice">
        {notice ? <p className="rounded-xl border-2 border-varsity-emerald bg-emerald-50 p-3 text-sm font-semibold text-emerald-950">{notice.message}</p> : null}
      </div>
      {children}
    </NoticeContext.Provider>
  );
}

export const useApprovalsNotice = () => useContext(NoticeContext);
