import { getTranslations } from 'next-intl/server';
import { NextResponse } from 'next/server';
import type { DossierData } from '@/core/dossier/dossier-model';
import { renderDossierPdf, type DossierTexts } from '@/core/dossier/dossier-pdf';
import { dossierTextsFrom } from '@/core/dossier/dossier-texts';
import type { Locale } from '@/i18n/routing';
import { requestIsFromOwnSite } from './own-site';

/**
 * Lo común a las dos descargas del expediente exportable (Sprint 5.8b): los textos del idioma pedido y la respuesta con el PDF. Nada se guarda en el
 * servidor ni en caché.
 */

export const dossierJson = (body: Record<string, unknown>, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/**
 * Solo desde la propia aplicación (o escribiendo la dirección): un enlace puesto en otra web no puede forzar la descarga ni dejar su fila en la auditoría
 * a nombre de la persona. Sin la cabecera (navegadores antiguos) se admite: la sesión sigue siendo obligatoria.
 */
export const dossierFromOwnSite = (request: Request): boolean => requestIsFromOwnSite(request.headers.get('sec-fetch-site'));

export async function dossierTexts(locale: Locale): Promise<DossierTexts> {
  const [dossier, audit, actions, statuses, roles] = await Promise.all([
    getTranslations({ locale, namespace: 'audit.dossier' }),
    getTranslations({ locale, namespace: 'audit' }),
    getTranslations({ locale, namespace: 'audit.actions' }),
    getTranslations({ locale, namespace: 'status.initiative' }),
    getTranslations({ locale, namespace: 'panel.approvals.doubleCheck.roles' })
  ]);
  return dossierTextsFrom({
    dossier: (key, values) => dossier(key as never, values as never),
    audit: (key, values) => audit(key as never, values as never),
    actions: (key) => actions(key as never),
    statuses: (key) => statuses(key as never),
    roles: (key) => roles(key as never)
  });
}

export async function dossierPdfResponse(data: DossierData, locale: Locale): Promise<NextResponse> {
  const bytes = renderDossierPdf(data, await dossierTexts(locale), locale);
  return new NextResponse(Buffer.from(bytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      // El mismo nombre en los tres idiomas: la marca y la referencia del expediente.
      'Content-Disposition': `attachment; filename="KORUM-${data.reference}.pdf"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    }
  });
}
