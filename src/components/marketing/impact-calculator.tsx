'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CurrencyText } from '@/components/ui/currency-text';
import { simulateImpact, SIMULATOR_AVERAGE_CONTRIBUTION_CENTS, SIMULATOR_LIMITS, SIMULATOR_SPONSOR_LEVEL_CENTS } from '@/core/finance/impact-simulator';
import { formatBps, formatCents, parseEurosToCents, type MoneyLocale } from '@/core/finance/money';
import type { PublicPricing } from '@/core/finance/public-pricing';
import { isLocale } from '@/i18n/routing';

/** Importes de ejemplo de cada mejora: solo rellenan el campo de presupuesto, que la persona cambia por el suyo. */
const OBJECTIVES = { climate: 600_000, shade: 1_200_000, boards: 800_000, scoreboard: 450_000, trip: 600_000, instruments: 500_000 } as const;
type PresetObjective = keyof typeof OBJECTIVES;
type Objective = PresetObjective | 'custom';
const VERTICALS = ['SCHOOL', 'SPORTS_CLUB', 'CULTURAL'] as const;
type Vertical = (typeof VERTICALS)[number];
/** Qué ejemplos se ofrecen a cada tipo de entidad (un club no climatiza aulas ni una banda compra pizarras). */
const PRESETS_BY_VERTICAL: Record<Vertical, readonly PresetObjective[]> = {
  SCHOOL: ['climate', 'shade', 'boards', 'trip'],
  SPORTS_CLUB: ['scoreboard', 'shade', 'trip'],
  CULTURAL: ['instruments', 'trip']
};
/** Pausa antes de anunciar el resultado a un lector de pantalla: así no lee cada tecla del presupuesto. */
const ANNOUNCE_DELAY_MS = 600;
const MAX_SPONSORS_SHOWN = 10;

const moneyClass = 'font-corp font-extrabold tabular-nums whitespace-nowrap';
const fieldClass = 'min-h-12 w-full rounded-xl border-2 border-varsity-navy bg-white px-4 text-base';

/**
 * Simulador de impacto de la portada. Calcula la meta con la **misma pizarra TCO** que el Estudio (`simulateImpact`) y las tarifas vigentes de
 * la consola, y muestra cuántas aportaciones hacen falta con y sin comercios del barrio. Es orientativo y lo dice. Zona de dinero: capa 1.
 */
