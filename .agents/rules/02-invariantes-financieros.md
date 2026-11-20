# Regla 02 · Invariantes Financieros, Regulatorios y Contables

> Fórmulas exactas: [korum-tco-calculator](../skills/korum-tco-calculator/SKILL.md). Flujos de cobro, asientos tipo y Paycomet: [korum-escrow-payments](../skills/korum-escrow-payments/SKILL.md). Marco legal y decisiones del negocio: [docs/CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md](../../docs/CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md).

> **Decisiones del promotor del 2026-11-17 al 2026-11-20** ([CUMPLIMIENTO §8](../../docs/CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md), decisiones 21 a 81), pendientes de construir salvo las que ya dicen que están construidas. Esta regla ya recoge lo decidido. Donde dice **«pendiente de construir en el Sprint X»**, el código todavía hace lo anterior (se indica) y **no se cambia fuera de ese sprint**: quien construya otro sprint respeta el comportamiento actual y no adelanta la regla nueva.

## 1. Céntimos enteros y cuadre exacto de la meta (4 líneas públicas = meta)

Todo cálculo se hace en **céntimos enteros**. La meta pública se redondea al euro superior (`Math.ceil` a múltiplo de `100`) y los `0–99` céntimos de redondeo (`roundingBufferCents`) se suman a `gatewayFeeCents`, de modo que **nunca hay descuadre** ni en la pizarra interna ni en la ficha pública. **Excepción (Sprint 4.4b):** la meta de una campaña redimensionada por votación es lo recaudado que queda (decisión del promotor del 2026-11-11), sin redondear al euro; sus 4 líneas siguen sumándola al céntimo y sus comisiones bajan en proporción, hacia abajo ([DECISIONES_TECNICAS.md](../../docs/DECISIONES_TECNICAS.md) §2.17).

Si la entidad activa `showPublicBreakdown`, la ficha pública **no muestra tramos internos**, pero sus 4 líneas suman exactamente `goalCents`:

1. `Presupuesto proveedor y equipamiento` (`costMatCents`)
2. `Instalación y adecuación técnica` (`costInstCents`)
3. `Reserva de mantenimiento, riesgos y contingencia` (`Math.round((costMatCents + costInstCents) * contingencyBps / 10000)`)
4. `Pasarela de pago, plataforma, gestión y garantía de devolución` (`goalCents − (línea 1 + línea 2 + línea 3)`)

- **Suma obligatoria:** `línea 1 + línea 2 + línea 3 + línea 4 === goalCents`.
- **Excedente al cruzar el 100 %:** si la última aportación hace que `raisedCents > goalCents`, la iniciativa pasa a `GOAL_REACHED`, cierra nuevas aportaciones y el excedente se liquida íntegro a la entidad como *Reserva adicional del proyecto*.
- **Campaña que supera la meta (decisión 68, pendiente de construir en el Sprint 5.17b):** la campaña sigue abierta hasta su fecha límite; antes de pagar se avisa de que la meta ya se consiguió y de que lo nuevo va a la *Reserva adicional del proyecto*; lo recaudado de más lleva el coste real de la pasarela de esos cobros y la comisión de KORUM (fórmula a proponer al promotor al abrir el sprint); la entidad puede cerrarla antes con una firma para liquidar ya; la bolsa *Matching 2x* deja de duplicar al llegar a la meta. Una campaña cerrada no admite ningún pago. *Hasta el Sprint 5.17b se aplica el punto anterior.*
- **Cierre de los pagos y mínimos (decisiones 73, 77 y 79):** los pagos de una campaña se cierran 20 minutos antes de su fecha límite (Sprint 5.17b); la donación mínima es de 5 € (Sprint 5.15; la aportación voluntaria sigue desde 0 €); el Super-Admin puede fijar una meta máxima global o por entidad, sin límite por defecto (Sprint 5.18).

