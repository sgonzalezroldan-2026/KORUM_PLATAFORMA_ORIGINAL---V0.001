import { headers } from 'next/headers';
import { getEnv } from '@/config/env';
import { GATE_CODE_PATTERN } from '@/core/ticketing/gate-code';
import { allowGateRequest, gateNetwork, ipOf } from '@/core/ticketing/gate-limits';
import { resolveGateSession } from '@/core/ticketing/gate-session.service';
import { getPrisma, type KorumPrismaClient } from '@/lib/prisma';
import { reserveAttempt } from '@/lib/rate-limit';
import { GATE_ENTRY_RULE } from '@/lib/rate-limit-rules';
import { trustedClientIp } from '@/lib/trusted-ip';
import type { RequestMeta, SessionActor } from '@/repositories/tenant-guard';
import { hashAuditIp } from '@/services/audit/audit.service';
import { readGateToken } from './gate-cookie';

/**
 * Entrada común de todo lo que hace la portería con sesión (pantallas y acciones del móvil). Primero cuenta la petición contra el límite de la red
 * (`QA-SEC09`: antes de leer la cookie y de tocar nada), después traduce la cookie a la sesión y comprueba que sea de **este** evento. La IP sale de la
 * cabecera de confianza (`trustedClientIp`): sin ella, todos los voluntarios compartirían grupo.
 */

export async function gateRequestMeta(): Promise<RequestMeta & { trustedIp: boolean }> {
  const requestHeaders = await headers();
  const ip = trustedClientIp((name) => requestHeaders.get(name));
  // El HMAC es el de la red (IPv4 o IPv6 /64), no el de la dirección: es lo que cuentan los límites y lo que queda en la auditoría.
  return { ipHash: ip ? hashAuditIp(getEnv().DATA_HMAC_SECRET, gateNetwork(ip) ?? ip) : undefined, userAgent: requestHeaders.get('user-agent') ?? undefined, trustedIp: ip !== null };
}

export type GateActor = Extract<SessionActor, { kind: 'gate' }>;

export type GateAccess =
  | { status: 'OK'; db: KorumPrismaClient; actor: GateActor; event: { organizationId: string; initiativeId: number } }
  /** La red ha pasado su límite por minuto. */
  | { status: 'BUSY' }
  /** Sin sesión de portería válida para este evento (cerrada, caducada, de otro evento o sin PIN). */
  | { status: 'NO_SESSION' };

/**
 * `target`: el identificador del evento (lo envía la pantalla ya abierta, con sesión) o el **código de la puerta** (lo trae el enlace de la portería: se traduce aquí,
 * después de contar la petición). El identificador numérico nunca sale en una URL pública ni abre la entrada con PIN.
 */
export async function resolveGateAccess(target: number | string): Promise<GateAccess> {
  if (typeof target === 'number' && (!Number.isSafeInteger(target) || target <= 0)) return { status: 'NO_SESSION' };
  if (typeof target === 'string' && !GATE_CODE_PATTERN.test(target)) return { status: 'NO_SESSION' };
  const db = getPrisma();
  const meta = await gateRequestMeta();
  if (!(await allowGateRequest(db, meta))) return { status: 'BUSY' };
  const eventId = typeof target === 'number' ? target : ((await db.initiative.findUnique({ where: { gateCode: target }, select: { id: true } }))?.id ?? 0);
  if (eventId <= 0) {
    // Un código que no existe gasta del mismo límite que los intentos de PIN (60 cada 15 minutos por red): la pantalla no sirve para ir probando códigos.
    if (typeof target === 'string' && !(await reserveAttempt(db, `${GATE_ENTRY_RULE.prefix}${ipOf(meta)}`, GATE_ENTRY_RULE))) return { status: 'BUSY' };
    return { status: 'NO_SESSION' };
  }
  const token = await readGateToken();
  if (!token) return { status: 'NO_SESSION' };
  const actor = await resolveGateSession(db, getEnv().DATA_HMAC_SECRET, token, meta);
  if (!actor || actor.initiativeId !== eventId) return { status: 'NO_SESSION' };
  return { status: 'OK', db, actor, event: { organizationId: actor.organizationId, initiativeId: actor.initiativeId } };
}
