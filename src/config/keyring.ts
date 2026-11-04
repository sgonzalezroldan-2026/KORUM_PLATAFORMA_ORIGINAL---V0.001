import { keyringFromEnv, type Keyring } from '@/core/security/crypto';
import { getEnv } from './env';

let cached: Keyring | undefined;

/** Llavero de cifrado del proceso, a partir del entorno ya validado (`ENCRYPTION_KEY`, su versión y las anteriores). */
export function getKeyring(): Keyring {
  cached ??= keyringFromEnv(getEnv());
  return cached;
}
