/**
 * Motivos y error de las operaciones reservadas al Super-Admin verificado: resoluciones manuales de dinero y facturas
 * (`resolveUnknownRefund`, `resolveUnknownSplit`, `resolveUnknownInvoice`, `reactivateRejectedRefund`), ajustes y secretos de la consola y
 * supresión de cuentas. Desde el Sprint 3.2 todas reciben un `VerifiedSuperadminActor` (`verified-actor.ts`), que solo emite la capa de
 * sesión tras comprobar que la cuenta es de Super-Admin, tiene 2FA y que **esta sesión** superó el segundo factor hace menos de 10 minutos;
 * quien no lo cumple queda en la auditoría (`tenant.access_denied`). La ruta que lo reciba responde un 403 genérico.
 */

export type SuperadminDenial = 'NOT_SUPERADMIN' | 'TWO_FACTOR_REQUIRED' | 'SESSION_INVALID' | 'REAUTH_REQUIRED';

const DENIAL_MESSAGE: Record<SuperadminDenial, string> = {
  NOT_SUPERADMIN: 'solo el Super-Admin puede hacerlo',
  TWO_FACTOR_REQUIRED: 'el Super-Admin necesita la verificación en dos pasos activada',
  SESSION_INVALID: 'la sesión no es válida',
  REAUTH_REQUIRED: 'hay que volver a verificar el segundo factor'
};

export class SuperadminRequiredError extends Error {
  constructor(
    readonly reason: SuperadminDenial,
    readonly operation: string
  ) {
    super(`${operation}: ${DENIAL_MESSAGE[reason]}`);
    this.name = 'SuperadminRequiredError';
  }
}