## 2. Pizarra TCO del Estudio (vista interna de la entidad)

- **Independencia de proveedores:** la entidad introduce el presupuesto de su proveedor; KORUM nunca cobra comisiones a proveedores.
- **Reserva reversible de cupos:** el cupo exento anual, la beca de medalla y el tope anual de mantenimiento se reservan al pasar a `FUNDRAISING` y **se devuelven a la entidad** si la campaña se cancela o se reembolsa.
- **Modo `BUDGET`:** líneas separadas que cuadran al céntimo con `goalCents`:
  1. `Importe exento por defecto` (p. ej. `1.000,00 € al 0 %`).
  2. `Beca exenta por medalla` (Bronce, Plata u Oro al `0 %`, con el ahorro exacto en euros).
  3. `Resto sujeto a tramo`.
  4. `Cargo de mantenimiento de la plataforma`: si es `0`, mostrar **solo `0,00 €`** (prohibido "(Desactivado)"). Si está activo, se aplica hasta el **tope anual**, y a partir de ahí `0,00 €` el resto del curso.
  5. `Coste de la pasarela de pago (Paycomet)`: importe exacto (incluido el redondeo al euro) con su explicación (`% variable sobre el subtotal + fijo por el nº estimado de aportaciones, calculado con el importe de aportación sugerido por defecto de la entidad`).
- **Modo `TICKETING`:** `Recaudación bruta del aforo`, `Gastos de gestión digital por entrada`, `Coste de pasarela cubierto por la gestión`, `Mantenimiento` y `Neto para la entidad si se vende todo el aforo` (la pizarra lo aclara desde el Sprint 5.13: si no se vende todo, al llegar la fecha la entidad recibe lo vendido, con el mantenimiento rebajado en la misma proporción). **Las rifas se retiraron** (decisión 31, Sprints 5.12a y 5.12b): ya no hay subtipo `RAFFLE` ni su aviso normativo.
- **Vales** (decisión 32; el motor se construyó en el Sprint 5.14a y las pantallas, el puesto, la devolución, la caducidad y la liquidación llegan en los 5.14b y 5.14c): venta de unidades de canje con precio único (`TicketSubtype.VOUCHER`); su pizarra sigue el modo `TICKETING` sin aforo obligatorio (tope opcional) y con tarifa propia de «Gastos de gestión digital», **fija por compra, no por vale** (`fijo + % × importe de la compra`). Cada compra tiene un solo pase con su saldo y un vale no se gasta dos veces. Al agotarse, la aportación «sin producto» es una **aportación sin certificado** con los mismos gastos (decisión 64) y no se ofrece a un colegio con ánimo de lucro (decisión 65). Una venta de vales nunca lleva Auto-Impulso ni 💎. La fecha de validez la fija la entidad bajo su responsabilidad, sin mínimo (en el Estudio, por defecto hasta el inicio del curso siguiente y entre el día de cierre de la venta y 12 meses después, decisión 67; desde el Sprint 5.18, como máximo 3 meses después del cierre y, por defecto, lo que llegue antes: el inicio del curso siguiente o esos 3 meses, decisión 76); una venta sin tope lleva un objetivo orientativo de vales que da su meta y su barra y con el que se compara el mantenimiento (decisión 66, Sprint 5.14b); si cancela la venta antes de liquidarla devuelve la plataforma y, después, la plataforma avisa y responde la entidad; los pagos «sin producto» no se devuelven salvo esa cancelación (decisión 49). **La devolución de 14 días la paga la entidad** (decisión 70, pendiente de construir en el Sprint 5.20b): quien compra recupera el 100 % y la entidad paga a KORUM la gestión devuelta y el coste de la pasarela y de la devolución, descontados de la liquidación de esa venta. Hasta entonces lo asume KORUM.
- **Tarifas (decisión 34, pendiente de construir en el Sprint 5.18):** todo cambio global de tarifas entra en vigor a los 30 días y solo vale para lo publicado después; cada campaña, taquilla o venta de vales guarda la tarifa con la que se publicó. Hasta entonces, un cambio se aplica al momento y la compra de entradas lee la tarifa actual.

