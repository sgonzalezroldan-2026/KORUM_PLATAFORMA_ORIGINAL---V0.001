import { getEnv } from '@/config/env';
import { getKeyring } from '@/config/keyring';
import type { Keyring } from '@/core/security/crypto';

/**
 * Lo que `/admin/ajustes` necesita del entorno del servidor (modo de pagos, llavero de cifrado y su versión). Se pasa como parámetro a los servicios en lugar de leerlo dentro: las
 * pruebas de integración lo sustituyen sin tocar variables de entorno, y ninguna pieza de la pantalla depende de `getEnv()` por su cuenta.
 */
export interface SettingsRuntime {
  paycometMode: 'mock' | 'sandbox' | 'live';
  keyring: Keyring;
  encryptionKeyVersion: number;
  /** Cuántas claves anteriores hay en `ENCRYPTION_PREVIOUS_KEYS` (solo el número: nunca las claves). */
  previousKeyCount: number;
  /** Variables de respaldo del servidor (por defecto, las del proceso). Para las pruebas se sustituyen. */
  fallbacks?: Readonly<Record<string, string | undefined>>;
  /** Para las pruebas: sustituye las llamadas a Paycomet y a Brevo. */
  fetchImpl?: typeof fetch;
}

export function settingsRuntimeFromEnv(): SettingsRuntime {
  const env = getEnv();
  return {
    paycometMode: env.PAYCOMET_MODE,
    keyring: getKeyring(),
    encryptionKeyVersion: env.ENCRYPTION_KEY_VERSION,
    previousKeyCount: env.ENCRYPTION_PREVIOUS_KEYS?.split(',').filter((part) => part.trim() !== '').length ?? 0
  };
}
