---
name: korum-tco-calculator
description: Motor matemático TCO en céntimos enteros de KORUM. Cargar siempre que se programen o modifiquen presupuestos de iniciativas, exenciones base, becas por medallas (Bronce/Plata/Oro), cálculo real de pasarela Paycomet, desglose público de 4 líneas, analítica BI (Real vs. Proyectada) o alertas de Auto-Impulso Rentable y Retorno Negativo.
---

# Skill · Motor Matemático TCO en Céntimos, Exenciones y Analítica BI

## 1. Regla de Oro: Céntimos Enteros (`Int`) y Puntos Básicos (`Bps`)
- **Prohibido usar `Float` para dinero:** Todos los importes se expresan en **céntimos enteros (`1 € = 100 cts`)** y los porcentajes en **puntos básicos (`1,00% = 100 bps`, `5,00% = 500 bps`)**, coincidiendo con el formato nativo de Paycomet REST API y eliminando errores de coma flotante IEEE-754.
- **Independencia 100% de Proveedores:** KORUM nunca suma márgenes ni comisiones sobre presupuestos de proveedores; opera exclusivamente con las reglas transparentes del centro (`customRules: true`) o globales (`globalRules`).
- **Reserva Reversible de Cupos:** El cupo exento anual (`exemptLimitCents`), la beca de medalla y el tope anual de mantenimiento (`maintAnnualCapCents`) se reservan al pasar a `Recaudando` y **se restituyen íntegramente si la iniciativa se cancela o reembolsa sin éxito**.

---

## 2. Fórmulas Exactas del Estudio de Edición (Modo `BUDGET`)

```typescript
export interface BudgetTcoInputCents {
  costMatCents: number;               // Presupuesto proveedor en céntimos
  costInstCents: number;              // Instalación / obra en céntimos
  contingencyBps: number;             // % Reserva (ej. 10% = 1000 bps)
  isCategoryExempt: boolean;          // true si la categoría es 0% y supera el candado semántico \b
  baseExemptRemainingCents: number;   // Cupo exento anual disponible (ej. 100000 = 1.000,00 €)
  medalGrantAvailableCents: number;   // Beca exenta por medalla disponible (50000, 100000 o 200000)
  ratesBps: { t1: number; t2: number; t3: number }; // ej. 500, 400, 300 bps
  maintConfig: {
    active: boolean;
    perInitCents: number;
    annualCapCents: number;
    alreadyChargedOrReservedCents: number;
  };
  gatewayConfig: {
    pctBps: number;                   // ej. 1,00% = 100 bps
    fixedCents: number;               // ej. 0,09 € = 9 cts
    defaultDonationTicketCents: number; // ej. 25,00 € = 2500 cts
  };
}

export function calculateStudioBudgetTCO(input: BudgetTcoInputCents) {
  const baseExecutionCents = input.costMatCents + input.costInstCents;
  const contingencyCents = Math.round((baseExecutionCents * input.contingencyBps) / 10000);
  const netGuaranteedForSchoolCents = baseExecutionCents + contingencyCents;

  let bracketRateBps = 0;
  let defaultExemptUsedCents = 0;
  let medalExemptUsedCents = 0;
  let medalSavedCents = 0;
  let bracketFeeCents = 0;

  if (!input.isCategoryExempt && netGuaranteedForSchoolCents > 0) {
    if (netGuaranteedForSchoolCents <= 500_000) bracketRateBps = input.ratesBps.t1;
    else if (netGuaranteedForSchoolCents <= 1_500_000) bracketRateBps = input.ratesBps.t2;
    else bracketRateBps = input.ratesBps.t3;

    // Línea 1: Importe Exento por Defecto
    defaultExemptUsedCents = Math.min(netGuaranteedForSchoolCents, input.baseExemptRemainingCents);
    const afterDefaultCents = Math.max(0, netGuaranteedForSchoolCents - defaultExemptUsedCents);

    // Línea 2: Beca Exenta por Medalla Ganada
    medalExemptUsedCents = Math.min(afterDefaultCents, input.medalGrantAvailableCents);
    medalSavedCents = Math.round((medalExemptUsedCents * bracketRateBps) / 10000);

    // Línea 3: Resto sujeto a tramo
    const taxableRemainderCents = Math.max(0, afterDefaultCents - medalExemptUsedCents);
    bracketFeeCents = Math.round((taxableRemainderCents * bracketRateBps) / 10000);
  }

  // Línea 4: Cuota de Mantenimiento con Tope Anual Auto-Desactivable ("La Baza")
  // Si es 0 cts, la UI muestra únicamente "0,00 €" (prohibido mostrar "(Desactivado)").
  let maintFeeCents = 0;
  if (input.maintConfig.active && netGuaranteedForSchoolCents > 0) {
    const remainingToCapCents = Math.max(
      0,
      input.maintConfig.annualCapCents - input.maintConfig.alreadyChargedOrReservedCents
    );
    maintFeeCents = Math.min(input.maintConfig.perInitCents, remainingToCapCents);
  }

  // Línea 5: Coste de Pasarela Escrow (Paycomet) + Cuadre Exacto al Euro Superior
  const subtotalBeforeGatewayCents = netGuaranteedForSchoolCents + bracketFeeCents + maintFeeCents;
  const ticketRefCents = Math.max(500, input.gatewayConfig.defaultDonationTicketCents || 2500);
  const estTransactions = subtotalBeforeGatewayCents > 0
    ? Math.max(1, Math.ceil(subtotalBeforeGatewayCents / ticketRefCents))
    : 0;

  const rawVariableGwCents = Math.round((subtotalBeforeGatewayCents * input.gatewayConfig.pctBps) / 10000);
  const rawFixedGwCents = estTransactions * input.gatewayConfig.fixedCents;
  const rawGatewayFeeCents = rawVariableGwCents + rawFixedGwCents;

  // Redondeo al euro entero superior (múltiplo de 100 cts) absorbiendo los céntimos en el colchón de pasarela
  // Garantiza 0,00 € de descuadre: netGuaranteed + bracketFee + maintFee + gatewayFee === finalGoalCents
  const unroundedGoalCents = subtotalBeforeGatewayCents + rawGatewayFeeCents;
  const finalGoalCents = unroundedGoalCents > 0 ? Math.ceil(unroundedGoalCents / 100) * 100 : 0;
  const roundingBufferCents = finalGoalCents - unroundedGoalCents;
  const gatewayFeeCents = rawGatewayFeeCents + roundingBufferCents;

  return {
    baseExecutionCents,
    contingencyCents,
    netGuaranteedForSchoolCents,
    defaultExemptUsedCents,
    medalExemptUsedCents,
    medalSavedCents,
    bracketRateBps,
    bracketFeeCents,
    maintFeeCents,
    estTransactions,
    rawGatewayFeeCents,
    roundingBufferCents,
    gatewayFeeCents,
    finalGoalCents
  };
}
```

