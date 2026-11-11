import { ImageResponse } from 'next/og';
import { getTranslations } from 'next-intl/server';
import { KorumMarkSvg } from '@/components/brand/korum-mark-svg';
import { daysLeft, percentOf } from '@/core/public/catalog';
import { findGroupBySlug } from '@/core/public/course-challenge';
import { isLocale } from '@/i18n/routing';
import { OG_IMAGE_SIZE } from '@/lib/seo/marketing-routes';
import { fitText } from '@/lib/seo/metadata';
import { INITIATIVE_ID_PATTERN } from '@/lib/seo/portal-routes';
import { getPrisma } from '@/lib/prisma';
import { getPublicInitiativeCard } from '@/repositories/public.repository';
import { ResourceNotFoundError } from '@/repositories/tenant-guard';
import { ogCoverThumbnail } from '@/services/portal/og-cover-image';
import { ogEntityLogo } from '@/services/portal/og-entity-logo';

/**
 * Tarjeta para WhatsApp y redes de una iniciativa (`/api/og/initiative/12?locale=es&grupo=3-primaria&v=1730000000000`), 1200×630. Diseño plano
 * (azul marino, oro y marfil, sin fotografías), así que pesa unos pocos KB, muy por debajo de los 300 KB que admite WhatsApp (QA-F02). Dibuja
 * el avance real, los días que quedan y, si `grupo` es un curso, equipo o grupo que ya suma familias, su reto **en positivo y sin nombres**.
 * El texto de la URL nunca se dibuja: `locale` y `grupo` solo se comparan con valores conocidos. `v` solo versiona la caché de WhatsApp. Si la entidad
 * tiene logotipo (Sprint 4.2e), va a la derecha, sobre marfil: la entidad lidera y KORUM pone la tecnología (co-branding de la skill de marca). Si la
 * campaña tiene imagen (Sprint 4.4c), entra como una miniatura cuadrada junto al título; como la salida es un PNG y una fotografía lo engorda, si con ella
 * la tarjeta pasara de 280 KB se vuelve a dibujar sin ella: el límite de WhatsApp (300 KB) manda sobre la foto.
 */
const MAX_CARD_BYTES = 280 * 1024;
const NAVY = '#101f38';
const GOLD = '#f59e0b';
const IVORY = '#fdfbf7';
const TRACK = '#2a3b57';

