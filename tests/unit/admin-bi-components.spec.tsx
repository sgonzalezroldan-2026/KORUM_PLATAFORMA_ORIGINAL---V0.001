import { fireEvent, screen, within } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { BiInitiativesTables } from '@/components/admin/bi-initiatives-tables';
import { BiOrganizationsTable } from '@/components/admin/bi-organizations-table';
import { BiSummary } from '@/components/admin/bi-summary';
import { InitiativeDiagnosis } from '@/components/admin/initiative-diagnosis';
import { RevenueSourcesChart } from '@/components/admin/revenue-sources-chart';
import { type BiInitiativeFacts, type BiOrganizationFacts, buildBiInitiativeRow, buildBiOrganizationRows } from '@/core/finance/bi-aggregate';
import { summarizeProjection, sumRealRevenues } from '@/core/finance/bi-summary';
import { pricingMessageValues } from '@/core/finance/pricing-alert-format';
import { evaluatePricingHealth } from '@/core/finance/pricing-health';
import { LOCALES, type Locale } from '@/i18n/routing';
import { loadSeedData } from '@/seed/seed-types';
import type { KorumGlobalRulesCents } from '@/types/korum.types';
import ca from '../../messages/ca.json';
import en from '../../messages/en.json';
import es from '../../messages/es.json';
import { renderWithIntl } from '../utils/render-with-intl';

const MESSAGES = { es, ca, en };
/** Los importes llevan un espacio duro antes del «€»: se compara con espacios normales. */
const plain = (text: string) => text.replace(/ /g, ' ');

const facts = (overrides: Partial<BiInitiativeFacts>): BiInitiativeFacts => ({
  id: 1,
  walletEscrowId: 'WLT-ESC-001',
  title: 'Patio cubierto',
  organizationId: 'A',
  organizationName: 'CEIP Cervantes',
  organizationSlug: 'cervantes',
  province: 'Barcelona',
  status: 'FUNDRAISING',
  format: 'BUDGET',
  quarter: '2026-Q4',
  closesAt: '2026-12-15T10:00:00.000Z',
  goalCents: 100_000,
  raisedCents: 50_000,
  totalContributions: 12,
  bracketFeeCents: 4_000,
  maintFeeCents: 0,
  gatewayFeeCents: 1_500,
  absorbsGatewayCostByKorum: false,
  realizedGuaranteeCents: 0,
  projectedGuaranteeAt100Cents: 0,
  approvedSponsorsFeeCents: 0,
  ticketMarginAt100Cents: 0,
  ticketMarginRealizedCents: 0,
  huchaTopupNetCents: 0,
  settled: { sourcesCents: { bracketFeeCents: 0, supportGuaranteeCents: 0, sponsorFeeCents: 0, digitalTicketFeeCents: 0, maintFeeCents: 0, huchaTopupFeeCents: 0 }, costsCents: 0 },
  ...overrides
});

