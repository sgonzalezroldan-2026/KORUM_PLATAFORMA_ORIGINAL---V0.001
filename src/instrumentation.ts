/**
 * Se ejecuta una vez al arrancar el servidor. La validación vive en `instrumentation-node.ts` para que el código de Node
 * (`process.exit`) no entre en la compilación del runtime Edge.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node');
  }
}

/**
 * Errores no controlados de las rutas y acciones del servidor. Solo viaja la ruta como patrón (`/panel/[orgSlug]`), nunca la URL real:
 * puede llevar identificadores o tokens de enlaces de un solo uso.
 */
export async function onRequestError(error: unknown, _request: { path: string; method: string }, context: { routePath: string; routeType: string }) {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { reportError } = await import('./lib/error-reporting');
  reportError(error, { route: context.routePath, routeType: context.routeType });
}
