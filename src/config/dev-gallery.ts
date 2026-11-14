/**
 * ¿Existe la galería interna de componentes (`/dev/ui`)? Solo en desarrollo o en el entorno de demostración, nunca en producción real. Se lee al
 * ejecutarse (no al importarse) y la usan **el layout y la página**: si solo la comprobara la página, el layout ya habría enviado su proveedor de
 * textos (todo el catálogo menos los emails) dentro de la respuesta del 404 (cuarta pasada de la auditoría de seguridad del 5.5a).
 */
export function isDevGalleryAvailable(): boolean {
  return process.env.NODE_ENV !== 'production' || process.env.NEXT_PUBLIC_DEMO_MODE === 'true';
}
