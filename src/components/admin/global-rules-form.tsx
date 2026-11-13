'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useId, useMemo, useState } from 'react';
import { saveRulesAction } from '@/app/[locale]/(superadmin)/admin/reglas/actions';
import { pricingRulesOf, type GlobalRulesInput } from '@/core/admin/global-rules';
import { formatBps, formatCents, type MoneyLocale } from '@/core/finance/money';
import { evaluatePricingHealth, reviewPricingAlerts, sampleTicketMargin, type PricingAcknowledgement, type PricingAlert, type PricingAlertCode } from '@/core/finance/pricing-health';
import type { RevenueSourceKey } from '@/core/finance/bi-analytics.service';
import { isLocale } from '@/i18n/routing';
import { Block, FIELD, PRIMARY } from './entity-action';
import { NUMERIC_FIELDS, fieldDef, parseState, stateOf, type NumericKey, type RulesFormState } from './global-rules-model';
import { PricingHealthPanel, type PricingAlertItem } from './pricing-health-panel';
import { RulesOutcome, useRulesAction } from './rules-action';

type Group = 'gateway' | 'brackets' | 'guarantee' | 'maintenance' | 'duration';

const NUMERIC_KEYS: ReadonlySet<string> = new Set(NUMERIC_FIELDS.map((field) => field.key));

/** En qué bloque se enseña cada aviso, junto a los campos que lo provocan. `SOURCE_NEGATIVE_MARGIN` va con la fuente afectada. */
const SOURCE_GROUP: Partial<Record<RevenueSourceKey, Group>> = { digitalTicketFeeCents: 'gateway', huchaTopupFeeCents: 'gateway', sponsorFeeCents: 'brackets' };
const CODE_GROUP: Record<Exclude<PricingAlertCode, 'SOURCE_NEGATIVE_MARGIN' | 'RULE_VALUE_INVALID'>, Group> = {
  HUCHA_FEE_BELOW_GATEWAY_COST: 'gateway',
  TICKET_FEE_BELOW_GATEWAY_COST: 'gateway',
  SPONSOR_FEE_BELOW_GATEWAY_COST: 'brackets',
  BRACKET_THRESHOLDS_INVALID: 'brackets',
  BRACKET_CLIFF: 'brackets',
  BRACKET_RATES_NOT_DECREASING: 'brackets'
};
const groupOf = (alert: PricingAlert): Group | null => (alert.code === 'SOURCE_NEGATIVE_MARGIN' ? (alert.source ? (SOURCE_GROUP[alert.source] ?? null) : null) : alert.code === 'RULE_VALUE_INVALID' ? null : CODE_GROUP[alert.code]);

function sameAlert(a: PricingAlert, b: PricingAlert) {
  return a.code === b.code && a.fingerprint === b.fingerprint && (a.source ?? '') === (b.source ?? '');
}

export interface GlobalRulesFormProps {
  rules: GlobalRulesInput;
  version: string;
  margins: Partial<Record<RevenueSourceKey, number>>;
  acknowledgements: PricingAcknowledgement[];
}

/**
 * Reglas económicas globales (prototipo `sa-sub-rules`: `saveGlobalEconomicRules` y `saveGatewayAndTopupCosts`): pasarela, fee de Mi Hucha, gastos de gestión digital,
 * tramos (modo plano o marginal, umbrales y tarifas), comercios, aportación de garantía, mantenimiento con tope anual y duración de las campañas. Mientras se escribe, la
 * **salud de precios se recalcula en vivo** y cada aviso sale junto a los campos que lo provocan, con su cifra, «Ajustar» y «Aceptar y registrar». Nada se bloquea por
 * perder dinero; lo imposible (decimales, negativos, vacíos, fuera de rango) se marca en el campo y el servidor lo rechaza igualmente.
 */
