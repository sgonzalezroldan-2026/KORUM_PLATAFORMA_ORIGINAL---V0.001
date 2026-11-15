/**
 * ¿Viene la petición de la propia aplicación o de escribir la dirección? (Sprint 5.8b). Un enlace puesto en otra web no puede forzar la descarga de un
 * expediente ni dejar un intento anotado en la auditoría a nombre de quien lo pulsa. Sin la cabecera `Sec-Fetch-Site` (navegadores antiguos) se admite:
 * la sesión sigue siendo obligatoria.
 */
export const requestIsFromOwnSite = (site: string | null): boolean => site === null || site === 'same-origin' || site === 'none';
