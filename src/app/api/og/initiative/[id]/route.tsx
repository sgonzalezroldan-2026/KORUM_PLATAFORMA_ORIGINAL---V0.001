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

/**
 * Tarjeta para WhatsApp y redes de una iniciativa (`/api/og/initiative/12?locale=es&grupo=3-primaria&v=1730000000000`), 1200×630. Diseño plano
 * (azul marino, oro y marfil, sin fotografías), así que pesa unos pocos KB, muy por debajo de los 300 KB que admite WhatsApp (QA-F02). Dibuja
 * el avance real, los días que quedan y, si `grupo` es un curso, equipo o grupo que ya suma familias, su reto **en positivo y sin nombres**.
 * El texto de la URL nunca se dibuja: `locale` y `grupo` solo se comparan con valores conocidos. `v` solo versiona la caché de WhatsApp.
 */
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

  const t = await getTranslations({ locale, namespace: 'portal.og' });
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
  const entity = fitText(plain(initiative.organization.name), 60);

  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: 64, background: NAVY, color: IVORY, borderTop: `14px solid ${GOLD}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <KorumMarkSvg size={84} variant="simple" decorative />
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', fontSize: 40, fontWeight: 800, letterSpacing: 8 }}>{brand('name')}</div>
            <div style={{ display: 'flex', fontSize: 28, color: GOLD }}>{t('forEntity', { entity })}</div>
          </div>
        </div>
        <div style={{ display: 'flex', fontSize: title.length > 60 ? 54 : 66, fontWeight: 800, lineHeight: 1.15 }}>{title}</div>
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
    { ...OG_IMAGE_SIZE, headers: { 'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400' } }
  );
}
