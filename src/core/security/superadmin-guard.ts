import type { Db } from '@/lib/db';

/**
 * Guardia de las resoluciones manuales de dinero y facturas (`resolveUnknownRefund`, `resolveUnknownSplit`, `resolveUnknownInvoice`).
 * Resolver un resultado desconocido asienta, sin más prueba que la palabra de quien lo hace, que un reembolso, un reparto o una factura
 * ocurrieron o no. Por eso el propio servicio —no solo la pantalla que lo llame— exige una cuenta de Super-Admin con la verificación en dos
 * pasos activada, y deja en la auditoría cualquier intento de otra cuenta. Que el inicio de sesión actual haya superado ese segundo factor
 * lo comprueba la capa de acceso (Sprint 3.2): aquí se garantiza que la cuenta lo tiene configurado y que no es una cuenta cualquiera.
 */

export type SuperadminDenial = 'NOT_SUPERADMIN' | 'TWO_FACTOR_REQUIRED';

export class SuperadminRequiredError extends Error {
  constructor(
    readonly reason: SuperadminDenial,
    readonly operation: string
  ) {
    super(reason === 'NOT_SUPERADMIN' ? `${operation}: solo el Super-Admin puede resolver este caso` : `${operation}: el Super-Admin necesita la verificación en dos pasos activada`);
    this.name = 'SuperadminRequiredError';
  }
}

/** Debe llamarse **antes** de abrir la transacción de la operación: el aviso de acceso denegado tiene que quedar aunque la operación se aborte. */
export async function assertSuperadminWithTwoFactor(db: Db, userId: string, operation: string, targetId: string = '*'): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { isSuperadmin: true, twoFactorEnabled: true, gdprAnonymizedAt: true } });
  // Una cuenta anonimizada (derecho de supresión) ya no es una persona identificable: no puede resolver nada.
  const reason: SuperadminDenial | null = !user?.isSuperadmin || user.gdprAnonymizedAt !== null ? 'NOT_SUPERADMIN' : !user.twoFactorEnabled ? 'TWO_FACTOR_REQUIRED' : null;
  if (reason === null) return;
  await db.auditLog.create({
    data: { actorType: 'USER', actorUserId: user ? userId : null, action: 'tenant.access_denied', targetType: 'ManualResolution', targetId, metadataJson: { attempted: operation, reason } }
  });
  throw new SuperadminRequiredError(reason, operation);
}
