/**
 * `true` si la petición viene de la propia web (cabecera `Origin` con el mismo host que la que recibe el servidor). Las rutas que escriben o
 * entregan datos de una entidad lo exigen además de la sesión: un formulario de otra página no puede lanzarlas con las cookies de la persona.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host === (request.headers.get('x-forwarded-host') ?? request.headers.get('host'));
  } catch {
    return false;
  }
}
