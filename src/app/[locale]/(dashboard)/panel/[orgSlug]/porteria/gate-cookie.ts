import { cookies } from 'next/headers';

/**
 * Cookie de la sesión de portería: solo el token (en `GateSession` queda su HMAC), `HttpOnly` y `SameSite=Strict`, y caduca con el PIN. No
 * abre nada más del panel: el actor que produce (`kind: 'gate'`) solo vale para su evento (`decideTenantAccess`).
 */
export const GATE_COOKIE = 'korum_gate';

export async function readGateToken(): Promise<string | null> {
  return (await cookies()).get(GATE_COOKIE)?.value ?? null;
}

export async function writeGateToken(token: string, expiresAt: Date): Promise<void> {
  (await cookies()).set(GATE_COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', expires: expiresAt });
}

export async function clearGateToken(): Promise<void> {
  (await cookies()).delete(GATE_COOKIE);
}