describe('QA-A01 · tablas ordenables de la consola', () => {
  const organizations: BiOrganizationFacts[] = [
    { id: 'A', slug: 'cervantes', name: 'CEIP Cervantes', province: 'Barcelona', health: 'OK', medalRank: 3, completedThisYear: 2, completedHistorical: 9, activeSponsorsCount: 4, historicalSponsorsCount: 7 },
    { id: 'B', slug: 'sanjose', name: 'Colegio San José', province: 'Madrid', health: 'OK', medalRank: 1, completedThisYear: 0, completedHistorical: 3, activeSponsorsCount: 1, historicalSponsorsCount: 2 }
  ];
  const rows = [
    buildBiInitiativeRow(facts({ id: 1, organizationId: 'A', title: 'Patio cubierto', raisedCents: 20_000, totalContributions: 5 })),
    buildBiInitiativeRow(facts({ id: 2, organizationId: 'B', organizationName: 'Colegio San José', title: 'Biblioteca', raisedCents: 90_000, totalContributions: 40, bracketFeeCents: 9_000 })),
    buildBiInitiativeRow(facts({ id: 3, organizationId: 'A', title: 'Huerto', raisedCents: 60_000, totalContributions: 22, status: 'CLOSED' }))
  ];

  it('la tabla de entidades lleva Cerradas (Año / Hist.) y Comercios (Act. / Hist.), ordena de mayor a menor y al revés', () => {
    renderWithIntl(<BiOrganizationsTable rows={buildBiOrganizationRows(organizations, rows)} />);
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: /Cerradas \(Año \/ Hist\.\)/ })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: /Comercios \(Act\. \/ Hist\.\)/ })).toBeInTheDocument();
    expect(within(table).getByText('2 este curso / 9 hist.')).toBeInTheDocument();
    expect(within(table).getByText('4 act. / 7 hist.')).toBeInTheDocument();

    const names = () => within(table).getAllByRole('row').slice(1, 3).map((row) => within(row).getAllByRole('rowheader')[0]!.textContent);
    // Por defecto, de mayor a menor recaudado: San José (90.000) antes que Cervantes (20.000).
    expect(names()[0]).toContain('Colegio San José');
    fireEvent.click(within(table).getByRole('button', { name: 'Ordenar por Recaudado' }));
    expect(names()[0]).toContain('CEIP Cervantes');
    fireEvent.click(within(table).getByRole('button', { name: 'Ordenar por Medalla' }));
    expect(names()[0]).toContain('CEIP Cervantes');
    fireEvent.click(within(table).getByRole('button', { name: 'Ordenar por Medalla' }));
    expect(names()[0]).toContain('Colegio San José');
  });

  it('el top 10 ordena todas las filas y se queda con 10; el listado global filtra por estado y lleva 💛 Aportaciones', () => {
    const many = Array.from({ length: 14 }, (_, index) => buildBiInitiativeRow(facts({ id: 100 + index, title: `Iniciativa ${index + 1}`, raisedCents: 1_000 * (index + 1), totalContributions: index + 1 })));
    renderWithIntl(<BiInitiativesTables rows={many} truncated={false} />);
    const top = screen.getByTestId('bi-top10');
    expect(within(top).getAllByRole('row')).toHaveLength(11); // cabecera + 10
    expect(within(top).getByRole('columnheader', { name: /Aportaciones/ })).toBeInTheDocument();
    // Por defecto, de mayor a menor recaudado: la 14 va primera y la 4 es la última del top.
    expect(within(top).getAllByRole('row')[1]).toHaveTextContent('Iniciativa 14');
    expect(within(top).queryByText('Iniciativa 3')).not.toBeInTheDocument();
    // Ordenando por aportaciones al revés (ascendente), el top 10 cambia de contenido: sale la 1.
    fireEvent.click(within(top).getByRole('button', { name: 'Ordenar por Aportaciones' }));
    fireEvent.click(within(top).getByRole('button', { name: 'Ordenar por Aportaciones' }));
    expect(within(top).getAllByRole('row')[1]).toHaveTextContent('Iniciativa 1');

    const global = screen.getByTestId('bi-global');
    expect(within(global).getAllByRole('row')).toHaveLength(15);
    fireEvent.change(within(global).getByLabelText('Mostrar'), { target: { value: 'FINISHED' } });
    expect(within(global).getByText('No hay iniciativas con los filtros elegidos.')).toBeInTheDocument();
  });

  it('el listado global muestra solo las terminadas y avisa si la vista está recortada', () => {
    renderWithIntl(<BiInitiativesTables rows={rows} truncated />);
    expect(screen.getByTestId('bi-truncated')).toHaveTextContent('solo las más recientes');
    const global = screen.getByTestId('bi-global');
    fireEvent.change(within(global).getByLabelText('Mostrar'), { target: { value: 'FINISHED' } });
    expect(within(global).getAllByRole('row')).toHaveLength(2); // cabecera + la cerrada
    expect(within(global).getByText('Huerto')).toBeInTheDocument();
    fireEvent.change(within(global).getByLabelText('Mostrar'), { target: { value: 'ACTIVE' } });
    expect(within(global).queryByText('Huerto')).not.toBeInTheDocument();
    expect(within(global).getByText('Biblioteca')).toBeInTheDocument();
  });
});

