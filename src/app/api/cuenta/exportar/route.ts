import { getTranslations } from 'next-intl/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getEnv } from '@/config/env';
import { getKeyring } from '@/config/keyring';
import { SuperadminRequiredError } from '@/core/security/superadmin-guard';
import { isLocale } from '@/i18n/routing';
import { getAuthSession, requireVerifiedAccount } from '@/lib/auth/session';
import { getPrisma } from '@/lib/prisma';
import { exportOwnData } from '@/services/account/account-privacy.service';

/**
 * Exportación de los datos personales desde *Mi cuenta* (QA-PRIV01). Es una ruta y no una acción porque devuelve un fichero que el navegador
 * descarga. La persona sale de la sesión (reautenticada hace menos de 10 minutos, `requireVerifiedAccount`), nunca del cuerpo; la petición
 * tiene que venir de la propia web (`Origin`). El fichero no se guarda en ningún sitio: va solo en esta respuesta, sin caché.
 */

const input = z.object({ format: z.enum(['json', 'pdf']), locale: z.string().refine(isLocale) });

const json = (body: Record<string, unknown>, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host === (request.headers.get('x-forwarded-host') ?? request.headers.get('host'));
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ ok: false, error: 'FORBIDDEN' }, 403);
  // Sin sesión no se escribe nada en la auditoría: una avalancha anónima no puede llenarla (auditoría del 3.7, M1).
  if (!(await getAuthSession())) return json({ ok: false, error: 'LOGIN_REQUIRED' }, 401);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'INVALID_INPUT' }, 400);
  }
  const parsed = input.safeParse(body);
  if (!parsed.success || !isLocale(parsed.data.locale)) return json({ ok: false, error: 'INVALID_INPUT' }, 400);
  const { format, locale } = parsed.data;

  let actor;
  try {
    actor = await requireVerifiedAccount('privacy.export');
  } catch (error) {
    // Sin sesión o con la reautenticación caducada: la página pide el código por email y vuelve a intentarlo.
    if (error instanceof SuperadminRequiredError) return json({ ok: false, error: error.reason === 'REAUTH_REQUIRED' ? 'REAUTH_REQUIRED' : 'LOGIN_REQUIRED' }, 403);
    throw error;
  }

  const t = await getTranslations({ locale, namespace: 'privacy.export' });
  const outcome = await exportOwnData(
    getPrisma(),
    { keyring: getKeyring(), hmacSecret: getEnv().DATA_HMAC_SECRET },
    { actor, format, locale, t: (key, values) => t(key as never, values as never) }
  );
  if (outcome.status === 'RATE_LIMITED') return json({ ok: false, error: 'RATE_LIMITED' }, 429);

  const { file } = outcome;
  return new NextResponse(Buffer.from(file.bytes), {
    status: 200,
    headers: {
      'Content-Type': file.contentType,
      'Content-Disposition': `attachment; filename="${file.fileName}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    }
  });
}
