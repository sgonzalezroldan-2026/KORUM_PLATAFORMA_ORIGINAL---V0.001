'use client';

import { useCallback, useRef, useState } from 'react';
import { ReauthDialog } from '@/components/account/reauth-dialog';
import type { TeamActionResult } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/ajustes/team-actions';

/**
 * Relevo de firmantes (Sprint 4.2e): proponer un relevo o dar el visto bueno para dejar el puesto se confirma con el código de la app de verificación.
 * `run(action)` lanza la acción; si el servidor responde que falta el código (`REAUTH_REQUIRED`), abre el diálogo y, al confirmarlo, la repite una vez.
 * El servidor lo vuelve a comprobar siempre con la sesión: aquí solo se evita pedir el código cuando ya se dio hace menos de 10 minutos.
 */
export function useFreshCode(email: string) {
  const [open, setOpen] = useState(false);
  const pending = useRef<{
    action: () => Promise<TeamActionResult>;
    resolve: (result: TeamActionResult) => void;
  } | null>(null);

  const run = useCallback(async (action: () => Promise<TeamActionResult>): Promise<TeamActionResult> => {
    const first = await action();
    if (first.status !== 'ERROR' || first.reason !== 'REAUTH_REQUIRED') return first;
    return new Promise<TeamActionResult>((resolve) => {
      pending.current = { action, resolve };
      setOpen(true);
    });
  }, []);

  const dialog = (
    <ReauthDialog
      open={open}
      email={email}
      proof="second-factor"
      onVerified={() => {
        const current = pending.current;
        pending.current = null;
        setOpen(false);
        if (current) void current.action().then(current.resolve, () => current.resolve({ status: 'ERROR', reason: 'FORBIDDEN' }));
      }}
      onClose={() => {
        const current = pending.current;
        pending.current = null;
        setOpen(false);
        // Cerrar sin confirmar deja todo como estaba: quien llama lo dice junto al formulario.
        current?.resolve({ status: 'ERROR', reason: 'REAUTH_REQUIRED' });
      }}
    />
  );

  return { run, dialog };
}