## 3. Libro mayor de doble partida (`LedgerJournal` + `EscrowLedgerEntry`)

- Cada operación de dinero crea **un asiento** con **dos o más apuntes**. Invariante: `Σ DEBIT === Σ CREDIT` en cada asiento; `amountCents > 0` en cada apunte (el signo lo da `direction`).
- Los asientos son **inmutables**: prohibido `update`/`delete` (triggers en base de datos + extensión del cliente Prisma). Un error se corrige con un contra-asiento (`kind = REVERSAL`, `reversesJournalId`).
- Todo saldo que se muestra (recaudado de una iniciativa, bolsa `CREDIT_POOL`, Mi Hucha, ingresos de KORUM) se puede reconstruir sumando apuntes. Los contadores en otras tablas (`raisedCents`, `walletBalanceCents`) son cachés que se actualizan en la misma transacción que el asiento y se verifican en la conciliación diaria.
- **Conciliación diaria** (`PSP_RECONCILIATION`): el saldo de `PSP_CLEARING` debe coincidir con lo que reporta Paycomet. Cualquier diferencia genera una alerta en la consola del Super-Admin.

## 4. Ventana de 90 días de Paycomet, duración de las campañas y entrega automática

- Paycomet solo permite repartir fondos (*split transfer*) durante **90 días desde cada cobro**. Por eso:
  - Duración máxima de una campaña: `maxCampaignDays` (por defecto **60 días**, nunca más de 75), contados desde la publicación.
  - La tarea `SPLIT_WINDOW_GUARD` avisa a la entidad y al Super-Admin cuando queden **15 días** para que venza la ventana del primer cobro de una iniciativa sin liquidar.
  - **Entrega automática (decisión 36, pendiente de construir en el Sprint 5.19):** cinco días antes de que venza la ventana de un cobro de una campaña conseguida que nadie ha liquidado, ese dinero se entrega de forma automática a la **cuenta verificada de la propia entidad**, con aviso a quienes firman y auditoría. Nunca a un proveedor. Vale también para el Fondo de actividades. Hasta entonces solo se avisa.
  - **Liquidación solo a la entidad (decisión 36, Sprint 5.19):** se reparte únicamente a la cuenta verificada de la entidad (`PayoutDestination.ORGANIZATION`); el pago directo al proveedor (`PROVIDER`) queda aplazado y hoy sigue en el código, apagado fuera del simulador. La entidad sigue adjuntando la factura de su proveedor.
  - **Campaña vencida sin decisión (decisión 29, pendiente de construir en el Sprint 5.17):** la entidad decide (devolver o votar un proyecto más pequeño) durante **14 días**; si calla, la plataforma devuelve el 100 % sola, antes si ya no da tiempo a votar, con avisos a quienes firman 7, 3 y 1 días antes. Hasta entonces el dinero espera la decisión de la entidad sin plazo.
  - **Evento con entradas (decisión 30, construida en el Sprint 5.13):** al llegar su fecha, con algo vendido, pasa a liquidable por lo vendido (`GOAL_REACHED`, nunca «vencido») con el mantenimiento rebajado en proporción a lo vendido; sin nada vendido, se cierra sin dinero que mover (`CANCELLED`). Solo se devuelve el 100 % si la entidad lo cancela (una firma con segundo factor, mientras no se haya liquidado), y a quien lo pida en 14 días si cambia de fecha: cada comprador recibe un enlace personal y **la liquidación espera a que se cierre ese plazo**. Un evento ya celebrado y sin liquidar se puede aplazar (la venta se reabre hasta la fecha nueva). **Cargo por cancelación (decisión 63, pendiente de construir en el Sprint 5.20b):** la entidad que cancela un evento o una venta de vales paga a KORUM la gestión devuelta y el coste de la pasarela y de las devoluciones, sin excepciones; las familias siguen recuperando el 100 %. **También en un cambio de fecha (decisión 69, mismo sprint):** con el dinero aún retenido, devuelve la plataforma y la entidad paga a KORUM, de ese dinero retenido, la gestión devuelta y el coste de la pasarela y de las devoluciones de quien lo pida; lo que no alcance se cobra como en la cancelación. Hasta entonces lo asume KORUM. La fecha nueva, y el final de los 14 días, no pasan del máximo de la campaña desde su publicación (`maxCampaignDays`, nunca más de 75), para que siempre queden al menos 15 días de la ventana de 90 para liquidar.
  - La bolsa `CREDIT_POOL` dura `min(creditPoolMaxDays, 70 − días transcurridos desde el cobro del patrocinio)` (`creditPoolMaxDays` nunca pasa de 70). Al vencer **no se reembolsa al comercio** (decisión del promotor, 2026-11-10): pasa al **Fondo de actividades** de la entidad (`ORG_ACTIVITY_FUND`, Sprint 4.2f), que la liquida a su cuenta con doble firma desde el cobro original de cada comercio. Los 20 días hasta el 90 son para firmar; a 10 días del final se recuerda a quienes firman, y el dinero que pasa del día 90 sin liquidar abre la alerta crítica `ACTIVITY_FUND_WINDOW`.

