import * as Sentry from '@sentry/node';
import { redactText } from './redact';

export { redactText };

/**
 * Registro de errores con Sentry (región UE), solo en servidor. Un error nunca debe sacar datos personales de KORUM (Regla 01, CUMPLIMIENTO
 * §4): antes de enviar nada, `scrubEvent` elimina la petición entera (cuerpo, cabeceras, cookies, parámetros), el usuario, las migas de
 * pan, el nombre de la transacción (lleva la dirección real, con sus tokens), las variables de la pila y los datos extra, y limpia con
 * `redactText` todo lo que parezca un email, un NIF/NIE/CIF, un IBAN, un teléfono, un número de tarjeta, una IP o un token dentro de los
 * textos. Sin `NEXT_PUBLIC_SENTRY_DSN` no se inicializa ni envía nada.
 */

/** Ningún valor de excepción pasa de aquí, ni siquiera antes de limpiarlo. */
const MAX_VALUE_LENGTH = 1_000;

/** Cada texto del evento que pueda llevar datos de personas, ya limpio. Los campos que no se necesitan se eliminan en vez de limpiarse. */
export function scrubEvent<T extends Sentry.ErrorEvent>(event: T): T {
  const scrubbed: T = { ...event };
  delete scrubbed.request;
  delete scrubbed.user;
  delete scrubbed.breadcrumbs;
  delete scrubbed.contexts;
  delete scrubbed.extra;
  delete scrubbed.server_name;
  // La transacción es «GET /ruta/real/sin-query»: con un token o un identificador en la dirección, lo enviaría. El patrón de ruta viaja como etiqueta.
  delete scrubbed.transaction;
  if (scrubbed.fingerprint) scrubbed.fingerprint = scrubbed.fingerprint.map(redactText);
  if (scrubbed.message) scrubbed.message = redactText(scrubbed.message);
  if (scrubbed.exception?.values) {
    scrubbed.exception = {
      ...scrubbed.exception,
      values: scrubbed.exception.values.map((entry) => {
        const { stacktrace, ...rest } = entry;
        return {
          ...rest,
          ...(entry.value === undefined ? {} : { value: redactText(entry.value) }),
          // Las variables locales de cada marco de la pila pueden contener cualquier dato.
          ...(stacktrace ? { stacktrace: { ...stacktrace, frames: stacktrace.frames?.map(({ vars: _vars, ...frame }) => frame) } } : {})
        };
      })
    };
  }
  if (scrubbed.tags) {
    scrubbed.tags = Object.fromEntries(Object.entries(scrubbed.tags).map(([key, value]) => [key, typeof value === 'string' ? redactText(value) : value]));
  }
  return scrubbed;
}

let initialized = false;

export function initErrorReporting(options: { dsn: string | undefined; environment: string }): boolean {
  if (initialized) return true;
  if (!options.dsn) return false;
  Sentry.init({
    dsn: options.dsn,
    environment: options.environment,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    maxValueLength: MAX_VALUE_LENGTH,
    // Sin trazas ni instrumentación automática: solo errores.
    skipOpenTelemetrySetup: true,
    beforeBreadcrumb: () => null,
    beforeSend: (event) => scrubEvent(event)
  });
  initialized = true;
  return true;
}

/** Envía un error ya capturado (p. ej. el fallo de una tarea). `context` solo admite claves técnicas, nunca datos de personas. */
export function reportError(error: unknown, context: Record<string, string | number> = {}): void {
  if (!initialized) return;
  Sentry.withScope((scope) => {
    scope.setTags(Object.fromEntries(Object.entries(context).map(([key, value]) => [key, String(value)])));
    Sentry.captureException(error);
  });
}