---

## 3. Fórmulas Exactas en Modo Taquilla (`TICKETING`) y Validador Paycomet

En modo `'ADD'`, Paycomet aplica su `% variable` sobre el **cobro bruto total al comprador** (`ticketPriceCents + digitalFeeUnitCents`):

```typescript
export function calculateStudioTicketingTCO(input: {
  ticketPriceCents: number;
  ticketMax: number;
  feeMode: 'ADD' | 'INC';
  digitalFeeConfig: { fixedCents: number; pctBps: number };
  gatewayConfig: { pctBps: number; fixedCents: number };
  maintFeeCents: number;
}) {
  const digitalFeeUnitCents =
    input.digitalFeeConfig.fixedCents +
    Math.round((input.ticketPriceCents * input.digitalFeeConfig.pctBps) / 10000);

  const buyerUnitChargeCents =
    input.feeMode === 'ADD'
      ? input.ticketPriceCents + digitalFeeUnitCents
      : input.ticketPriceCents;

  const gatewayUnitCostCents =
    Math.round((buyerUnitChargeCents * input.gatewayConfig.pctBps) / 10000) +
    input.gatewayConfig.fixedCents;

  const netKorumMarginPerTicketCents = digitalFeeUnitCents - gatewayUnitCostCents;
  const grossTicketsCents = input.ticketPriceCents * input.ticketMax;
  const totalDigitalFeesCents = digitalFeeUnitCents * input.ticketMax;
  const totalGatewayCostCents = gatewayUnitCostCents * input.ticketMax;

  const netGuaranteedForSchoolCents =
    input.feeMode === 'ADD'
      ? Math.max(0, grossTicketsCents - input.maintFeeCents)
      : Math.max(0, grossTicketsCents - totalDigitalFeesCents - input.maintFeeCents);

  return {
    digitalFeeUnitCents,
    buyerUnitChargeCents,
    gatewayUnitCostCents,
    netKorumMarginPerTicketCents,
    grossTicketsCents,
    totalDigitalFeesCents,
    totalGatewayCostCents,
    netGuaranteedForSchoolCents,
    isGatewayCovered: netKorumMarginPerTicketCents > 0
  };
}
```