## 5. Comercios: nivel íntegro + gestión encima, en dos modos

> **Decidido (decisiones 23 a 27), pendiente de construir en el Sprint 5.16.** Hoy el código tiene un solo modo: el que se describe más abajo como «comportamiento actual», con moderación siempre y fee de «gestión publicitaria».

Cada entidad elige su modo; un cambio de modo afecta solo a los pagos nuevos. **El proyecto ve siempre el nivel íntegro**: comisiones e IVA van encima y los paga el comercio. La comisión de KORUM se llama **«gestión»**, con dos porcentajes en la consola (donación y publicidad, 15 % de partida), y lleva IVA y factura de KORUM en los dos modos.

| | Solo donación (por defecto) | Patrocinio con publicidad |
| :--- | :--- | :--- |
| Quién | Cualquier entidad, salvo un colegio privado con ánimo de lucro (§9) | Solo la que declara en su panel que puede facturar con IVA (bajo su responsabilidad, con aviso a la otra persona firmante y auditoría; sin el Super-Admin) |
| Qué paga el comercio | Nivel + gestión de KORUM + IVA de la gestión | Nivel + **IVA de la entidad sobre el nivel** + gestión de KORUM + IVA de la gestión |
| Moderación | Ninguna: el dinero entra directo y suma al momento | La entidad modera; si lo rechaza, se devuelve el 100 % con rectificativa; **sin decisión en 14 días se entiende admitido** (decisión 78, Sprint 5.16c), con avisos a 7, 3 y 1 |
| Qué recibe el comercio | Agradecimiento **solo con su nombre**, y solo si la entidad lo activa; sin categoría, ventaja, enlace ni cartel | Distintivo, categoría, ventaja para las familias y cartel |
| Documentos | Certificado fiscal (entidad con la Ley 49/2002 acreditada; entra en el Modelo 182) o justificante; factura de KORUM | Factura de la entidad al comercio, que la entidad emite y sube tras admitirlo; factura de KORUM |
| Matching 2x | Anónimo | Con el nombre del comercio |
| Renovación anual | No hay | Sí; una aportación nueva de un comercio ya admitido es una **ampliación**: no se modera, no se devuelve y suma a su categoría dentro del año |

