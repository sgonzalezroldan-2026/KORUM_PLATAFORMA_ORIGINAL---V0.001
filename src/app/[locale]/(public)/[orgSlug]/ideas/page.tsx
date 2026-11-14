import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { IdeaBoard } from '@/components/ideas/idea-board';
import { PortalNav } from '@/components/portal/portal-nav';
import { getEnv } from '@/config/env';
import { isLocale } from '@/i18n/routing';
import { getAuthSession } from '@/lib/auth/session';
import { absoluteUrl, localizedPath } from '@/lib/seo/marketing-routes';
import { entityCardVersion } from '@/lib/seo/entity-card';
import { buildPageMetadata, fitText, TITLE_MAX, TITLE_SUFFIX } from '@/lib/seo/metadata';
import { ideasPath, ogEntityUrl } from '@/lib/seo/portal-routes';
import { loadIdeaBoard } from '@/services/ideas/idea-board-data';
import { loadPortalOrganization } from '@/services/portal/portal-data';

/**
 * Siempre dinámica: «Ya has firmado» y el aviso de la huella dependen de la sesión de quien mira. El `layout` del portal regenera sus páginas cada
 * minuto (`revalidate`); esta no puede guardarse en caché, o una persona vería la firma de otra.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ locale: string; orgSlug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale, orgSlug } = await params;
  if (!isLocale(locale)) return {};
  const [organization, t] = await Promise.all([loadPortalOrganization(orgSlug), getTranslations({ locale, namespace: 'portal.meta' })]);
  const room = TITLE_MAX - TITLE_SUFFIX.length - t('ideasTitle', { name: '' }).length;
  return buildPageMetadata({
    locale,
    path: ideasPath(orgSlug),
    title: t('ideasTitle', { name: fitText(organization.name, room) }),
    description: fitText(t('ideasDescription', { name: organization.name }), 155),
    imageAlt: t('entityImageAlt', { name: organization.name }),
    imageUrl: ogEntityUrl(locale, orgSlug, entityCardVersion(organization)),
    // Las propuestas son de familias, no contenido de la entidad: siempre fuera de los buscadores (ficha del Sprint 3.6).
    noindex: true
  });
}

/**
 * Buzón de ideas (`id="fview-ideas"` del prototipo; QA-F09). Es dinámico a propósito: «Ya has firmado» depende de quién mira. Cualquiera ve las
 * ideas; para firmar o proponer hace falta una cuenta con el email verificado (enlace o código, sin contraseña). En público solo hay códigos
 * `#FAM-XXXX` y recuentos de firmas verificadas.
 */
export default async function IdeasPage({ params }: PageProps) {
  const { locale, orgSlug } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);

  const [organization, session] = await Promise.all([loadPortalOrganization(orgSlug), getAuthSession()]);
  const board = await loadIdeaBoard(orgSlug, new Date(), session ? { userId: session.userId, email: session.email } : null, getEnv().DATA_HMAC_SECRET);
  const loginHref = `/login?next=${encodeURIComponent(localizedPath(locale, ideasPath(orgSlug)))}`;

  return (
    <div className="space-y-6">
      <PortalNav orgSlug={orgSlug} current="ideas" />
      <IdeaBoard
        orgSlug={orgSlug}
        locale={locale}
        entityName={organization.name}
        contentLang={organization.contentLocale === locale ? undefined : organization.contentLocale}
        ideas={board.ideas}
        needed={board.needed}
        maxDays={board.maxDays}
        categories={board.categories}
        signedIn={session !== null}
        loginHref={loginHref}
        fingerprintGranted={board.fingerprintGranted}
        pageUrl={absoluteUrl(locale, ideasPath(orgSlug))}
      />
    </div>
  );
}
