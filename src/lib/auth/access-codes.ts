import type { Prisma } from '@/generated/prisma/client';

/**
 * Códigos y enlaces de acceso pendientes de unas direcciones de email, tal como los guarda Better Auth (auditoría de seguridad del 5.10b): los códigos de 6 dígitos con
 * el identificador exacto `{tipo}-otp-{email}` y los enlaces mágicos con el email dentro de su valor (su identificador es la huella del token). Se busca la forma exacta:
 * un `endsWith` borraría también los de otra cuenta cuyo email acaba igual (`ana-b@x.com` frente a `b@x.com`). Lo usan la supresión, el cambio de email y la purga de
 * altas sin verificar.
 */
const OTP_TYPES = ['sign-in', 'email-verification', 'forget-password', 'change-email'] as const;

export function pendingAccessCodesWhere(emails: readonly string[]): Prisma.VerificationWhereInput {
  const unique = [...new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean))];
  return {
    OR: [
      { identifier: { in: unique.flatMap((email) => OTP_TYPES.map((type) => `${type}-otp-${email}`)) } },
      ...unique.map((email) => ({ AND: [{ value: { startsWith: '{"type":"magic-link"' } }, { value: { contains: `"email":${JSON.stringify(email)}` } }] }))
    ]
  };
}