- **Nunca se devuelve** el dinero de un comercio admitido (ni el de una donación, firme desde el pago). Excepciones cerradas: el comercio en modo publicidad que la entidad rechaza en sus 14 días (100 %, con rectificativa; si no decide, se entiende admitido, decisión 78) y la renovación pagada dos veces desde el email, que se puede devolver con un botón durante 14 días.
- Si la entidad retira el anuncio de un comercio, KORUM **no devuelve nada ni media**: lo resuelven fuera de la plataforma.
- La factura de un comercio con contracargo solo se anula si el banco indica fraude (Sprint 5.20b).
- El mismo comercio se reconoce por NIF y email dentro de la entidad y se muestra una sola vez.

**Comportamiento actual del código (hasta el Sprint 5.16), que también fija lo que no cambia** (reasignación, bolsa y Fondo de actividades):


- El **100 % del nivel elegido** (`100 €`, `250 €` o `500 €`) se suma íntegro a la iniciativa.
- El fee de gestión (hoy «gestión publicitaria», `15 %` por defecto + IVA) se **suma encima** (`250,00 € íntegros + 37,50 € de fee`). Se emite un justificante del patrocinio y una **factura de KORUM registrada en Veri\*factu** por el fee.
- **El dinero de un comercio admitido no se le devuelve nunca** (decisión del promotor, 2026-11-10: es una aportación a fondo perdido y el comercio ya disfruta de su publicidad). Solo se devuelve el 100 % (nivel + fee + IVA, con rectificativa) si la entidad **no lo admite** en la moderación. Un contracargo sigue su camino propio (§7). Un cobro que llega con la campaña ya cerrada **tampoco se devuelve** (decisión del promotor, 2026-11-10): entra en la bolsa del comercio, se factura su fee y espera la moderación (admitido → se coloca con la regla; no admitido → 100 % con rectificativa).
- Si la campaña vence sin éxito, o al dejar de recaudar le sobra parte de una bolsa *Matching 2x*, el patrocinio se reasigna según la regla de la entidad (`SOONEST`, `PROPORTIONAL`, `MANUAL`) a campañas activas que cierren antes del día 85 desde su cobro; si no hay ninguna, pasa a `CREDIT_POOL` con aviso al comercio (ver §4). La liquidación de la campaña que lo recibe reparte desde el cobro original del comercio (`SponsorAllocation`) y un cobro nunca se reparte por encima de lo cobrado.
- La renovación anual es un cobro nuevo (pedido `KR`, enlace de pago por email, sin tarjeta guardada) que entra en la bolsa del comercio y se coloca con la misma regla. Una renovación pagada dos veces **no se devuelve**: el segundo pago renueva el año siguiente. A quien no marcó «renovar cada año», la entidad puede enviarle **una** invitación a renovar por año.
- **Fondo de actividades** (Sprint 4.2f): la liquidación la pide una persona firmante con el **destino** del dinero (lo firman las dos y sale en el justificante en PDF); se aprueba con la doble firma (`ACTIVITY_FUND_PAYOUT_APPROVAL`: `ORG_ACTIVITY_FUND` → `ORG_PAYABLE`) y se reparte cobro a cobro como una liquidación de campaña. Un cobro nunca se reparte por encima de lo cobrado entre las liquidaciones de campaña y las del Fondo.

## 6. "Gastos de gestión digital" en entradas y vales

- Se llaman única y exactamente **"Gastos de gestión digital"** y solo se configuran desde la consola del Super-Admin (`fijo + % sobre el precio`).
- En modo `ADD`, el coste de Paycomet se calcula sobre el **total cobrado al comprador** (`precio + gastos de gestión digital`) más el fijo por transacción. El validador garantiza margen neto positivo.
- Los vales tienen su propia tarifa, que se cobra **una vez por compra** (Sprint 5.14a; `voucherFeeFixedCents` + `voucherFeeBps`, en el motor de reglas globales y en la ficha 360º). Las papeletas de rifa se retiraron en el Sprint 5.12a.
- **Llevan el IVA dentro** (decisión 21, §11).
- **Margen negativo (decisión 74, Sprint 5.18):** no se publica una taquilla ni una venta de vales en la que la comisión de PAYCOMET supere los Gastos de gestión digital; el Estudio ofrece pasar a «gestión encima del precio».