describe('Regla 02 §10 · diagnóstico 🚨 y 💎 con texto exacto', () => {
  it('🚨 retorno negativo: texto oficial con la cifra', () => {
    const row = buildBiInitiativeRow(facts({ absorbsGatewayCostByKorum: true, bracketFeeCents: 0, gatewayFeeCents: 6_250 }));
    renderWithIntl(<InitiativeDiagnosis row={row} />);
    expect(screen.getByText(/¡Peligro Retorno Negativo!/)).toHaveTextContent('🚨 ¡Peligro Retorno Negativo! (-62,50 €) · Ajustar precios');
  });

  it('💎 Auto-Impulso rentable: texto oficial con lo que falta y el retorno', () => {
    const row = buildBiInitiativeRow(facts({ raisedCents: 90_000, bracketFeeCents: 15_000 }));
    renderWithIntl(<InitiativeDiagnosis row={row} />);
    expect(screen.getByText(/Auto-Impulso Rentable/)).toHaveTextContent('💎 ¡Auto-Impulso Rentable! Aportar 100,00 € ➔ Retorno +50,00 €');
  });

  it('en inglés y catalán usa el formato de importes de su idioma', () => {
    const row = buildBiInitiativeRow(facts({ raisedCents: 90_000, bracketFeeCents: 15_000 }));
    renderWithIntl(<InitiativeDiagnosis row={row} />, 'en');
    expect(screen.getByText(/Profitable Auto-Boost/)).toHaveTextContent('💎 Profitable Auto-Boost! Contribute €100.00 ➔ Return +€50.00');
  });

  it('una campaña a medias dice en llano si completarla compensa a KORUM', () => {
    const loses = buildBiInitiativeRow(facts({ goalCents: 400_000, raisedCents: 40_000, bracketFeeCents: 4_000 }));
    renderWithIntl(<InitiativeDiagnosis row={loses} />);
    expect(plain(screen.getByText(/Faltan/).textContent ?? '')).toBe('Faltan 3.600,00 €: completarlos le costaría a KORUM 3.560,00 € más de lo que gana');
  });

  it('los trimestres se escriben como una persona los lee, en los tres idiomas', () => {
    const label = (locale: Locale) => createTranslator({ locale, messages: MESSAGES[locale], namespace: 'admin' })('quarterLabel', { year: '2026', quarter: '4' });
    expect(label('es')).toBe('4.º trimestre de 2026');
    expect(label('ca')).toBe('4t trimestre de 2026');
    expect(label('en')).toBe('Q4 2026');
    expect(createTranslator({ locale: 'es', messages: es, namespace: 'admin' })('quarterLabel', { year: '2027', quarter: '1' })).toBe('1.er trimestre de 2027');
  });

  it('una campaña vencida con algo por completar no dice «completarlo le dejaría»: no hay Auto-Impulso posible', () => {
    const settledSources = { bracketFeeCents: 0, supportGuaranteeCents: 0, sponsorFeeCents: 12_000, digitalTicketFeeCents: 0, maintFeeCents: 0, huchaTopupFeeCents: 0 };
    const expired = buildBiInitiativeRow(facts({ status: 'EXPIRED', raisedCents: 50_000, settled: { sourcesCents: settledSources, costsCents: 0 } }));
    const { container } = renderWithIntl(<InitiativeDiagnosis row={expired} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/Faltan/)).not.toBeInTheDocument();
  });

  it('completa y a medias dicen su estado con texto', () => {
    renderWithIntl(<InitiativeDiagnosis row={buildBiInitiativeRow(facts({ status: 'CLOSED', raisedCents: 100_000, goalCents: 100_000 }))} />);
    expect(screen.getByText('✅ 100 % completada')).toBeInTheDocument();
  });
});