---

## 4. Cuadre Público de 4 Líneas en la Ficha de Familias (100% Meta)

```typescript
export function calculatePublicBreakdown4Lines(init: {
  costMatCents: number;
  costInstCents: number;
  contingencyBps: number;
  goalCents: number;
}) {
  const line1ProviderCents = init.costMatCents;
  const line2InstallCents = init.costInstCents;
  const line3ContingencyCents = Math.round(
    ((line1ProviderCents + line2InstallCents) * init.contingencyBps) / 10000
  );
  const realExecutionTotalCents = line1ProviderCents + line2InstallCents + line3ContingencyCents;
  const line4EscrowAndGuaranteeCents = Math.max(0, init.goalCents - realExecutionTotalCents);

  return {
    line1ProviderCents,
    line2InstallCents,
    line3ContingencyCents,
    line4EscrowAndGuaranteeCents,
    realExecutionTotalCents,
    totalGoalCents: init.goalCents
  };
}
```

---

## 5. Analítica BI Real vs. Proyectada y Alertas Algorítmicas (Cero Ingresos Ficticios)

- **Prohibido inventar constantes mágicas** (`8,00 €` fijos de Hucha o `1%` de comercios cuando hay `0` comercios).
- Las **6 vías del Gráfico de Fuentes de Ingresos** (`supportGuaranteeCents`, `bracketFeeCents`, `sponsorFeeCents`, `digitalTicketFeeCents`, `maintFeeCents`, `huchaTopupNetFeeCents`) se suman exactamente igual en el gráfico que en `netRevenueCents`:

```typescript
export function analyzeInitiativeProfitabilityAndSelfBoost(input: {
  format: 'BUDGET' | 'TICKETING';
  status: string;
  goalCents: number;
  raisedCents: number;
  bracketFeeCents: number;
  maintFeeCents: number;
  gatewayFeeCents: number;
  absorbsGatewayCostByKorum: boolean;
  realizedGuaranteeTipsCents: number;
  projectedGuaranteeTipsAt100Cents: number;
  approvedSponsorsFeeCents: number;
  netDigitalTicketMarginAt100Cents: number;
  allocatedHuchaTopupNetCents: number; // Margen neto real de recargas de Hucha de usuarios del centro
}) {
  const bracketFeeCents = input.format === 'BUDGET' ? input.bracketFeeCents : 0;
  const supportGuaranteeCents =
    input.format === 'BUDGET' && !input.absorbsGatewayCostByKorum
      ? Math.max(input.realizedGuaranteeTipsCents, input.projectedGuaranteeTipsAt100Cents)
      : 0;
  const sponsorFeeCents = input.approvedSponsorsFeeCents;
  const digitalTicketFeeCents =
    input.format === 'TICKETING' ? Math.max(0, input.netDigitalTicketMarginAt100Cents) : 0;
  const maintFeeCents = input.maintFeeCents;
  const huchaTopupFeeCents = input.allocatedHuchaTopupNetCents;

  const gatewayLossCents =
    input.format === 'TICKETING' && input.netDigitalTicketMarginAt100Cents < 0
      ? Math.abs(input.netDigitalTicketMarginAt100Cents)
      : input.absorbsGatewayCostByKorum
      ? input.gatewayFeeCents
      : 0;

  const netRevenueCents =
    bracketFeeCents +
    supportGuaranteeCents +
    sponsorFeeCents +
    digitalTicketFeeCents +
    maintFeeCents +
    huchaTopupFeeCents -
    gatewayLossCents;

  const missingTo100Cents = Math.max(0, input.goalCents - input.raisedCents);
  const netProfitAfterBoostCents = netRevenueCents - missingTo100Cents;

  return {
    sourcesCents: {
      bracketFeeCents,
      supportGuaranteeCents,
      sponsorFeeCents,
      digitalTicketFeeCents,
      maintFeeCents,
      huchaTopupFeeCents,
      gatewayLossCents
    },
    netRevenueCents,
    missingTo100Cents,
    netProfitAfterBoostCents,
    isNegativeReturnAlert: netRevenueCents < 0,
    isProfitableSelfBoost:
      netRevenueCents > 0 &&
      input.status === 'Recaudando' &&
      missingTo100Cents > 0 &&
      netProfitAfterBoostCents > 0
  };
}
```