## 7. Reembolsos, contracargos y Auto-Impulso

- **Campaña fallida:** se devuelve el **100 % de lo cobrado** a cada persona (donación + aportación voluntaria a KORUM), siempre al medio de pago original, mediante la tarea `MASS_REFUND` (por lotes, idempotente y reintentable). Decisión por defecto revisable en [CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md](../../docs/CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md) §8.
- **Contracargo:** se registra con un asiento `CHARGEBACK`. Si la iniciativa no se ha liquidado, se descuenta de su hucha y se recalcula el progreso; si ya se liquidó, lo asume KORUM (`CHARGEBACK_LOSSES`) y se avisa al Super-Admin.
- **Contracargo de una campaña ya liquidada (decisión 53, pendiente de construir en el Sprint 5.19b):** deja de asumirse de forma automática. Abre una revisión: KORUM lo discute con el banco a través de Paycomet y pide información a la entidad; mientras, el importe queda asentado en una cuenta de contracargos en revisión y a la entidad no se le descuenta nada. Al terminar, **el Super-Admin decide y lo aprueba** en la consola: lo asume KORUM (`CHARGEBACK_LOSSES`) o se reclama a la entidad, si hubo engaño o incumplimiento. *Hasta el Sprint 5.19b el código lo asume al momento.*
- **Deudas de la entidad (decisión 75, pendiente de construir en el Sprint 5.20c):** lo que la entidad deba a KORUM (cargos de las decisiones 63, 69 y 70 que su venta no cubra, o una reclamación tras un contracargo) se detecta solo; el aviso, el cobro desde sus liquidaciones posteriores, el bloqueo de publicar y la suspensión los aprueba el Super-Admin, con auditoría. **Coste medido (decisión 72, Sprint 5.20a):** la consola calcula lo que cuestan a KORUM las devoluciones y los contracargos, en total y por campaña fallida media, para calibrar la comisión si PAYCOMET cobra por devolver.
- **Auto-Impulso (decisión 33, pendiente de construir en el Sprint 5.21):** es un **gasto promocional de KORUM**. Se permite **solo en campañas con presupuesto** (nunca en entradas ni vales, que no tienen una meta que completar). KORUM **no aporta dinero propio a la hucha: cobra esa cantidad de menos al repartir** (compensación en el reparto; ejemplo: comisión de 350 € y Auto-Impulso de 300 €, KORUM cobra 50 € y la entidad recibe lo mismo); la factura a la entidad sigue siendo por la comisión entera. La ficha dice **siempre**, sin importe, «La plataforma KORUM también aportó y ayudó a conseguir el reto»: desaparecen el ajuste `autoBoost.publicDisclosureDefault` y la elección en cada ejecución. El email a quienes donaron añade la frase, y el justificante de liquidación y el expediente llevan la línea «Aportación de la plataforma KORUM» con su importe. **Tope (decisión 81):** nunca supera la comisión de KORUM en esa campaña y desaparece la ejecución «aceptando la pérdida». *Hasta el Sprint 5.21 el código hace lo que sigue, con la visibilidad a elección del Super-Admin.*
- **Auto-Impulso (lo que no cambia):** siempre se asienta (`SELF_BOOST` + `AUTO_BOOST_EXPENSE`). **Suma como cualquier aportación** (decisión del promotor, 2026-11-12): su importe cuenta en la barra de avance, en la barra de impacto de la portada, en las fichas, en el panel y en la consola con **el mismo total en todas partes**, y suma `+1` al contador `💛 X aportaciones`. **No suma a los retos por curso**: KORUM no pertenece a ningún curso. Hoy, y hasta el Sprint 5.21, lo único que decide el Super-Admin en cada ejecución (por defecto, el valor del ajuste `autoBoost.publicDisclosureDefault`) es si la ficha **dice que la plataforma KORUM ayudó a conseguir el reto**, sin importe y de forma sutil («La plataforma KORUM también aportó y ayudó a conseguir el reto»); como las aportaciones de las familias, el importe es anónimo.

