import { z } from 'zod';
import { proposeIdeaSchema } from '@/core/ideas/idea-rules';
import { IdeaProposalRejectedError, proposeIdea, type IdeaProposalRejection } from '@/core/ideas/idea-proposal.service';
import { raiseAlert } from '@/core/jobs/ops-alerts';
import { recordConsent } from '@/core/privacy/consents';
import { hashIpSubnet } from '@/core/security/device-signals';
import { IdeaSignatureRejectedError, signIdea, type IdeaSignatureRejection, type SignatureReasonKey } from '@/core/security/device-quorum.service';
import type { KorumPrismaClient } from '@/lib/prisma';
import { releaseAttempt, reserveAttempt } from '@/lib/rate-limit';
import { IDEA_PROPOSAL_RULE, IDEA_SIGN_RULE } from '@/lib/rate-limit-rules';
import { getSetting } from '@/services/settings/settings.service';

/**
 * Lo que el navegador puede pedir al buzón (Sprint 3.6): firmar y proponer. Quién firma sale siempre de la sesión; la entidad, de su `orgSlug`
 * público, y la idea se comprueba contra ella (un identificador de otra entidad responde igual que uno que no existe). Aquí no se leen cabeceras ni
 * cookies: quien llama (la Server Action) entrega la IP de confianza y la cookie del dispositivo, y así todo esto se prueba con una base de datos.
 */

export interface IdeaRequestContext {
  /** `null` si no hay sesión. */
  userId: string | null;
  /** IP según el proxy de confianza (`trustedClientIp`), o `null` si no hay una válida. */
  ip: string | null;
  deviceCookie?: string;
}

const signPayload = z.object({
  orgSlug: z.string().min(1).max(80),
  ideaId: z.number().int().positive().max(2_147_483_647),
  /** Huella calculada en el navegador. Solo se usa con consentimiento; el servidor no la guarda en claro. */
  fingerprint: z.string().min(8).max(128).optional(),
  /** `true` si la persona acaba de marcar «Ayudar a proteger la votación» en esta firma. */
  fingerprintConsent: z.boolean().optional()
});

export type SignOutcome =
  | { status: 'SIGNED'; verified: boolean; accountOrder: number; reasonKey: SignatureReasonKey; quorumReached: boolean; newDeviceCookie: string | null }
  | { status: 'ALREADY_SIGNED' }
  | { status: 'LOGIN_REQUIRED' }
  | { status: 'REJECTED'; reason: IdeaSignatureRejection | 'NOT_FOUND' | 'RATE_LIMITED' | 'INVALID_INPUT' };

/** Lo que se devuelve al navegador: sin la cookie del dispositivo, que viaja en una cabecera `Set-Cookie` y no en el cuerpo. */
export type SignActionResult = SignOutcome extends infer T ? (T extends { newDeviceCookie: unknown } ? Omit<T, 'newDeviceCookie'> : T) : never;

export interface IdeaServiceDeps {
  db: KorumPrismaClient;
  hmacSecret: string;
}

/**
 * Si el proxy no entrega una IP válida, todas las familias caen en el grupo común `unknown-ip` y, desde la 7ª firma de cada idea, quedan
 * sospechosas sin que nadie lo vea (heredado del Sprint 2.2). La alerta es una sola (se repite sin duplicarse) y no lleva datos personales.
 */
export async function raiseTrustedIpAlert(db: KorumPrismaClient, route: string, now: Date): Promise<void> {
  await raiseAlert(db, { type: 'TRUSTED_IP_MISSING', severity: 'WARNING', dedupeKey: `trusted-ip-missing:${route}`, targetType: 'Route', targetId: route, detail: { route } }, now);
}