export function GlobalRulesForm({ rules, version, margins, acknowledgements }: GlobalRulesFormProps) {
  const t = useTranslations('admin.rules');
  const current = useLocale();
  const locale = isLocale(current) ? current : 'es';
  const decimal = locale === 'en' ? '.' : ',';
  const groupId = useId();
  const action = useRulesAction({ failureFocusId: 'rules-save' });
  const [state, setState] = useState<RulesFormState>(() => stateOf(rules, decimal));
  const [showInvalid, setShowInvalid] = useState(false);

  const parsed = useMemo(() => parseState(state, locale), [state, locale]);
  const savedAlerts = useMemo(() => evaluatePricingHealth(pricingRulesOf(rules), margins), [rules, margins]);
  const alerts: PricingAlertItem[] = useMemo(() => {
    const draft = parsed.rules ? evaluatePricingHealth(pricingRulesOf(parsed.rules), margins) : savedAlerts;
    return reviewPricingAlerts(draft, acknowledgements).map((alert) => ({ ...alert, unsaved: !savedAlerts.some((saved) => sameAlert(saved, alert)) }));
  }, [parsed.rules, savedAlerts, margins, acknowledgements]);
  const ticketSample = parsed.rules ? sampleTicketMargin(parsed.rules) : null;
  // Campos que el servidor ha rechazado (por ejemplo los gastos de gestión con una taquilla a la venta): se marcan igual que los imposibles.
  const serverFields: NumericKey[] = action.outcome?.status === 'REJECTED' ? action.outcome.fields.filter((key): key is NumericKey => NUMERIC_KEYS.has(key)) : [];

  // «Ajustar» desde la portada llega con #rule-… en la dirección: se enfoca el campo, como hace el «Ajustar» de esta misma pantalla.
  useEffect(() => {
    const hash = window.location.hash;
    if (hash.startsWith('#rule-')) document.getElementById(hash.slice(1))?.focus();
  }, []);
  useEffect(() => {
    const first = serverFields[0];
    // Solo cuando la acción ha terminado: mientras tanto los campos están deshabilitados y un campo deshabilitado no recibe el foco (sin límite de tiempo, a diferencia de un reintento).
    if (first && !action.pending) requestAnimationFrame(() => document.getElementById(`rule-${first}`)?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action.outcome, action.pending]);

  const setText = (key: NumericKey, value: string) => setState((previous) => ({ ...previous, texts: { ...previous.texts, [key]: value } }));
  const adjust = (settingKey: string) => {
    const target = document.getElementById(`rule-${settingKey}`);
    target?.scrollIntoView?.({ block: 'center' });
    target?.focus();
  };

  const save = () => {
    if (!parsed.rules) {
      setShowInvalid(true);
      const first = parsed.invalid[0];
      if (first) requestAnimationFrame(() => document.getElementById(`rule-${first}`)?.focus());
      return;
    }
    setShowInvalid(false);
    const payload = { rules: parsed.rules, expectedVersion: version };
    action.run(
      () => saveRulesAction(payload),
      (result) => {
        const [changed = '0', organizations = '0'] = (result.detail ?? '').split(':');
        return Number(changed) === 0 ? t('savedNothing') : t('saved', { count: Number(organizations) });
      }
    );
  };

  const money = (cents: number) => formatCents(cents, locale as MoneyLocale);
  const unitSuffix = (kind: 'eur' | 'pct' | 'days') => t(`unit.${kind}`);

  const field = (key: NumericKey, label: string, hint?: string) => {
    const rejected = serverFields.includes(key);
    const wrong = (showInvalid && parsed.invalid.includes(key)) || rejected;
    const def = fieldDef(key);
    const limits = { min: def.kind === 'eur' ? formatCents(def.min, locale as MoneyLocale) : def.kind === 'pct' ? formatBps(def.min, locale as MoneyLocale) : String(def.min), max: def.kind === 'eur' ? formatCents(def.max, locale as MoneyLocale) : def.kind === 'pct' ? formatBps(def.max, locale as MoneyLocale) : String(def.max) };
    const id = `rule-${key}`;
    return (
      <div key={key} className="flex flex-col gap-1">
        <label htmlFor={id} className="text-sm font-semibold text-ink-soft">
          {label} <span className="font-normal">{`(${unitSuffix(fieldDef(key).kind)})`}</span>
        </label>
        <input
          id={id}
          type="text"
          inputMode="decimal"
          value={state.texts[key]}
          disabled={action.pending}
          aria-invalid={wrong}
          aria-describedby={[hint ? `${groupId}-${key}-hint` : '', wrong ? `${groupId}-${key}-error` : ''].filter(Boolean).join(' ') || undefined}
          onChange={(event) => setText(key, event.target.value)}
          className={`${FIELD} tabular-nums`}
          autoComplete="off"
        />
        {hint ? (
          <p id={`${groupId}-${key}-hint`} className="text-sm text-ink-soft">
            {hint}
          </p>
        ) : null}
        {wrong ? (
          <p id={`${groupId}-${key}-error`} role="alert" className="text-sm font-semibold text-red-900">
            {rejected && !(showInvalid && parsed.invalid.includes(key)) ? t('fieldErrorServer') : t(def.kind === 'days' ? 'fieldErrorDays' : 'fieldError', limits)}
          </p>
        ) : null}
      </div>
    );
  };

  const groupAlerts = (group: Group) => {
    const items = alerts.filter((alert) => groupOf(alert) === group);
    // La región viva está siempre montada (también sin avisos): un aviso que aparece mientras se escribe dentro de un contenedor recién creado no se anunciaría.
    return <div aria-live="polite">{items.length === 0 ? null : <PricingHealthPanel alerts={items} onAdjust={adjust} />}</div>;
  };
  const topAlerts = alerts.filter((alert) => groupOf(alert) === null);

  return (
    <div className="flex flex-col gap-6" data-testid="rules-form">
      <div aria-live="polite">{topAlerts.length > 0 ? <PricingHealthPanel alerts={topAlerts} onAdjust={adjust} /> : null}</div>

      <Block id="pasarela" title={t('gateway.title')} hint={t('gateway.hint')}>
        <div className="grid gap-3 md:grid-cols-3">
          {field('gatewayPctBps', t('gateway.pct'))}
          {field('gatewayFixedCents', t('gateway.fixed'))}
          {field('topupFeeCents', t('gateway.topupFixed'), t('gateway.topupHint'))}
          {field('topupFeeBps', t('gateway.topupPct'))}
          {field('ticketFeeFixedCents', t('gateway.ticketFixed'))}
          {field('ticketFeeBps', t('gateway.ticketPct'))}
        </div>
        <div aria-live="polite">
          {ticketSample && ticketSample.marginCents > 0 ? (
            <p className="text-sm font-bold tabular-nums text-emerald-800" data-testid="ticket-margin-ok">
              <span aria-hidden="true">{'✔️ '}</span>
              {t('gateway.ticketOk', { price: money(ticketSample.priceCents), fee: money(ticketSample.feeCents), gateway: money(ticketSample.gatewayCostCents), margin: money(ticketSample.marginCents) })}
            </p>
          ) : null}
        </div>
        {groupAlerts('gateway')}
      </Block>

      <Block id="tramos" title={t('brackets.title')} hint={t('brackets.hint')}>
        <div className="flex flex-col gap-1">
          <label htmlFor="rule-bracketMode" className="text-sm font-semibold text-ink-soft">
            {t('brackets.mode')}
          </label>
          <select
            id="rule-bracketMode"
            value={state.bracketMode}
            disabled={action.pending}
            onChange={(event) => setState((previous) => ({ ...previous, bracketMode: event.target.value === 'MARGINAL' ? 'MARGINAL' : 'FLAT' }))}
            className={FIELD}
          >
            <option value="FLAT">{t('brackets.modeFLAT')}</option>
            <option value="MARGINAL">{t('brackets.modeMARGINAL')}</option>
          </select>
          <p className="text-sm text-ink-soft">{t(`brackets.modeHint.${state.bracketMode}`)}</p>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {field('exemptLimitCents', t('brackets.exempt'), t('brackets.exemptHint'))}
          {field('t1MaxCents', t('brackets.t1Max'))}
          {field('t2MaxCents', t('brackets.t2Max'))}
          {field('t1Bps', t('brackets.t1'))}
          {field('t2Bps', t('brackets.t2'))}
          {field('t3Bps', t('brackets.t3'))}
          {field('sponsorFeeBps', t('brackets.sponsor'))}
        </div>
        {groupAlerts('brackets')}
      </Block>

      <Block id="garantia" title={t('guarantee.title')} hint={t('guarantee.hint')}>
        <div className="grid gap-3 md:grid-cols-2">{field('fullIntegrityCheckCents', t('guarantee.check'))}</div>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-semibold text-ink-soft">{t('guarantee.presets')}</legend>
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
            {(['preset0', 'preset1', 'preset2', 'preset3'] as const).map((key, index) => field(key, t('guarantee.preset', { n: index + 1 })))}
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="rule-defaultGuaranteeIdx" className="text-sm font-semibold text-ink-soft">
              {t('guarantee.default')}
            </label>
            <select id="rule-defaultGuaranteeIdx" value={state.defaultGuaranteeIdx} disabled={action.pending} onChange={(event) => setState((previous) => ({ ...previous, defaultGuaranteeIdx: Number(event.target.value) }))} className={FIELD}>
              {[0, 1, 2, 3].map((index) => (
                <option key={index} value={index}>
                  {t('guarantee.presetOption', { n: index + 1, amount: state.texts[`preset${index}` as NumericKey] })}
                </option>
              ))}
            </select>
            <p className="text-sm text-ink-soft">{t('guarantee.uncheckedNote')}</p>
          </div>
        </fieldset>
      </Block>

      <Block id="mantenimiento" title={t('maintenance.title')} hint={t('maintenance.hint')}>
        <label className="flex min-h-11 items-center gap-2 font-bold text-varsity-navy">
          <input id="rule-maintActive" type="checkbox" checked={state.maintActive} disabled={action.pending} onChange={(event) => setState((previous) => ({ ...previous, maintActive: event.target.checked }))} className="size-5" />
          <span>{t('maintenance.active')}</span>
        </label>
        <div className="grid gap-3 md:grid-cols-2">
          {field('maintPerInitCents', t('maintenance.perInit'))}
          {field('maintAnnualCapCents', t('maintenance.cap'), t('maintenance.capHint'))}
        </div>
      </Block>

      <Block id="duracion" title={t('duration.title')} hint={t('duration.hint')}>
        <div className="grid gap-3 md:grid-cols-2">
          {field('maxCampaignDays', t('duration.campaign'), t('duration.campaignHint'))}
          {field('creditPoolMaxDays', t('duration.pool'), t('duration.poolHint'))}
        </div>
      </Block>

      <div className="flex flex-col gap-2">
        <p className="text-sm text-ink-soft">{t('futureOnly')}</p>
        {showInvalid && !parsed.rules ? (
          <p role="alert" className="text-sm font-semibold text-red-900">
            {t('invalidSummary', { count: parsed.invalid.length })}
          </p>
        ) : null}
        <button id="rules-save" type="button" onClick={save} disabled={action.pending} className={`${PRIMARY} self-start`} data-testid="rules-save">
          {action.pending ? t('saving') : t('save')}
        </button>
        <RulesOutcome outcome={action.outcome} failed={action.failed} />
      </div>
    </div>
  );
}