/** satori no dibuja emojis sin descargar una fuente: se quitan de los textos de la entidad. */
const plain = (text: string) => text.replace(/\p{Extended_Pictographic}/gu, '').replace(/\s+/g, ' ').trim();

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params;
  if (!INITIATIVE_ID_PATTERN.test(rawId)) return new Response('Not Found', { status: 404 });
  const query = new URL(request.url).searchParams;
  const requested = query.get('locale') ?? 'es';
  const locale = isLocale(requested) ? requested : 'es';

  let initiative;
  try {
    initiative = await getPublicInitiativeCard(getPrisma(), Number(rawId));
  } catch (error) {
    if (error instanceof ResourceNotFoundError) return new Response('Not Found', { status: 404 });
    throw error;
  }

  const [t, logo, cover] = await Promise.all([getTranslations({ locale, namespace: 'portal.og' }), ogEntityLogo(getPrisma(), initiative.organization.logoFileId), ogCoverThumbnail(getPrisma(), initiative.coverFileId)]);
  const brand = await getTranslations({ locale, namespace: 'brand' });
  const ticketing = initiative.format === 'TICKETING';
  const reached = initiative.status !== 'FUNDRAISING' || (ticketing ? initiative.ticketMax !== null && initiative.ticketsSold + initiative.ticketsHeld >= initiative.ticketMax : initiative.raisedCents >= initiative.goalCents);
  const pct = reached ? 100 : ticketing ? percentOf(initiative.ticketsSold, initiative.ticketMax ?? 0) : percentOf(initiative.raisedCents, initiative.goalCents);
  const progressText = ticketing && !reached ? t('tickets', { sold: initiative.ticketsSold, max: initiative.ticketMax ?? 0 }) : reached ? t('goalReached') : t('progress', { pct });
  const remaining = daysLeft(initiative.closesAt, new Date());

  const group = initiative.rewardEnabled ? findGroupBySlug(initiative.courses, query.get('grupo')) : null;
  let challenge: string | null = null;
  if (group && group.familiesCount > 0) {
    const reward = initiative.rewardText ? plain(initiative.rewardText) : '';
    const name = plain(group.groupName);
    const target = Math.max(1, initiative.targetFamiliesPerCourse);
    if (group.familiesCount >= target) challenge = reward ? t('challengeReached', { group: name, reward }) : t('challengeReachedNoReward', { group: name });
    else {
      const missing = target - group.familiesCount;
      challenge = reward ? t('challengeMissing', { missing, group: name, reward }) : t('challengeMissingNoReward', { missing, group: name });
    }
  }

  const title = fitText(plain(initiative.title), 90);
  // Con el logotipo a la derecha queda menos sitio para el nombre.
  const entity = fitText(plain(initiative.organization.name), initiative.organization.logoFileId ? 38 : 60);

  // Con miniatura, caché más corta: al quitar la imagen de una campaña, los enlaces antiguos dejan de servirla en horas y no en días (auditoría de seguridad).
  const draw = (thumbnail: string | null) =>
    new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: 64, background: NAVY, color: IVORY, borderTop: `14px solid ${GOLD}` }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
            <KorumMarkSvg size={84} variant="simple" decorative />
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', fontSize: 40, fontWeight: 800, letterSpacing: 8 }}>{brand('name')}</div>
              <div style={{ display: 'flex', fontSize: 28, color: GOLD }}>{t('forEntity', { entity })}</div>
            </div>
          </div>
          {logo ? (
            <div style={{ display: 'flex', width: 120, height: 120, borderRadius: 28, background: IVORY, alignItems: 'center', justifyContent: 'center', padding: 8 }}>
              {/* eslint-disable-next-line @next/next/no-img-element -- satori (next/og) solo dibuja <img>, sin el optimizador de imágenes */}
              <img src={logo} alt="" width={104} height={104} style={{ objectFit: 'contain' }} />
            </div>
          ) : null}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 32 }}>
          <div style={{ display: 'flex', flex: 1, fontSize: thumbnail && title.length > 60 ? 44 : title.length > 60 || thumbnail ? 54 : 66, fontWeight: 800, lineHeight: 1.15 }}>{title}</div>
          {thumbnail ? (
            // eslint-disable-next-line @next/next/no-img-element -- satori (next/og) solo dibuja <img>, sin el optimizador de imágenes
            <img src={thumbnail} alt="" width={220} height={220} style={{ width: 220, height: 220, borderRadius: 28, objectFit: 'cover', border: `6px solid ${IVORY}` }} />
          ) : null}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {challenge ? <div style={{ display: 'flex', fontSize: 34, fontWeight: 700, color: GOLD }}>{challenge}</div> : null}
          <div style={{ display: 'flex', width: '100%', height: 30, borderRadius: 15, background: TRACK, overflow: 'hidden' }}>
            <div style={{ display: 'flex', width: `${pct}%`, height: '100%', background: reached ? '#10b981' : GOLD }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 34, fontWeight: 800 }}>
            <div style={{ display: 'flex' }}>{progressText}</div>
            <div style={{ display: 'flex' }}>{reached ? '' : t('daysLeft', { count: remaining })}</div>
          </div>
        </div>
      </div>
    ),
    // La URL lleva `v` (fecha de la última aportación): una versión nueva es una imagen nueva, así que puede cachearse mucho tiempo.
    { ...OG_IMAGE_SIZE, headers: { 'Cache-Control': thumbnail ? 'public, max-age=600, s-maxage=3600, stale-while-revalidate=3600' : 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400' } }
    );

  if (!cover) return draw(null);
  const withCover = draw(cover);
  const body = await withCover.arrayBuffer();
  if (body.byteLength <= MAX_CARD_BYTES) return new Response(body, { status: 200, headers: withCover.headers });
  return draw(null);
}