## 8. Mi Hucha: KORUM nunca custodia saldo

**Decisión 38:** Mi Hucha **sale apagada** (`DISABLED`) y el promotor la enciende en modo `PLEDGE` cuando Paycomet confirme los cobros mensuales; el monedero con saldo (`REGULATED_WALLET`) **queda descartado**. Al encenderla tendrá condiciones propias con versión, y la gestión cobrada a KORUM se devuelve de forma automática si la familia cancela en los 14 días siguientes al alta (con su contra-asiento; nunca la donación). *Pendiente de construir: el valor por defecto y las condiciones, en el Sprint 5.15; la retirada del modo `REGULATED_WALLET` del código, en el 5.24b. Hasta entonces el código conserva la tabla siguiente y arranca en `PLEDGE`.*

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
- **Cuándo existe el certificado (decisión 28, pendiente de construir en el Sprint 5.22):** solo cuando la campaña se consigue (meta alcanzada o redimensionamiento cerrado); el donativo de una familia cuenta en el año en que la campaña se consolida y el Modelo 182 de cada ejercicio recoge las campañas consolidadas en él. La donación de un comercio es firme desde el pago y cuenta en el año del pago. Hasta entonces el certificado está disponible desde el pago y el fichero señala las campañas sin resolver.
- **Colegios privados con ánimo de lucro (decisiones 42 y 51, Sprint 5.22):** entradas, vales y patrocinio con publicidad de comercios, que al admitirse entra directo en su Fondo de actividades; no publican campañas de donación ni reciben donaciones de comercios ni aportaciones mensuales.
- Para el Modelo 182 se necesitan el NIF, el nombre y el código de provincia del donante. El checkout pide el NIF como **opcional** ("Quiero mi certificado fiscal"), también a invitados. El NIF se guarda cifrado y se busca por HMAC.

## 10. Analítica: real frente a proyectada, sin cifras inventadas

- **Sin IVA (decisión 21, pendiente de construir en el Sprint 5.20a):** el BI, las seis fuentes, la proyección y las dos alertas cuentan el ingreso de KORUM **sin IVA** (§11). El 💎 se calcula sobre la comisión sin IVA menos la aportación entera: con una comisión de 350,00 € (289,26 € de base) y 300,00 € por completar, el retorno es −10,74 € y el aviso **no** sale. El 💎 solo aparece en campañas con presupuesto (Sprint 5.21).
- Prohibido inyectar ingresos ficticios. El panel separa **ingresos reales** (leídos del libro mayor) de la **proyección al 100 %**, y las **6 fuentes de ingresos**, menos los costes que asume KORUM (pasarela absorbida o margen de taquilla negativo; en lo real, también Auto-Impulso y contracargos), coinciden al céntimo con el ingreso neto.
- Alertas en cada tabla de iniciativas:
  1. **🚨 Retorno negativo** (`netRevenueCents < 0`): `🚨 ¡Peligro Retorno Negativo! (-X,XX €) · Ajustar precios`, con corrección en 1 clic.
  2. **💎 Auto-Impulso rentable** (`status === 'FUNDRAISING' && missingTo100Cents > 0 && collectedNetRevenueCents − missingTo100Cents − recoverableSelfBoostCents > 0`, donde `collectedNetRevenueCents` cuenta lo ya cobrado más la comisión de tramos y el mantenimiento, que se liquidan al completar la meta: nunca aportaciones proyectadas ni entradas sin vender, que ya no llegarían si KORUM completa la meta, y **nunca el fee de patrocinio ya cobrado**, que KORUM conserva aporte o no, decisión del promotor del 2026-11-11, y `recoverableSelfBoostCents` es el Auto-Impulso anterior que sigue puesto en una campaña que un contracargo reabrió: si la campaña vence sin meta vuelve a KORUM con un contra-asiento y si KORUM la completa ya no vuelve, así que aportar de nuevo lo pierde y se resta del retorno, decisión del promotor del 2026-11-12): `💎 ¡Auto-Impulso Rentable! Aportar X € ➔ Retorno +Y €`, con ejecución auditada en 1 clic.