export async function signIdeaForRequest(deps: IdeaServiceDeps, payload: unknown, context: IdeaRequestContext, now: Date = new Date()): Promise<SignOutcome> {
  if (!context.userId) return { status: 'LOGIN_REQUIRED' };
  const parsed = signPayload.safeParse(payload);
  if (!parsed.success) return { status: 'REJECTED', reason: 'INVALID_INPUT' };
  const input = parsed.data;
  const { db } = deps;

  // Antes de tocar nada: una cuenta no puede llenar la auditoría de firmas probando ideas una tras otra.
  if (!(await reserveAttempt(db, `${IDEA_SIGN_RULE.prefix}${context.userId}`, IDEA_SIGN_RULE, now))) return { status: 'REJECTED', reason: 'RATE_LIMITED' };
  const idea = await db.idea.findFirst({ where: { id: input.ideaId, organization: { slug: input.orgSlug, archivedAt: null } }, select: { id: true } });
  if (!idea) return { status: 'REJECTED', reason: 'NOT_FOUND' };
  if (context.ip === null) await raiseTrustedIpAlert(db, 'idea.sign', now);

  try {
    if (input.fingerprintConsent === true) {
      const policyVersion = (await getSetting(db, 'privacy.policyVersion')) ?? '2026-11-01';
      await recordConsent(db, { userId: context.userId, purpose: 'DEVICE_FINGERPRINT', granted: true, policyVersion, source: 'buzon' }, now);
    }
    const result = await signIdea(db, deps.hmacSecret, { ideaId: idea.id, userId: context.userId, deviceCookie: context.deviceCookie, ip: context.ip, fingerprint: input.fingerprint }, now);
    if (result.status === 'ALREADY_SIGNED') return { status: 'ALREADY_SIGNED' };
    return { status: 'SIGNED', verified: result.audit.status === 'VERIFIED', accountOrder: result.audit.deviceAccountOrder, reasonKey: result.audit.reasonKey, quorumReached: result.quorumReached, newDeviceCookie: result.newDeviceCookie };
  } catch (error) {
    if (error instanceof IdeaSignatureRejectedError) return { status: 'REJECTED', reason: error.reason };
    throw error;
  }
}

export type ProposeOutcome =
  | { status: 'PROPOSED'; alias: string }
  | { status: 'LOGIN_REQUIRED' }
  | { status: 'REJECTED'; reason: IdeaProposalRejection | 'RATE_LIMITED' };

export async function proposeIdeaForRequest(deps: IdeaServiceDeps, payload: unknown, context: IdeaRequestContext & { systemMessage: string }, now: Date = new Date()): Promise<ProposeOutcome> {
  if (!context.userId) return { status: 'LOGIN_REQUIRED' };
  // Lo que no es una propuesta válida no gasta el límite de nadie: una cuenta no puede agotar el cupo de toda una red con peticiones vacías.
  const parsed = proposeIdeaSchema.safeParse(payload);
  if (!parsed.success) return { status: 'REJECTED', reason: 'INVALID_INPUT' };
  // El límite es por red **y por entidad** (el wifi de un colegio no bloquea a otro). Sin IP válida no hay red que limitar: ya salta la alerta, y
  // un grupo común para toda la plataforma dejaría sin buzón a todas las familias por culpa de un fallo del proxy.
  let reserved: string | null = null;
  if (context.ip === null) await raiseTrustedIpAlert(deps.db, 'idea.propose', now);
  else {
    reserved = `${IDEA_PROPOSAL_RULE.prefix}${parsed.data.orgSlug}:${hashIpSubnet(deps.hmacSecret, context.ip)}`;
    if (!(await reserveAttempt(deps.db, reserved, IDEA_PROPOSAL_RULE, now))) return { status: 'REJECTED', reason: 'RATE_LIMITED' };
  }
  try {
    const proposed = await proposeIdea(deps.db, { userId: context.userId, payload, systemMessage: context.systemMessage }, now);
    return { status: 'PROPOSED', alias: proposed.alias };
  } catch (error) {
    if (error instanceof IdeaProposalRejectedError) {
      // Un rechazo que no es spam (categoría, cuenta, entidad) devuelve el intento; los límites por persona sí lo conservan.
      if (reserved && ['INVALID_INPUT', 'INVALID_CATEGORY', 'ACCOUNT_NOT_ALLOWED', 'ORGANIZATION_NOT_FOUND'].includes(error.reason)) await releaseAttempt(deps.db, reserved);
      return { status: 'REJECTED', reason: error.reason };
    }
    throw error;
  }
}
