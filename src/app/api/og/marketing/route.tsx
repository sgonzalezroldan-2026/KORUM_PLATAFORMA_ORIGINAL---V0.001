import { ImageResponse } from 'next/og';
import { getTranslations } from 'next-intl/server';
import { KorumMarkSvg } from '@/components/brand/korum-mark-svg';
import { isLocale } from '@/i18n/routing';
import { isPillarKey, OG_IMAGE_SIZE } from '@/lib/seo/marketing-routes';

/**
 * Tarjeta social de las páginas de marketing (`/api/og/marketing?locale=es&page=precios&v=1`), 1200×630. Es un diseño plano (azul marino,
 * oro y marfil, sin fotografías), así que pesa unos pocos KB, muy por debajo de los 300 KB que admite WhatsApp. Solo acepta idiomas y
 * páginas conocidos: nunca dibuja texto que venga de la URL.
 */
const NAVY = '#101f38';
const GOLD = '#f59e0b';
const IVORY = '#fdfbf7';

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const locale = params.get('locale') ?? '';
  const page = params.get('page') ?? '';
  if (!isLocale(locale) || (page !== 'home' && !isPillarKey(page))) return new Response('Bad Request', { status: 400 });

  const home = await getTranslations({ locale, namespace: 'home' });
  const brand = await getTranslations({ locale, namespace: 'brand' });
  const pages = await getTranslations({ locale, namespace: 'marketing.pages' });
  const title = page === 'home' ? home('title') : pages(`${page}.h1`);

  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: 72, background: NAVY, color: IVORY, borderTop: `14px solid ${GOLD}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
          <KorumMarkSvg size={104} variant="simple" decorative />
          <div style={{ display: 'flex', fontSize: 52, fontWeight: 800, letterSpacing: 10 }}>{brand('name')}</div>
        </div>
        <div style={{ display: 'flex', fontSize: title.length > 70 ? 54 : 64, fontWeight: 800, lineHeight: 1.15 }}>{title}</div>
        <div style={{ display: 'flex', fontSize: 30, color: GOLD }}>{brand('tagline')}</div>
      </div>
    ),
    { ...OG_IMAGE_SIZE, headers: { 'Cache-Control': 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400' } }
  );
}
