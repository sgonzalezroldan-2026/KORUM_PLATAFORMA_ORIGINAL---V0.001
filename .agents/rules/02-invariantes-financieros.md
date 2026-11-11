# Regla 02 · Invariantes Financieros, Regulatorios y Contables

> Fórmulas exactas: [korum-tco-calculator](../skills/korum-tco-calculator/SKILL.md). Flujos de cobro, asientos tipo y Paycomet: [korum-escrow-payments](../skills/korum-escrow-payments/SKILL.md). Marco legal y decisiones del negocio: [docs/CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md](../../docs/CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md).

## 1. Céntimos enteros y cuadre exacto de la meta (4 líneas públicas = meta)

Todo cálculo se hace en **céntimos enteros**. La meta pública se redondea al euro superior (`Math.ceil` a múltiplo de `100`) y los `0–99` céntimos de redondeo (`roundingBufferCents`) se suman a `gatewayFeeCents`, de modo que **nunca hay descuadre** ni en la pizarra interna ni en la ficha pública. **Excepción (Sprint 4.4b):** la meta de una campaña redimensionada por votación es lo recaudado que queda (decisión del promotor del 2026-11-11), sin redondear al euro; sus 4 líneas siguen sumándola al céntimo y sus comisiones bajan en proporción, hacia abajo ([DECISIONES_TECNICAS.md](../../docs/DECISIONES_TECNICAS.md) §2.17).

Si la entidad activa `showPublicBreakdown`, la ficha pública **no muestra tramos internos**, pero sus 4 líneas suman exactamente `goalCents`:

1. `Presupuesto proveedor y equipamiento` (`costMatCents`)
2. `Instalación y adecuación técnica` (`costInstCents`)
3. `Reserva de mantenimiento, riesgos y contingencia` (`Math.round((costMatCents + costInstCents) * contingencyBps / 10000)`)
4. `Pasarela de pago, plataforma, gestión y garantía de devolución` (`goalCents − (línea 1 + línea 2 + línea 3)`)

- **Suma obligatoria:** `línea 1 + línea 2 + línea 3 + línea 4 === goalCents`.
- **Excedente al cruzar el 100 %:** si la última aportación hace que `raisedCents > goalCents`, la iniciativa pasa a `GOAL_REACHED`, cierra nuevas aportaciones y el excedente se liquida íntegro a la entidad como *Reserva adicional del proyecto*.

## 2. Pizarra TCO del Estudio (vista interna de la entidad)

- **Independencia de proveedores:** la entidad introduce el presupuesto de su proveedor; KORUM nunca cobra comisiones a proveedores.
- **Reserva reversible de cupos:** el cupo exento anual, la beca de medalla y el tope anual de mantenimiento se reservan al pasar a `FUNDRAISING` y **se devuelven a la entidad** si la campaña se cancela o se reembolsa.
- **Modo `BUDGET`:** líneas separadas que cuadran al céntimo con `goalCents`:
  1. `Importe exento por defecto` (p. ej. `1.000,00 € al 0 %`).
  2. `Beca exenta por medalla` (Bronce, Plata u Oro al `0 %`, con el ahorro exacto en euros).
  3. `Resto sujeto a tramo`.
  4. `Cargo de mantenimiento de la plataforma`: si es `0`, mostrar **solo `0,00 €`** (prohibido "(Desactivado)"). Si está activo, se aplica hasta el **tope anual**, y a partir de ahí `0,00 €` el resto del curso.
  5. `Coste de la pasarela de pago (Paycomet)`: importe exacto (incluido el redondeo al euro) con su explicación (`% variable sobre el subtotal + fijo por el nº estimado de aportaciones, calculado con el importe de aportación sugerido por defecto de la entidad`).
- **Modo `TICKETING`:** `Recaudación bruta del aforo`, `Gastos de gestión digital por entrada`, `Coste de pasarela cubierto por la gestión`, `Mantenimiento` y `Neto garantizado para la entidad`, más el aviso normativo de rifas cuando `ticketSubtype === 'RAFFLE'`.

## 3. Libro mayor de doble partida (`LedgerJournal` + `EscrowLedgerEntry`)