## 11. IVA de los ingresos de KORUM (decisión 21, pendiente de construir en el Sprint 5.20)

- La comisión por tramos, el mantenimiento, los «Gastos de gestión digital» y la gestión de Mi Hucha **llevan el IVA del 21 % dentro del importe mostrado**: cuota = `Math.round(importe × 21 / 121)`, en céntimos. **Nadie paga más**: metas, pizarra y textos oficiales no cambian. La gestión de comercios lleva su IVA encima, como hoy.
- **La aportación voluntaria a KORUM no lleva IVA ni factura** (decisión 22). Condiciones que deben mantenerse: voluntaria, casilla desmarcada, importe libre desde 0 € y ninguna ventaja para quien la da. Se devuelve solo si la campaña no se consigue: no hay recuperación en 14 días (decisión 80).
- Cada cuota de IVA va a su cuenta del libro mayor, en el mismo asiento que el ingreso. Facturas: completa a entidades y comercios; simplificada a familias y compradores, dentro del email del recibo y con enlace al PDF. Todas cuadran al céntimo con su asiento y se registran en Veri\*factu (Sprint 5.23). Detalle en [korum-fiscal-invoicing](../skills/korum-fiscal-invoicing/SKILL.md).
- **Una sola factura a la entidad por todo lo retenido (decisión 50, Sprint 5.20):** la factura de cada liquidación recoge la comisión, el mantenimiento **y el coste de la pasarela**, con su base y su IVA. Por dentro, el libro mayor separa lo que es para Paycomet, lo que es IVA y lo que es ingreso de KORUM. Cómo se cuadra el IVA de la línea de la pasarela sin que nadie pague más se le plantea al promotor al abrir el Sprint 5.20a.
- Hasta el Sprint 5.20 solo la gestión de comercios calcula IVA y factura.

## 12. La regla de los 14 días

Cuando alguien que debe decidir calla, o cuando una persona se arrepiente de un pago que no es una donación, el plazo es siempre **14 días** y la devolución es **automática, sin el Super-Admin**:

| Caso | Qué pasa a los 14 días o dentro de ellos | Sprint |
| :--- | :--- | :-: |
| Campaña vencida sin decisión de la entidad | Se devuelve el 100 % a quienes aportaron (antes, si ya no da tiempo a votar) | 5.17 |
| Comercio en modo publicidad sin moderar | **Excepción:** se entiende admitido y se liquida (decisión 78); solo se devuelve el 100 %, con rectificativa, si la entidad lo rechaza en el plazo | 5.16c |
| Renovación de un comercio pagada dos veces | El comercio puede pedir la devolución con un botón; si no, renueva el año siguiente | 5.16c |
| Gestión de Mi Hucha | Se devuelve si la familia cancela en los 14 días siguientes al alta | 5.15 |
| Vales sin gastar | Se devuelve el 100 % de la compra con un clic; después son a fondo perdido | 5.14c |
| Evento que cambia de fecha | Se devuelve el 100 % a quien lo pida con el enlace del aviso; la liquidación espera a que se cierre el plazo | 5.13 (hecho) |

**Nunca se devuelve por esta regla una donación**, que sigue la suerte de su campaña (§7). El plazo es un valor único de configuración y puede acortarse según lo que Paycomet responda sobre hasta cuándo se puede devolver un cobro (se supone 81 días).