export function ImpactCalculator({ pricing }: { pricing: PublicPricing }) {
  const t = useTranslations('calculator');
  const current = useLocale();
  const locale: MoneyLocale = isLocale(current) ? current : 'es';
  const ids = { vertical: useId(), objective: useId(), cost: useId(), families: useId(), sponsors: useId(), costError: useId(), costHint: useId(), familiesError: useId() };

  const [vertical, setVertical] = useState<Vertical>('SCHOOL');
  const [objective, setObjective] = useState<Objective>('scoreboard');
  const [costText, setCostText] = useState(() => formatCents(OBJECTIVES.scoreboard, locale));
  const [familiesText, setFamiliesText] = useState('400');
  const [sponsors, setSponsors] = useState(4);
  const [announcement, setAnnouncement] = useState('');
  /** El resultado solo se anuncia tras tocar algún campo: al cargar la página el lector de pantalla no debe leerlo. */
  const touched = useRef(false);

  const outcome = useMemo(() => {
    let costCents: number | null = null;
    try {
      costCents = parseEurosToCents(costText, locale);
    } catch {
      costCents = null;
    }
    const families = /^\d{1,6}$/.test(familiesText.trim()) ? Number(familiesText.trim()) : null;
    const costError = costCents === null || costCents <= 0 || costCents > SIMULATOR_LIMITS.maxCostCents;
    const familiesError = families === null || families < SIMULATOR_LIMITS.minFamilies || families > SIMULATOR_LIMITS.maxFamilies;
    if (costError || familiesError || costCents === null || families === null) return { costError, familiesError, costCents, result: null };
    return { costError, familiesError, costCents, result: simulateImpact(pricing, { costCents, families, sponsors }) };
  }, [costText, familiesText, sponsors, pricing, locale]);

  const result = outcome.result;
  // «4.5» se lee como 4,50 € (el otro separador decimal): si lo escrito no es ya el importe con su formato, se dice cómo se ha entendido (heredado del 3.1).
  // Se compara sin distinguir espacios (el importe con formato lleva un espacio duro antes de «€»): «4.500,00 €» escrito a mano no es una reinterpretación.
  const sameText = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
  const readAs = !outcome.costError && outcome.costCents !== null && !sameText(costText, formatCents(outcome.costCents, locale)) ? formatCents(outcome.costCents, locale) : null;
  const presets = PRESETS_BY_VERTICAL[vertical];
  const announceGoal = result ? formatCents(result.goalCents, locale) : null;
  const announceRemaining = result ? formatCents(result.remainingCents, locale) : null;

  useEffect(() => {
    if (!touched.current) return;
    // Cómo se ha leído el importe va delante del resultado, en el mismo aviso con retardo: el lector de pantalla no lo repite a cada tecla.
    const readAsText = readAs ? `${t('costReadAs', { amount: readAs })} ` : '';
    const timer = setTimeout(() => setAnnouncement(announceGoal && announceRemaining ? `${readAsText}${t('announce', { goal: announceGoal, remaining: announceRemaining })}` : t('needData')), ANNOUNCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [announceGoal, announceRemaining, readAs, t]);

  function chooseVertical(next: Vertical) {
    touched.current = true;
    setVertical(next);
    const options = PRESETS_BY_VERTICAL[next];
    const first = options[0];
    if (objective !== 'custom' && !options.includes(objective) && first) {
      setObjective(first);
      setCostText(formatCents(OBJECTIVES[first], locale));
    }
  }

  return (
    <div className="mobile-stack grid gap-6 md:grid-cols-2">
      <form className="korum-notebook-sheet flex flex-col gap-4" onSubmit={(event) => event.preventDefault()} aria-label={t('formLabel')}>
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.vertical} className="font-bold text-varsity-navy">
            {t('verticalLabel')}
          </label>
          <select id={ids.vertical} value={vertical} onChange={(event) => chooseVertical(event.target.value as Vertical)} className={fieldClass}>
            {VERTICALS.map((value) => (
              <option key={value} value={value}>
                {t(`vertical.${value}`)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={ids.objective} className="font-bold text-varsity-navy">
            {t('objectiveLabel')}
          </label>
          <select
            id={ids.objective}
            value={objective}
            onChange={(event) => {
              const next = event.target.value as Objective;
              touched.current = true;
              setObjective(next);
              if (next !== 'custom') setCostText(formatCents(OBJECTIVES[next], locale));
            }}
            className={fieldClass}
          >
            {presets.map((value) => (
              <option key={value} value={value}>
                {t(`objective.${value}`)}
              </option>
            ))}
            <option value="custom">{t('objective.custom')}</option>
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={ids.cost} className="font-bold text-varsity-navy">
            {t('costLabel')}
          </label>
          <input
            id={ids.cost}
            inputMode="decimal"
            value={costText}
            onChange={(event) => {
              touched.current = true;
              setCostText(event.target.value);
              setObjective('custom');
            }}
            aria-invalid={outcome.costError}
            aria-describedby={outcome.costError ? ids.costError : ids.costHint}
            className={fieldClass}
          />
          {outcome.costError ? (
            <p id={ids.costError} role="alert" className="text-sm font-semibold text-red-800">
              {t('costError', { max: formatCents(SIMULATOR_LIMITS.maxCostCents, locale) })}
            </p>
          ) : (
            <p id={ids.costHint} className="text-sm text-ink-soft" data-testid="cost-read-as">{readAs ? t('costReadAs', { amount: readAs }) : t('costHint')}</p>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={ids.families} className="font-bold text-varsity-navy">
            {t(`families.${vertical}`)}
          </label>
          <input
            id={ids.families}
            inputMode="numeric"
            value={familiesText}
            onChange={(event) => {
              touched.current = true;
              setFamiliesText(event.target.value);
            }}
            aria-invalid={outcome.familiesError}
            aria-describedby={outcome.familiesError ? ids.familiesError : undefined}
            className={fieldClass}
          />
          {outcome.familiesError ? (
            <p id={ids.familiesError} role="alert" className="text-sm font-semibold text-red-800">
              {t('familiesError', { max: SIMULATOR_LIMITS.maxFamilies })}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={ids.sponsors} className="font-bold text-varsity-navy">
            {t('sponsorsLabel', { count: sponsors })}
          </label>
          <input
            id={ids.sponsors}
            type="range"
            min={0}
            max={MAX_SPONSORS_SHOWN}
            value={sponsors}
            onChange={(event) => {
              touched.current = true;
              setSponsors(Number(event.target.value));
            }}
            aria-valuetext={t('sponsorsValue', { count: sponsors })}
            className="min-h-11 w-full accent-varsity-emerald"
          />
          <p className="text-sm text-ink-soft">{t('sponsorsHint', { level: formatCents(SIMULATOR_SPONSOR_LEVEL_CENTS, locale) })}</p>
        </div>
      </form>

      <section aria-labelledby="calculator-result" className="korum-trust-vault flex flex-col gap-4 p-5">
        <p role="status" className="sr-only">
          {announcement}
        </p>
        <h3 id="calculator-result" className="font-corp text-xl font-extrabold text-varsity-navy">
          {t('resultTitle')}
        </h3>
        {result ? (
          <>
            <p className="text-lg">
              {t.rich('goal', { amount: formatCents(result.goalCents, locale), strong: (chunks) => <strong className={moneyClass + ' text-2xl text-varsity-emerald'}>{chunks}</strong> })}
            </p>
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
              <dt>{t('breakdown.net')}</dt>
              <dd className="text-end">
                <CurrencyText cents={result.netForEntityCents} />
              </dd>
              <dt>{t('breakdown.commission', { exempt: formatCents(result.exemptUsedCents, locale) })}</dt>
              <dd className="text-end">
                <CurrencyText cents={result.commissionCents} />
              </dd>
              <dt>{t('breakdown.maintenance')}</dt>
              <dd className="text-end">
                <CurrencyText cents={result.maintenanceCents} />
              </dd>
              <dt>{t('breakdown.gateway')}</dt>
              <dd className="text-end">
                <CurrencyText cents={result.gatewayCents} />
              </dd>
            </dl>
            <hr className="border-patio-rule" />
            <p>
              {t.rich('remaining', {
                amount: formatCents(result.remainingCents, locale),
                strong: (chunks) => <strong className={moneyClass}>{chunks}</strong>,
                sponsors: sponsors === 0 ? t('noSponsors') : t('withSponsors', { count: sponsors })
              })}
            </p>
            {result.remainingCents === 0 ? (
              <p className="font-bold text-varsity-emerald">{t('coveredBySponsors')}</p>
            ) : (
              <ul className="flex list-disc flex-col gap-2 ps-6 marker:text-varsity-gold-deep">
                <li>
                  {result.participationPct > 100
                    ? t('tooMuch', { average: formatCents(SIMULATOR_AVERAGE_CONTRIBUTION_CENTS, locale) })
                    : t('atAverage', {
                        average: formatCents(SIMULATOR_AVERAGE_CONTRIBUTION_CENTS, locale),
                        count: result.contributorsNeeded,
                        pct: formatBps(result.participationPct * 100, locale)
                      })}
                </li>
                <li>{t.rich('ifHalf', { average: formatCents(result.averageIfHalfCents, locale), strong: (chunks) => <strong className={moneyClass}>{chunks}</strong> })}</li>
              </ul>
            )}
            <p className="text-sm text-ink-soft">{t('disclaimer', { exempt: formatCents(pricing.exemptLimitCents, locale) })}</p>
          </>
        ) : (
          <p role="status" className="text-ink-soft">
            {t('needData')}
          </p>
        )}
      </section>
    </div>
  );
}
