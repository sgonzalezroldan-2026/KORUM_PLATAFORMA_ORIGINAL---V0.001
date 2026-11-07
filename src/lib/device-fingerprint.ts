/**
 * Huella del navegador para la regla padre/madre (skill de antifraude §2). **Solo se calcula tras el consentimiento expreso** de la persona
 * (`ConsentPurpose.DEVICE_FINGERPRINT`); el servidor la vuelve a convertir en un HMAC y no la guarda en claro. Mezcla señales comunes y poco
 * identificativas por separado (navegador, idioma, pantalla, zona horaria): sin lienzos, fuentes ni nada que se parezca a seguimiento.
 */
export async function computeDeviceFingerprint(): Promise<string | undefined> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return undefined;
  const signals = [
    navigator.userAgent,
    navigator.language,
    `${screen.width}x${screen.height}x${screen.colorDepth}`,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    String(navigator.hardwareConcurrency ?? 0),
    String(navigator.maxTouchPoints ?? 0)
  ].join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signals));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
