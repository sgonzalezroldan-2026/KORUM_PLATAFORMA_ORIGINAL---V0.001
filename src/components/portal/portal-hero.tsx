import { useLocale, useTranslations } from 'next-intl';
import { formatCents, type MoneyLocale } from '@/core/finance/money';
import { isLocale } from '@/i18n/routing';
import type { VisibleHuchaMode } from '@/core/public/catalog';
import { HuchaPill } from './hucha-pill';

export interface PortalHeroProps {
  name: string;
  vertical: 'SCHOOL' | 'SPORTS_CLUB' | 'CULTURAL';
  /** Color de acento de la entidad (`#RRGGBB`): se valida antes de pintarlo. */
  accent: string;
  /** Idioma en el que la entidad escribe su nombre, si no es el de la página. */
  contentLang?: string;
  huchaMode: VisibleHuchaMode | null;
  impact: { academicYear: string; raisedCents: number; achievementsCount: number };
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Iniciales para el escudo de la entidad mientras no tenga logotipo propio: hasta dos letras, sin símbolos. */
export function monogram(name: string): string {
  const letters = name
    .split(/\s+/)
    .map((word) => [...word].find((char) => /\p{L}/u.test(char)) ?? '')
    .filter((char) => char !== '');
  return letters.slice(0, 2).join('').toUpperCase();
}

/**
 * Cabecera personalizable de la comunidad (`id="school-hero-header"`): nombre de la entidad como único `h1`, tipo de entidad, la promesa de
 * custodia en lenguaje llano (el dinero queda retenido en Paycomet; nunca «banco» ni «escrow»), la píldora de Mi Hucha según su modo y la
 * barra de impacto colectivo del curso. Fondo azul marino con el color de la entidad como acento: el texto blanco mantiene el contraste.
 */
export function PortalHero({ name, vertical, accent, contentLang, huchaMode, impact }: PortalHeroProps) {
  const t = useTranslations('portal');
  const current = useLocale();
  const locale: MoneyLocale = isLocale(current) ? current : 'es';
  const color = HEX_COLOR.test(accent) ? accent : '#f59e0b';

  return (
    <section
      id="school-hero-header"
      aria-labelledby="portal-name"
      className="relative overflow-hidden rounded-3xl bg-varsity-navy p-5 text-varsity-ivory shadow-xl sm:p-6"
      style={{ backgroundImage: `radial-gradient(circle at 100% 0%, ${color}59, transparent 55%)`, borderBottom: `6px solid ${color}` }}
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <div aria-hidden="true" className="flex size-16 shrink-0 items-center justify-center rounded-3xl border-2 border-white/80 bg-white font-joy text-2xl font-bold text-varsity-navy shadow-lg">
            {monogram(name)}
          </div>
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
        {huchaMode ? <HuchaPill mode={huchaMode} /> : null}
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
        <p className="rounded-xl bg-emerald-50 px-4 py-2 font-joy text-base font-bold text-emerald-900">
          <span aria-hidden="true">{'✨ '}</span>
          {t('impact.achievements', { count: impact.achievementsCount })}
        </p>
      </div>
    </section>
  );
}
