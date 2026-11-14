import { ImageResponse } from 'next/og';
import { getTranslations } from 'next-intl/server';
import { KorumMarkSvg } from '@/components/brand/korum-mark-svg';
import { isLocale } from '@/i18n/routing';
import { getPrisma } from '@/lib/prisma';
import { ENTITY_CARD_VERSION_PATTERN } from '@/lib/seo/entity-card';
import { OG_IMAGE_SIZE } from '@/lib/seo/marketing-routes';
import { fitText } from '@/lib/seo/metadata';
import { ORG_SLUG_PATTERN } from '@/lib/seo/portal-routes';
import { getPublicOrganization } from '@/repositories/public.repository';
import { ResourceNotFoundError } from '@/repositories/tenant-guard';
import { ogEntityLogo } from '@/services/portal/og-entity-logo';

/**
 * Tarjeta para WhatsApp y redes de la portada de una entidad (`/api/og/entity/ceip-cervantes?locale=es&v=3f9a0c12be47`), 1200×630 (heredado del
 * Sprint 3.3: antes la portada usaba la tarjeta de marketing de KORUM). La entidad es la protagonista: su nombre en grande, su logotipo sobre
 * marfil y una franja con su color; KORUM firma abajo «con la tecnología de» (co-branding de la skill de marca §3). **Sin cifras**: WhatsApp
 * guarda la imagen por URL durante días y una cantidad recaudada quedaría desfasada; `v` es la huella de lo dibujado (nombre, vertical, logotipo
 * y color, `entityCardVersion`), así que solo cambia si cambia la imagen. El texto de la URL nunca se dibuja: `locale` solo se compara con los tres idiomas.
 */
const NAVY = '#101f38';
const GOLD = '#f59e0b';
const IVORY = '#fdfbf7';
const HEX = /^#[0-9a-f]{6}$/i;

/** satori no dibuja emojis sin descargar una fuente: se quitan del nombre de la entidad. */
const plain = (text: string) => text.replace(/\p{Extended_Pictographic}/gu, '').replace(/\s+/g, ' ').trim();

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // Solo las URL que publican las páginas (`ogEntityUrl`): un idioma o una versión inventados serían una variante nueva en la caché del borde y
  // obligarían a consultar la base y a dibujar otra vez (auditoría de seguridad del 5.5a, H4). Responden 404 sin consultar nada.
  const query = new URL(request.url).searchParams;
  const locale = query.get('locale') ?? '';
  if (!ORG_SLUG_PATTERN.test(slug) || !isLocale(locale) || !ENTITY_CARD_VERSION_PATTERN.test(query.get('v') ?? '')) return new Response('Not Found', { status: 404 });

  let organization;
  try {
    organization = await getPublicOrganization(getPrisma(), slug);
  } catch (error) {
    if (error instanceof ResourceNotFoundError) return new Response('Not Found', { status: 404 });
    throw error;
  }

  const [t, brand, logo] = await Promise.all([
    getTranslations({ locale, namespace: 'portal.og.entity' }),
    getTranslations({ locale, namespace: 'brand' }),
    ogEntityLogo(getPrisma(), organization.logoFileId)
  ]);
  const name = fitText(plain(organization.name), 70);
  // El color de la entidad solo pinta una franja decorativa (no hay texto encima): no compromete el contraste.
  const accent = organization.brandPrimary && HEX.test(organization.brandPrimary) ? organization.brandPrimary : GOLD;

  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: NAVY, color: IVORY }}>
        <div style={{ display: 'flex', width: '100%', height: 18, background: accent }} />
        <div style={{ display: 'flex', flex: 1, flexDirection: 'column', justifyContent: 'space-between', padding: '52px 64px 56px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 32 }}>
            <div style={{ display: 'flex', fontSize: 30, fontWeight: 700, color: GOLD, letterSpacing: 2 }}>{t(`kicker.${organization.vertical}`)}</div>
            {logo ? (
              <div style={{ display: 'flex', width: 150, height: 150, borderRadius: 34, background: IVORY, alignItems: 'center', justifyContent: 'center', padding: 10 }}>
                {/* eslint-disable-next-line @next/next/no-img-element -- satori (next/og) solo dibuja <img>, sin el optimizador de imágenes */}
                <img src={logo} alt="" width={130} height={130} style={{ objectFit: 'contain' }} />
              </div>
            ) : null}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div style={{ display: 'flex', fontSize: name.length > 40 ? 62 : 78, fontWeight: 800, lineHeight: 1.1 }}>{name}</div>
            <div style={{ display: 'flex', fontSize: 34, lineHeight: 1.3, color: '#dbe3ee' }}>{t('promise')}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
            <KorumMarkSvg size={64} variant="simple" decorative />
            <div style={{ display: 'flex', fontSize: 28, fontWeight: 700 }}>{t('poweredBy', { brand: brand('name') })}</div>
          </div>
        </div>
      </div>
    ),
    // La URL lleva `v` (huella de lo dibujado): una versión nueva es una imagen nueva, así que puede cachearse mucho tiempo.
    { ...OG_IMAGE_SIZE, headers: { 'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400' } }
  );
}
