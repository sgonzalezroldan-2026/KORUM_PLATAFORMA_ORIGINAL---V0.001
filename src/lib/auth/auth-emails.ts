import { randomUUID } from 'node:crypto';
import { dataHmac } from '@/core/security/data-hmac';
import type { Locale } from '@/generated/prisma/enums';
import type { Db } from '@/lib/db';
import { reserveAttempt } from '@/lib/rate-limit';
import { AUTH_EMAIL_RULE } from '@/lib/rate-limit-rules';

/**
 * Emails de acceso (enlace mágico, código, invitación). Se escriben en la bandeja de salida (`OutboxMessage`) y se envían **al momento**:
 * el enlace y el código caducan en minutos y la bandeja no los manda pasada una hora, así que no pueden esperar a la tarea diaria
 * (`OUTBOX_DISPATCH`). Quien llama decide cómo se envía (`dispatch`): en la aplicación, con `after()` cuando la respuesta ya ha salido.
 *
 * Límite por destinatario (`AUTH_EMAIL_RULE`, clave con el HMAC del email): pedir enlaces sin parar no llena la bandeja de nadie. Al
 * superarlo no se escribe nada y no se avisa: la respuesta es la misma, para no revelar si la dirección existe.
 */

export type AuthEmailTemplate = 'auth.magicLink' | 'auth.otp' | 'auth.invitation';

export type DispatchEmails = (ids: readonly number[]) => void;

export interface AuthEmailDeps {
  db: Db;
  hmacSecret: string;
  dispatch: DispatchEmails;
}

export interface AuthEmailInput {
  template: AuthEmailTemplate;
  to: string;
  locale: Locale;
  payload: Record<string, string | number | null>;
  organizationId?: string | null;
}

/** Escribe el email y lo manda a enviar. Devuelve `false` si el destinatario ha superado su límite (no se escribe nada). */
export async function queueAuthEmail(deps: AuthEmailDeps, input: AuthEmailInput): Promise<boolean> {
  const address = input.to.trim().toLowerCase();
  const allowed = await reserveAttempt(deps.db, `${AUTH_EMAIL_RULE.prefix}${dataHmac(deps.hmacSecret, 'auth-email-recipient', address)}`, AUTH_EMAIL_RULE);
  if (!allowed) return false;
  const user = await deps.db.user.findUnique({ where: { email: address }, select: { id: true, locale: true, gdprAnonymizedAt: true } });
  if (user?.gdprAnonymizedAt) return false;
  const message = await deps.db.outboxMessage.create({
    data: {
      idempotencyKey: `${input.template}:${randomUUID()}`,
      templateKey: input.template,
      // Quien ya tiene cuenta recibe el email en el idioma que eligió; si no, en el de la página desde la que lo pidió.
      locale: user?.locale ?? input.locale,
      toAddress: address,
      userId: user?.id ?? null,
      organizationId: input.organizationId ?? null,
      payloadJson: input.payload
    },
    select: { id: true }
  });
  deps.dispatch([message.id]);
  return true;
}
