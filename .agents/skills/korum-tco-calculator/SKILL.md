---
name: korum-tco-calculator
description: Motor matemático TCO en céntimos enteros de KORUM. Cargar siempre que se programen o modifiquen presupuestos de iniciativas, exenciones base, becas por medallas (Bronce/Plata/Oro), cálculo real de pasarela Paycomet, desglose público de 4 líneas, analítica BI (Real vs. Proyectada) o alertas de Auto-Impulso Rentable y Retorno Negativo.
---

# Skill · Motor Matemático TCO en Céntimos, Exenciones y Analítica BI

## 1. Regla de Oro: Céntimos Enteros (`Int`) y Puntos Básicos (`Bps`)
- **Prohibido usar `Float` para dinero:** Todos los importes se expresan en **céntimos enteros (`1 € = 100 cts`)** y los porcentajes en **puntos básicos (`1,00% = 100 bps`, `5,00% = 500 bps`)**, coincidiendo con el formato nativo de Paycomet REST API y eliminando errores de coma flotante IEEE-754.
- **Independencia 100% de Proveedores:** KORUM nunca suma márgenes ni comisiones sobre presupuestos de proveedores; opera exclusivamente con las reglas transparentes del centro (`customRules: true`) o globales (`globalRules`).
- **Reserva Reversible de Cupos:** El cupo exento anual (`exemptLimitCents`), la beca de medalla y el tope anual de mantenimiento (`maintAnnualCapCents`) se reservan al pasar a `FUNDRAISING` y **se restituyen íntegramente si la iniciativa se cancela o reembolsa sin éxito**.

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
  bracketConfig: BracketConfig;       // modo, umbrales y tarifas; editable desde el motor de reglas
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

export type BracketMode = 'FLAT' | 'MARGINAL';

export interface BracketConfig {
  mode: BracketMode;                  // FLAT reproduce el prototipo; MARGINAL elimina el efecto escalón
  t1MaxCents: number;                 // límite superior del tramo 1 (500_000 = 5.000,00 €)
  t2MaxCents: number;                 // límite superior del tramo 2 (1_500_000 = 15.000,00 €)
  ratesBps: { t1: number; t2: number; t3: number }; // ej. 500, 400, 300 bps
}

/**
 * Comisión por tramos sobre la parte del neto que queda por encima de lo exento.
 * `exemptCents` ocupa siempre los primeros céntimos del neto (cupo base + beca de medalla).
 * - FLAT: el tramo se elige por el neto total y se aplica a todo lo sujeto.
 * - MARGINAL: cada tramo grava solo su porción; la comisión crece de forma continua con el presupuesto.
 * `rateBps` devuelve la tarifa efectiva (en MARGINAL, la media ponderada) para mostrarla en la pizarra.
 */
