import { useLocale, useTranslations } from 'next-intl';
import { formatCents, type MoneyLocale } from '@/core/finance/money';
import { Link } from '@/i18n/navigation';
import { isLocale } from '@/i18n/routing';
import { achievementsPath } from '@/lib/seo/portal-routes';
import type { VisibleHuchaMode } from '@/core/public/catalog';
import { EntityCrest, heroBackground } from './entity-crest';
import { HuchaPill } from './hucha-pill';

export interface PortalHeroProps {
  orgSlug: string;
  name: string;
  vertical: 'SCHOOL' | 'SPORTS_CLUB' | 'CULTURAL';
  /** Color de acento de la entidad (`#RRGGBB`): se valida antes de pintarlo. */
  accent: string;
  /** Logotipo y portada públicos de la entidad (`/api/files/public/{id}`), si los ha subido (Sprint 4.2e). */
  logoSrc?: string | null;
  bannerSrc?: string | null;
  /** Idioma en el que la entidad escribe su nombre, si no es el de la página. */
  contentLang?: string;
  huchaMode: VisibleHuchaMode | null;
  impact: { academicYear: string; raisedCents: number; achievementsCount: number };
}

/**
 * Cabecera personalizable de la comunidad (`id="school-hero-header"`): nombre de la entidad como único `h1`, tipo de entidad, la promesa de
 * custodia en lenguaje llano (el dinero queda retenido en Paycomet; nunca «banco» ni «escrow»), la píldora de Mi Hucha según su modo y la
 * barra de impacto colectivo del curso. Fondo azul marino con el color de la entidad como acento y, si la tiene, su portada bajo un velo azul
 * marino: el texto blanco mantiene el contraste. Escudo con su logotipo o, sin él, sus iniciales.
 */
export function PortalHero({ orgSlug, name, vertical, accent, logoSrc = null, bannerSrc = null, contentLang, huchaMode, impact }: PortalHeroProps) {
  const t = useTranslations('portal');
  const current = useLocale();
  const locale: MoneyLocale = isLocale(current) ? current : 'es';

  return (
    <section
      id="school-hero-header"
      aria-labelledby="portal-name"
      className="relative overflow-hidden rounded-3xl bg-varsity-navy p-5 text-varsity-ivory shadow-xl sm:p-6"
      style={heroBackground(accent, bannerSrc)}
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <EntityCrest name={name} logoSrc={logoSrc} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 id="portal-name" lang={contentLang} className="font-joy text-2xl font-bold tracking-tight wrap-anywhere sm:text-3xl">
                {name}
              </h1>
              <span className="rounded-full border border-white/40 bg-white/15 px-3 py-0.5 text-sm font-bold">{t(`hero.kind.${vertical}`)}</span>
            </div>
            <p className="mt-1 text-base text-varsity-ivory">{t(`hero.tagline.${vertical}`)}</p>
            <p className="mt-2 inline-flex items-center gap-2 rounded-full border border-emerald-300/60 bg-emerald-950/50 px-3 py-1 text-sm font-bold text-emerald-100">
              <span aria-hidden="true">{'🔒'}</span>
              <span>{t('hero.vault')}</span>
            </p>
          </div>
        </div>
        {huchaMode ? <HuchaPill mode={huchaMode} orgSlug={orgSlug} /> : null}
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white p-4 text-varsity-navy">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="text-3xl">
            {'💛'}
          </span>
          <div>
            <p className="text-sm font-bold uppercase tracking-wide text-ink-soft">{t(`impact.label.${vertical}`, { year: impact.academicYear })}</p>
            <p className="font-corp text-lg font-extrabold tabular-nums">{t(`impact.raised.${vertical}`, { amount: formatCents(impact.raisedCents, locale) })}</p>
            <p className="text-sm font-semibold text-emerald-800">{t('impact.refund')}</p>
          </div>
        </div>
        <Link href={achievementsPath(orgSlug)} className="inline-flex min-h-11 items-center rounded-xl bg-emerald-50 px-4 py-2 font-joy text-base font-bold text-emerald-900 underline underline-offset-4">
          <span aria-hidden="true">{'✨ '}</span>
          {t('impact.achievements', { count: impact.achievementsCount })}
          <span aria-hidden="true">{' →'}</span>
        </Link>
      </div>
    </section>
  );
}