- Cada operación de dinero crea **un asiento** con **dos o más apuntes**. Invariante: `Σ DEBIT === Σ CREDIT` en cada asiento; `amountCents > 0` en cada apunte (el signo lo da `direction`).
- Los asientos son **inmutables**: prohibido `update`/`delete` (triggers en base de datos + extensión del cliente Prisma). Un error se corrige con un contra-asiento (`kind = REVERSAL`, `reversesJournalId`).
- Todo saldo que se muestra (recaudado de una iniciativa, bolsa `CREDIT_POOL`, Mi Hucha, ingresos de KORUM) se puede reconstruir sumando apuntes. Los contadores en otras tablas (`raisedCents`, `walletBalanceCents`) son cachés que se actualizan en la misma transacción que el asiento y se verifican en la conciliación diaria.
- **Conciliación diaria** (`PSP_RECONCILIATION`): el saldo de `PSP_CLEARING` debe coincidir con lo que reporta Paycomet. Cualquier diferencia genera una alerta en la consola del Super-Admin.

## 4. Ventana de 90 días de Paycomet y duración de las campañas

- Paycomet solo permite repartir fondos (*split transfer*) durante **90 días desde cada cobro**. Por eso:
  - Duración máxima de una campaña: `maxCampaignDays` (por defecto **60 días**, nunca más de 75), contados desde la publicación.
  - La tarea `SPLIT_WINDOW_GUARD` avisa a la entidad y al Super-Admin cuando queden **15 días** para que venza la ventana del primer cobro de una iniciativa sin liquidar.
  - La bolsa `CREDIT_POOL` dura `min(creditPoolMaxDays, 70 − días transcurridos desde el cobro del patrocinio)` (`creditPoolMaxDays` nunca pasa de 70). Al vencer **no se reembolsa al comercio** (decisión del promotor, 2026-11-10): pasa al **Fondo de actividades** de la entidad (`ORG_ACTIVITY_FUND`, Sprint 4.2f), que la liquida a su cuenta con doble firma desde el cobro original de cada comercio. Los 20 días hasta el 90 son para firmar; a 10 días del final se recuerda a quienes firman, y el dinero que pasa del día 90 sin liquidar abre la alerta crítica `ACTIVITY_FUND_WINDOW`.

## 5. Patrocinio de comercios: 100 % íntegro + fee encima + Veri\*factu

- El **100 % del nivel elegido** (`100 €`, `250 €` o `500 €`) se suma íntegro a la iniciativa.
- El fee de gestión publicitaria (`15 %` por defecto + IVA) se **suma encima** (`250,00 € íntegros + 37,50 € de fee`). Se emite un justificante del patrocinio y una **factura de KORUM registrada en Veri\*factu** por el fee.
- **El dinero de un comercio admitido no se le devuelve nunca** (decisión del promotor, 2026-11-10: es una aportación a fondo perdido y el comercio ya disfruta de su publicidad). Solo se devuelve el 100 % (nivel + fee + IVA, con rectificativa) si la entidad **no lo admite** en la moderación. Un contracargo sigue su camino propio (§7). Un cobro que llega con la campaña ya cerrada **tampoco se devuelve** (decisión del promotor, 2026-11-10): entra en la bolsa del comercio, se factura su fee y espera la moderación (admitido → se coloca con la regla; no admitido → 100 % con rectificativa).
- Si la campaña vence sin éxito, o al dejar de recaudar le sobra parte de una bolsa *Matching 2x*, el patrocinio se reasigna según la regla de la entidad (`SOONEST`, `PROPORTIONAL`, `MANUAL`) a campañas activas que cierren antes del día 85 desde su cobro; si no hay ninguna, pasa a `CREDIT_POOL` con aviso al comercio (ver §4). La liquidación de la campaña que lo recibe reparte desde el cobro original del comercio (`SponsorAllocation`) y un cobro nunca se reparte por encima de lo cobrado.
- La renovación anual es un cobro nuevo (pedido `KR`, enlace de pago por email, sin tarjeta guardada) que entra en la bolsa del comercio y se coloca con la misma regla. Una renovación pagada dos veces **no se devuelve**: el segundo pago renueva el año siguiente. A quien no marcó «renovar cada año», la entidad puede enviarle **una** invitación a renovar por año.
- **Fondo de actividades** (Sprint 4.2f): la liquidación la pide una persona firmante con el **destino** del dinero (lo firman las dos y sale en el justificante en PDF); se aprueba con la doble firma (`ACTIVITY_FUND_PAYOUT_APPROVAL`: `ORG_ACTIVITY_FUND` → `ORG_PAYABLE`) y se reparte cobro a cobro como una liquidación de campaña. Un cobro nunca se reparte por encima de lo cobrado entre las liquidaciones de campaña y las del Fondo.

## 6. "Gastos de gestión digital" en entradas y papeletas