export function calculateBracketFeeCents(
  netCents: number,
  exemptCents: number,
  cfg: BracketConfig
): { rateBps: number; feeCents: number } {
  const taxableFromCents = Math.min(netCents, Math.max(0, exemptCents));
  const taxableCents = netCents - taxableFromCents;
  const { t1, t2, t3 } = cfg.ratesBps;

  if (cfg.mode === 'FLAT') {
    const rateBps = netCents <= cfg.t1MaxCents ? t1 : netCents <= cfg.t2MaxCents ? t2 : t3;
    return { rateBps, feeCents: Math.round((taxableCents * rateBps) / 10000) };
  }

  const slices: Array<[fromCents: number, toCents: number, rateBps: number]> = [
    [0, cfg.t1MaxCents, t1],
    [cfg.t1MaxCents, cfg.t2MaxCents, t2],
    [cfg.t2MaxCents, Number.MAX_SAFE_INTEGER, t3]
  ];
  let weightedCents = 0; // Σ (céntimos sujetos en el tramo × bps); se divide una sola vez para redondear una sola vez
  for (const [fromCents, toCents, rateBps] of slices) {
    const overlapCents = Math.max(0, Math.min(netCents, toCents) - Math.max(taxableFromCents, fromCents));
    weightedCents += overlapCents * rateBps;
  }
  const feeCents = Math.round(weightedCents / 10000);
  const rateBps = taxableCents > 0 ? Math.round((feeCents * 10000) / taxableCents) : t1;
  return { rateBps, feeCents };
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
    // Línea 1: Importe Exento por Defecto
    defaultExemptUsedCents = Math.min(netGuaranteedForSchoolCents, input.baseExemptRemainingCents);
    const afterDefaultCents = Math.max(0, netGuaranteedForSchoolCents - defaultExemptUsedCents);

    // Línea 2: Beca Exenta por Medalla Ganada
    medalExemptUsedCents = Math.min(afterDefaultCents, input.medalGrantAvailableCents);

    // Línea 3: Resto sujeto a tramo. El ahorro de la beca es la diferencia entre pagar con y sin ella.
    const withMedal = calculateBracketFeeCents(
      netGuaranteedForSchoolCents,
      defaultExemptUsedCents + medalExemptUsedCents,
      input.bracketConfig
    );
    const withoutMedal = calculateBracketFeeCents(
      netGuaranteedForSchoolCents,
      defaultExemptUsedCents,
      input.bracketConfig
    );
    bracketRateBps = withMedal.rateBps;
    bracketFeeCents = withMedal.feeCents;
    medalSavedCents = withoutMedal.feeCents - withMedal.feeCents;
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

> **Código vigente:** [src/core/finance/tco.service.ts](../../../src/core/finance/tco.service.ts); el bloque anterior explica las fórmulas. Si `t2MaxCents` no supera a `t1MaxCents` el tramo 2 queda vacío en los dos modos: nada se cobra dos veces ni se bloquea, y si están cruzados la consola avisa con `BRACKET_THRESHOLDS_INVALID`.

> **Efecto escalón de los tramos (decisión del promotor: configurable).** En modo `FLAT` (por defecto, el del prototipo y el de la semilla) el tramo se elige por el importe total y se aplica a todo lo sujeto: un neto de `5.000,00 €` paga el 5 % y uno de `5.000,01 €` paga el 4 % sobre todo, así que cobra **menos comisión** al subir el presupuesto. En modo `MARGINAL` cada tramo grava solo su porción y ese salto desaparece. El modo y los umbrales (`bracketMode`, `t1MaxCents`, `t2MaxCents`) los cambia el Super-Admin en el motor de reglas; mientras esté en `FLAT`, la consola muestra el aviso `BRACKET_CLIFF` de la sección 2.1 para que decida con la cifra delante. El fuzzing del Sprint 1.4 recorre **los dos modos** y comprueba que `MARGINAL` es continuo y monótono creciente en los umbrales.

---

## 2.1 Salud de precios: avisos al Super-Admin cuando una regla hace perder dinero o es incoherente

Decisión del promotor: **ni los tramos, ni la comisión, ni el fee de Mi Hucha, ni los gastos de gestión digital se bloquean.** Son configurables y, si la combinación elegida pierde dinero o es incoherente, la consola **avisa con una exclamación y una explicación en lenguaje llano** para que decida el Super-Admin. Nunca impide guardar.

Función pura `evaluatePricingHealth(rules: KorumGlobalRulesCents, realSourceMarginsCents?): PricingAlert[]` en `src/core/finance/pricing-health.ts`, que **nunca lanza** sea cual sea el valor editado (con el mismo redondeo y la misma aritmética entera que el resto del motor; el coste de pasarela de un cobro de `A` céntimos es `round(A × gatewayPctBps / 10000) + gatewayFixedCents`):

| Código | Gravedad | Cuándo salta | Ejemplo con los valores por defecto |
| :--- | :--- | :--- | :--- |
| `HUCHA_FEE_BELOW_GATEWAY_COST` | `CRITICAL` | El fee de Mi Hucha (`topupFeeCents + importe × topupFeeBps / 10000`) es menor que el coste de pasarela para alguno de los importes de prueba (5, 10, 25, 50 y 100 €). | `❗ Un cargo de 50,00 € cuesta 0,59 € de pasarela y cobras 0,25 €: pierdes 0,34 € por cargo. Es rentable hasta 16,00 €.` |
| `TICKET_FEE_BELOW_GATEWAY_COST` | `CRITICAL` | En taquilla, los *Gastos de gestión digital* no cubren la pasarela sobre `precio + gestión` para algún precio de prueba (2, 5, 10, 20 y 50 €). También salta con margen `0`, porque la Regla 02 §6 exige margen positivo (ese caso no «pierde»: el texto no debe decirlo). Sustituye al validador suelto `validateTicketFeeCoverageLive`: el validador en vivo del formulario llama a esta misma función. | — |
| `SPONSOR_FEE_BELOW_GATEWAY_COST` | `CRITICAL` | El fee de gestión publicitaria no cubre la pasarela sobre `nivel + fee` en alguno de los 3 niveles. | Con `sponsorFeeBps = 0` pierdes la pasarela de cada patrocinio. |
| `RULE_VALUE_INVALID` | `CRITICAL` | Un valor de los que entran en los cálculos está vacío, es negativo, tiene decimales o supera `1.000.000.000`. Sustituye a todos los demás avisos: con ese valor, sus cifras no significarían nada. | — |
| `BRACKET_THRESHOLDS_INVALID` | `CRITICAL` | `t1MaxCents > t2MaxCents`. El motor deja vacío el tramo 2 y sigue funcionando. Unos umbrales iguales no avisan: son un tramo 2 vacío a propósito. | — |
| `BRACKET_CLIFF` | `WARNING` | Solo en `bracketMode = FLAT`: en un umbral (`t1MaxCents` o `t2MaxCents`) un presupuesto 1 céntimo mayor paga **menos** comisión que uno justo en el umbral, descontando el cupo exento global. Un solo aviso por código: el primer salto, el mayor (`worstDropCents`) y cuántos hay (`cliffCount`). | `⚠️ Con 1.000,00 € exentos, un neto de 5.000,00 € paga 200,00 € de comisión y uno de 5.000,01 € paga 160,00 €. Considera el modo marginal.` |
| `BRACKET_RATES_NOT_DECREASING` | `WARNING` | Las tarifas no bajan al subir de tramo (`t1Bps < t2Bps` o `t2Bps < t3Bps`), contra la lógica de descuento por volumen. | — |
| `SOURCE_NEGATIVE_MARGIN` | `CRITICAL` | Con datos **reales** del libro mayor (Sprint 5.1): una de las fuentes con cobro propio (entradas, patrocinios y Mi Hucha) acumula margen neto negativo: ingreso de KORUM menos coste de pasarela **de los cobros completados** (un cobro devuelto o contracargado no cuenta en ningún lado: su pérdida es el coste de la garantía de devolución, no un precio mal puesto). Acumulado de todo el libro, sin periodo. Llegan por el parámetro `realSourceMarginsCents`; la huella no incluye el margen, que cambia con cada cobro. | `❗ Mi Hucha acumula un margen de −8,16 €.` (cifra de ejemplo) |

```typescript
export type PricingAlertSeverity = 'CRITICAL' | 'WARNING';

export interface PricingAlert {
  code: PricingAlertCode;
  severity: PricingAlertSeverity;
  /** Cifras para el mensaje (importes en céntimos); el texto sale de messages/{es,ca,en}.json, clave `admin.pricingHealth.<code>`. */
  params: Record<string, number>;
  /** Huella de los valores de configuración implicados: si cambian, una aceptación anterior deja de valer. */
  fingerprint: string;
  /** Ajuste que habría que tocar (para el botón «Ajustar»). */
  settingKeys: string[];
}
```

**Qué hace el Super-Admin con un aviso** (todo en `/admin` y en el motor de reglas del Sprint 5.3):

1. **Ajustar**: salta al campo implicado; mientras escribe, el aviso se recalcula en vivo con la nueva cifra.
2. **Aceptar y registrar**: asume la pérdida o la incoherencia a propósito (por ejemplo, la Hucha como coste de captación). Pide una nota obligatoria y guarda `{ code, fingerprint, acknowledgedById, acknowledgedAt, note }` en `PlatformSetting` (`pricing.acknowledgements`) y una fila en `AuditLog` (`PRICING_ALERT_ACKNOWLEDGED`).
3. El aviso aceptado **no desaparece**: se muestra atenuado con «Aceptado por … el …». Si cambia la configuración implicada (huella distinta), vuelve a saltar como nuevo.
4. Insignia con el número de avisos abiertos (`CRITICAL` primero) en la cabecera de `/admin`; banner completo en la portada de la consola si hay alguno `CRITICAL` sin aceptar.

Tests del Sprint 1.4 (`tests/unit/pricing-health.spec.ts`): cada código con un caso que salta y otro que no; los valores por defecto producen exactamente `HUCHA_FEE_BELOW_GATEWAY_COST` y `BRACKET_CLIFF`; en `MARGINAL` no sale `BRACKET_CLIFF`; cambiar un valor implicado cambia la huella; umbrales cruzados y valores imposibles avisan sin lanzar.

---

## 3. Fórmulas Exactas en Modo Taquilla (`TICKETING`) y Validador Paycomet

Código vigente: `calculateStudioTicketingTCO` en [src/core/finance/tco.service.ts](../../../src/core/finance/tco.service.ts).

- **Gasto unitario:** `gestión = fijo + round(precio × pct / 10000)`. En `INC` va dentro del precio, así que nunca se retiene más que el precio: `min(gestión, precio)`.
- **Cobro al comprador:** `precio + gestión` en `ADD`; `precio` en `INC`.
- **Pasarela por entrada:** `round(cobro × pct / 10000) + fijo`, sobre el **cobro bruto total**. Un cobro de `0` no pasa por Paycomet: coste `0`.
- **Margen de KORUM:** `gestión − pasarela`, por entrada (`netKorumMarginPerTicketCents`) y con el aforo completo (`netKorumMarginAt100Cents`). `isGatewayCovered` exige margen estrictamente positivo (Regla 02 §6).
- **Neto de la entidad:** `max(0, bruto − gestión retenida del precio − mantenimiento)`. `maintShortfallCents` recoge el mantenimiento que la recaudación no cubre, para que el neto a `0` no lo esconda.
- **Meta de la campaña de taquilla (Sprint 4.3):** lo que entra en la hucha con el aforo completo: en `ADD`, `precio × aforo`; en `INC`, `precio × aforo − gastos de gestión retenidos` (con el precio entero como meta una campaña `INC` vendida por completo nunca llegaría al 100 %). En taquilla `Initiative.gatewayFeeCents` se guarda a `0`: la pasarela ya la pagan los gastos de gestión digital y la liquidación no debe restarla otra vez.
- **Ejemplo (QA-FIN03):** `ADD`, entrada de `500` cts y gestión de `55` cts, con Paycomet `1 % + 9` cts: cobro `555`, pasarela `6 + 9 = 15` y margen `+40` cts.

---

## 4. Cuadre Público de 4 Líneas en la Ficha de Familias (100% Meta)

Código vigente: `calculatePublicBreakdown4Lines` en [src/core/finance/tco.service.ts](../../../src/core/finance/tco.service.ts).

- Línea 1 `costMatCents`; línea 2 `costInstCents`; línea 3 `round((línea 1 + línea 2) × contingencyBps / 10000)`; línea 4 `goalCents − (línea 1 + línea 2 + línea 3)`.
- Si el coste real supera la meta, las líneas no pueden cuadrar: lanza `PublicBreakdownMismatchError` en vez de publicar un desglose falso. Quien llama oculta el desglose y lo registra.

---

## 5. Analítica BI Real vs. Proyectada y Alertas Algorítmicas (Cero Ingresos Ficticios)

Código vigente: [src/core/finance/bi-analytics.service.ts](../../../src/core/finance/bi-analytics.service.ts).

- **Prohibido inventar constantes mágicas** (`8,00 €` fijos de Hucha o `1%` de comercios cuando hay `0` comercios). Sin datos, la proyección es `0`.
- **Las 6 fuentes** (`RevenueSources`): `bracketFeeCents`, `supportGuaranteeCents`, `sponsorFeeCents`, `digitalTicketFeeCents`, `maintFeeCents` y `huchaTopupFeeCents`. El gráfico y la tabla suman exactamente lo mismo.
- **Cuadre:** `Σ 6 fuentes − costes === netRevenueCents`, al céntimo. Los costes van aparte de las fuentes: una iniciativa puede tener `0` de fuentes y neto negativo (la `#8`).
- **Proyección al 100 %** (`calculateRevenueBreakdown6Sources`):
  - `supportGuaranteeCents = max(cobrado, proyectado)`; solo proyectan las campañas `BUDGET` que no absorben la pasarela. Lo ya cobrado nunca se pierde.
  - `gatewayLossCents`: el margen negativo de taquilla, o `gatewayFeeCents` en las campañas `BUDGET` que absorben la pasarela. En taquilla no se resta otra vez, porque el margen ya la descuenta.
- **Aportación voluntaria proyectada** (`projectGuaranteeContributionsAt100`): como el check va **desmarcado por defecto**, usa lo observado en la propia entidad o, si aún no hay datos, en la plataforma; nunca un porcentaje fijo. Las donaciones que faltan se estiman con la donación media de la iniciativa (sin patrocinios, bolsa Matching ni Auto-Impulso) o con el importe sugerido.
- **Lo real** (`calculateRealRevenueFromLedger`) sale de los saldos del libro mayor: fuentes brutas menos la pasarela neta de lo recuperado, el Auto-Impulso y los contracargos asumidos. Por entidad cumple `ingresos − gastos === activo − pasivo`.
- **Alertas** (`analyzeInitiativeProfitabilityAndSelfBoost`): 🚨 si `netRevenueCents < 0`; 💎 si `status === 'FUNDRAISING'`, `missingTo100Cents > 0` y `collectedNetRevenueCents − missingTo100Cents − recoverableSelfBoostCents > 0` (`recoverableSelfBoostCents` es el Auto-Impulso anterior aún puesto en una campaña reabierta por un contracargo: vuelve a KORUM si vence sin meta y, si KORUM completa la meta, ya no vuelve; decisión del promotor del 2026-11-12). El 💎 lleva a gastar dinero real, así que `collectedNetRevenueCents` cuenta lo ya cobrado más la comisión de tramos y el mantenimiento, que se liquidan al completar la meta (aportación voluntaria real y margen de las entradas vendidas, nada proyectado y **sin el fee de patrocinio ya cobrado**, que KORUM conserva aporte o no): lo que falta ya no llegaría si KORUM completa la meta.
- `InitiativeStatus` se importa de `src/types/korum.types.ts` (códigos internos; `FUNDRAISING` = «Recaudando»).

