import { isIP } from 'node:net';
import { expandIpv6 } from '@/core/security/device-signals';
import type { Db } from '@/lib/db';
import { reserveAttempt } from '@/lib/rate-limit';
import { GATE_BLOCK_NOTICE_RULE, GATE_REJECTED_NOTICE_RULE, GATE_REQUEST_RULE } from '@/lib/rate-limit-rules';
import type { RequestMeta } from '@/repositories/tenant-guard';

/**
 * Límites globales de la portería (QA-SEC09). Cada bloqueo se anota en `AuditLog` **una sola vez por ventana**: la tabla no se puede purgar y una red ya
 * bloqueada seguiría escribiendo una fila por petición. La marca de «ya anotado» es otro contador de `RateLimit` (que sí se purga).
 */

/**
 * La «red» de una petición para los límites de portería: la IPv4 completa y, en IPv6, el prefijo /64 (lo que recibe un abonado: quien tiene un bloque cambia de
 * dirección en cada petición, y con la IP completa cada una sería «otra red» y ningún límite saltaría). Una IPv4 escrita como IPv6 cuenta como IPv4.
 */
export function gateNetwork(rawIp: string): string | null {
  const ip = rawIp.trim().split('%')[0]!;
  const family = isIP(ip);
  if (family === 4) return ip;
  if (family !== 6) return null;
  const groups = expandIpv6(ip);
  if (groups.slice(0, 5).every((group) => group === '0000') && groups[5] === 'ffff') {
    const high = parseInt(groups[6]!, 16);
    const low = parseInt(groups[7]!, 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return `${groups.slice(0, 4).join(':')}::/64`;
}

export const unknownIp = 'unknown-ip';
export const ipOf = (meta: RequestMeta | undefined): string => meta?.ipHash ?? unknownIp;

/** `true` solo la primera vez de la ventana para esa clave: quien lo recibe es quien debe dejar la fila de auditoría. */
export async function firstNotice(db: Db, key: string, now: Date, rule = GATE_BLOCK_NOTICE_RULE): Promise<boolean> {
  return reserveAttempt(db, `${rule.prefix}${key}`, rule, now);
}

/**
 * Cuenta una petición de portería con sesión (o que intenta tenerla). Sin cuenta ni sesión previa no se lee nada más: si está bloqueada, nadie lo hace.
 * Devuelve `false` si la red ha pasado su límite por minuto.
 */
export async function allowGateRequest(db: Db, meta: RequestMeta | undefined, now: Date = new Date()): Promise<boolean> {
  const ip = ipOf(meta);
  if (await reserveAttempt(db, `${GATE_REQUEST_RULE.prefix}${ip}`, GATE_REQUEST_RULE, now)) return true;
  if (await firstNotice(db, `req:${ip}`, now)) {
    await db.auditLog.create({ data: { actorType: 'GATE_SESSION', action: 'gate.request_limited', targetType: 'Gate', targetId: 'requests', ipHash: meta?.ipHash?.slice(0, 128) ?? null, metadataJson: { limitPerMinute: GATE_REQUEST_RULE.limit } } });
  }
  return false;
}

/** Una sesión de portería ya cerrada que sigue insistiendo: la primera vez de cada 6 horas se anota (no una vez por petición). */
export const firstRejectedNotice = (db: Db, gateSessionId: string, now: Date): Promise<boolean> => firstNotice(db, gateSessionId, now, GATE_REJECTED_NOTICE_RULE);