describe('Regla 02 §10 · real frente a proyectado, separados', () => {
  const rows = [buildBiInitiativeRow(facts({ id: 1, bracketFeeCents: 10_000, approvedSponsorsFeeCents: 3_750 })), buildBiInitiativeRow(facts({ id: 2, status: 'CLOSED', bracketFeeCents: 4_000 }))];
  const projection = summarizeProjection(rows);
  const real = sumRealRevenues([
    { sourcesCents: { bracketFeeCents: 4_000, supportGuaranteeCents: 500, sponsorFeeCents: 3_750, digitalTicketFeeCents: 0, maintFeeCents: 0, huchaTopupFeeCents: 0 }, gatewayNetCostCents: 600, autoBoostExpenseCents: 0, chargebackLossesCents: 0 }
  ]);

  it('dos bloques con su titular: lo cobrado y la proyección, con cifras distintas', () => {
    renderWithIntl(<BiSummary real={real} projection={projection} />);
    expect(screen.getByRole('heading', { name: 'Ingresos reales (lo ya cobrado)' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Proyección al 100 % de las campañas abiertas' })).toBeInTheDocument();
    expect(within(screen.getByTestId('kpi-real-net')).getByText('76,50 €').getAttribute('data-cents')).toBe('7650');
    expect(within(screen.getByTestId('kpi-expected-net')).getByText('137,50 €').getAttribute('data-cents')).toBe('13750');
  });

  it('el gráfico suma al céntimo en cada columna: fuentes menos costes igual al neto', () => {
    renderWithIntl(<RevenueSourcesChart real={real} projection={projection} />);
    const chart = screen.getByTestId('revenue-sources');
    expect(within(chart).getAllByRole('row').filter((row) => row.hasAttribute('data-source'))).toHaveLength(6);
    expect(within(screen.getByTestId('sources-net-real')).getByText('76,50 €').getAttribute('data-cents')).toBe('7650');
    expect(within(screen.getByTestId('sources-net-projected')).getByText('137,50 €').getAttribute('data-cents')).toBe('13750');
    // Sin proyección de Auto-Impulso ni contracargos: la columna proyectada lo dice con texto.
    expect(within(chart).getAllByText('No se proyecta')).toHaveLength(2);
  });
});

describe('QA-FIN06 · insignia y textos de los avisos de precios', () => {
  const defaults: KorumGlobalRulesCents = loadSeedData().globalRules;

  it('con los valores por defecto, cada aviso se escribe con su cifra exacta en castellano', () => {
    const t = createTranslator({ locale: 'es', messages: es, namespace: 'admin.pricingHealth' });
    const [hucha, cliff] = evaluatePricingHealth(defaults);
    expect(plain(t(`message.${hucha!.code}`, pricingMessageValues(hucha!, 'es')))).toBe('Un cargo de 50,00 € en Mi Hucha cuesta 0,59 € de pasarela y cobras 0,25 €: pierdes 0,34 € por cargo. Es rentable hasta 16,00 €.');
    expect(plain(t(`message.${cliff!.code}`, pricingMessageValues(cliff!, 'es')))).toBe(
      'Con 1.000,00 € exentos, un neto de 5.000,00 € paga 200,00 € de comisión y uno 1 céntimo mayor paga 160,00 €: subir el presupuesto baja la comisión. Hay 2 saltos así; el mayor baja 140,00 €. Considera el modo marginal.'
    );
  });

  it('todos los códigos se escriben sin errores en los tres idiomas, con sus cifras y sin llaves sueltas', () => {
    // Una combinación que dispara todos los avisos: Hucha, entradas, patrocinio, escalón, umbrales cruzados y tarifas que suben.
    const everything = evaluatePricingHealth(
      { ...defaults, ticketFeeFixedCents: 0, ticketFeeBps: 0, sponsorFeeBps: 0, t1Bps: 100, t2Bps: 400, t3Bps: 500 },
      { digitalTicketFeeCents: -816, sponsorFeeCents: -100, huchaTopupFeeCents: -50 }
    );
    const crossed = evaluatePricingHealth({ ...defaults, t1MaxCents: 2_000_000, t2MaxCents: 1_000_000 });
    const invalid = evaluatePricingHealth({ ...defaults, topupFeeCents: -1, ticketFeeBps: 1.5 });
    // Con los valores por defecto sí salta el escalón (el modo es `FLAT` y las tarifas bajan).
    const cliff = evaluatePricingHealth(defaults);
    const all = [...everything, ...crossed, ...invalid, ...cliff];
    const codes = new Set(all.map((alert) => alert.code));
    expect([...codes].sort()).toEqual(['BRACKET_CLIFF', 'BRACKET_RATES_NOT_DECREASING', 'BRACKET_THRESHOLDS_INVALID', 'HUCHA_FEE_BELOW_GATEWAY_COST', 'RULE_VALUE_INVALID', 'SOURCE_NEGATIVE_MARGIN', 'SPONSOR_FEE_BELOW_GATEWAY_COST', 'TICKET_FEE_BELOW_GATEWAY_COST'].sort());

    for (const locale of LOCALES as readonly Locale[]) {
      const t = createTranslator({ locale, messages: MESSAGES[locale], namespace: 'admin.pricingHealth' });
      for (const alert of all) {
        const text = t(`message.${alert.code}`, pricingMessageValues(alert, locale));
        expect(text, `${locale}:${alert.code}`).not.toMatch(/[{}]/);
        expect(text, `${locale}:${alert.code}`).not.toMatch(/undefined|NaN/);
        if (alert.code === 'SOURCE_NEGATIVE_MARGIN') expect(t(`source.${alert.source!}`)).not.toBe('');
      }
    }
  });

  it('un margen de entrada igual a 0 no dice «pierdes»: KORUM no gana nada', () => {
    // Pasarela de 0,09 € fijos y gastos de gestión de 0,09 € fijos: el margen es exactamente 0 en cualquier precio.
    const alert = evaluatePricingHealth({ ...defaults, gatewayPctBps: 0, gatewayFixedCents: 9, ticketFeeFixedCents: 9, ticketFeeBps: 0 }).find((candidate) => candidate.code === 'TICKET_FEE_BELOW_GATEWAY_COST');
    expect(alert?.params.lossCents).toBe(0);
    const text = createTranslator({ locale: 'es', messages: es, namespace: 'admin.pricingHealth' })(`message.${alert!.code}`, pricingMessageValues(alert!, 'es'));
    expect(text).toContain('no gana nada');
    expect(text).not.toContain('pierdes');
  });
});