- Se llaman única y exactamente **"Gastos de gestión digital"** y solo se configuran desde la consola del Super-Admin (`fijo + % sobre el precio`).
- En modo `ADD`, el coste de Paycomet se calcula sobre el **total cobrado al comprador** (`precio + gastos de gestión digital`) más el fijo por transacción. El validador garantiza margen neto positivo.

## 7. Reembolsos, contracargos y Auto-Impulso

- **Campaña fallida:** se devuelve el **100 % de lo cobrado** a cada persona (donación + aportación voluntaria a KORUM), siempre al medio de pago original, mediante la tarea `MASS_REFUND` (por lotes, idempotente y reintentable). Decisión por defecto revisable en [CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md](../../docs/CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md) §8.
- **Contracargo:** se registra con un asiento `CHARGEBACK`. Si la iniciativa no se ha liquidado, se descuenta de su hucha y se recalcula el progreso; si ya se liquidó, lo asume KORUM (`CHARGEBACK_LOSSES`) y se avisa al Super-Admin.
- **Auto-Impulso:** siempre se asienta (`SELF_BOOST` + `AUTO_BOOST_EXPENSE`). **No suma** al contador `💛 X aportaciones` ni a los retos por curso. Que se muestre o no en público lo decide el Super-Admin en cada ejecución (por defecto, el valor del ajuste `autoBoost.publicDisclosureDefault`).

## 8. Mi Hucha: KORUM nunca custodia saldo

El funcionamiento depende del ajuste `hucha.mode` de la consola del Super-Admin:

| Modo | Qué es | Requisito |
| :--- | :--- | :--- |
| `DISABLED` | La Hucha no aparece. | — |
| `PLEDGE` (por defecto al lanzar) | **Aportación programada**: la familia elige importe mensual y entidad; cada mes se cobra con su tarjeta tokenizada y se aplica directamente a una iniciativa activa. **No hay saldo guardado.** | Ninguno adicional. |
| `REGULATED_WALLET` | **Monedero con saldo** (modelo Wallapop + Mangopay): el saldo es de la familia y lo custodia una entidad autorizada para ello; KORUM solo refleja ese saldo. | Confirmación por escrito del proveedor de que puede custodiar saldos de usuarios, y revisión legal. |

- En ningún modo existen transferencias a un IBAN tecleado por el usuario. La retirada de saldo (solo `REGULATED_WALLET`) se hace con **reembolso al medio de pago original**; si la tarjeta ya no existe, se abre una excepción manual con verificación de titularidad.
- **Separación fiscal:** las recargas (`TOPUP`) y las entradas (`TICKET`) **nunca** cuentan en certificados ni en el Modelo 182. Solo cuentan las **donaciones (`DONATION`) completadas y no reembolsadas**.

## 9. Fiscalidad

- El certificado fiscal de donación y el Modelo 182 solo se emiten si `organization.ley49 === true` **y** `ley49VerifiedAt` no es nulo (el régimen se acredita en el KYB). En caso contrario se emite un **justificante nominativo de aportación**.
- Para el Modelo 182 se necesitan el NIF, el nombre y el código de provincia del donante. El checkout pide el NIF como **opcional** ("Quiero mi certificado fiscal"), también a invitados. El NIF se guarda cifrado y se busca por HMAC.

## 10. Analítica: real frente a proyectada, sin cifras inventadas

- Prohibido inyectar ingresos ficticios. El panel separa **ingresos reales** (leídos del libro mayor) de la **proyección al 100 %**, y las **6 fuentes de ingresos**, menos los costes que asume KORUM (pasarela absorbida o margen de taquilla negativo; en lo real, también Auto-Impulso y contracargos), coinciden al céntimo con el ingreso neto.
- Alertas en cada tabla de iniciativas:
  1. **🚨 Retorno negativo** (`netRevenueCents < 0`): `🚨 ¡Peligro Retorno Negativo! (-X,XX €) · Ajustar precios`, con corrección en 1 clic.
  2. **💎 Auto-Impulso rentable** (`status === 'FUNDRAISING' && missingTo100Cents > 0 && collectedNetRevenueCents − missingTo100Cents > 0`, donde `collectedNetRevenueCents` cuenta lo ya cobrado más la comisión de tramos y el mantenimiento, que se liquidan al completar la meta: nunca aportaciones proyectadas ni entradas sin vender, que ya no llegarían si KORUM completa la meta, y **nunca el fee de patrocinio ya cobrado**, que KORUM conserva aporte o no, decisión del promotor del 2026-11-11): `💎 ¡Auto-Impulso Rentable! Aportar X € ➔ Retorno +Y €`, con ejecución auditada en 1 clic.
