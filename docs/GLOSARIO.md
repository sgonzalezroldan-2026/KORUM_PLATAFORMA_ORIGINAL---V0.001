# Glosario · KORUM

> Significado único de cada término. Si un documento usa un término de otra forma, manda este glosario. Los **códigos internos** (en `monoespacio`) no se traducen; las **etiquetas visibles** viven en `messages/{es,ca,en}.json`.
>
> **Decisiones del promotor del 2026-11-17 al 2026-11-19, pendientes de construir salvo las que ya dicen que están construidas.** **Las rifas se retiraron** (papeletas, sorteo, acta y ronda extra) en los Sprints 5.12a y 5.12b, y llegan los **vales** en el 5.14. Los términos de rifa (papeleta, sorteo, acta, ronda extra) se retiraron con ellas; se añaden abajo «vale», «modo donación», «modo publicidad», «regla de los 14 días» y «entrega automática». Hasta el sprint indicado, lo que sigue describe lo que el código hace hoy y **no se adelanta la regla nueva**. Lista completa en [CUMPLIMIENTO §8](CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md) (decisiones 21 a 67); orden y fichas en el [plan](PLAN_IMPLEMENTACION_ATOMICO.md).

## Entidades y personas

| Término | Significado |
| :--- | :--- |
| **Entidad / organización** | Comunidad que usa KORUM: colegio, club deportivo o entidad cultural (`Organization`). |
| **Titular legal** | Persona jurídica que cobra y pasa el KYB: AMPA/AFA, titular del colegio, fundación, club o asociación (`legalName`, `legalForm`). Un colegio público siempre cobra a través de su AMPA/AFA. |
| **Vertical** | Tipo de comunidad: `SCHOOL`, `SPORTS_CLUB`, `CULTURAL`. Cambia plantillas, textos y retos. |
| **AMPA / AFA** | Asociación de madres y padres del alumnado (AFA en Cataluña). |
| **`DIRECTOR`** | Rol de gestión principal y 1ª firma de la entidad (Dirección del centro, Presidencia del club…). |
| **`COSIGNER`** | Rol de 2ª firma mancomunada (Presidencia del AMPA/AFA, Tesorería del club, Representación del patronato, Titularidad del colegio…). Su cargo visible es `roleLabel`. |
| **Doble firma (*2-Man Rule*)** | Aprobación que exige dos firmas de dos personas distintas (`DIRECTOR` + `COSIGNER`) para aprobar ideas y liberar fondos. |
| **Portería** | Vista móvil para validar entradas (el sorteo se retiró en el Sprint 5.12a; desde el 5.14c, también canjear vales en el puesto) (`/panel/[orgSlug]/porteria`), con PIN por evento y `GateSession`. |
| **Cambio de fecha de un evento** | La entidad mueve la fecha de un evento con entradas aún sin liquidar (`EventReschedule`, Sprint 5.13). Quien compró antes recibe un **enlace de devolución** personal para recuperar el 100 % durante 14 días; mientras siga abierto, el evento no se liquida. |
| **Liquidar por lo vendido** | Lo que pasa con un evento con entradas al llegar su fecha sin agotar el aforo (decisión 30, Sprint 5.13): se liquida lo recaudado, con el mantenimiento rebajado en la misma proporción. Sin ventas, se cierra sin dinero. |
| **Super-Admin** | Persona que opera la plataforma KORUM (`User.isSuperadmin`). |

## Campañas y estados

| Término | Significado |
| :--- | :--- |
| **Iniciativa / campaña** | Objetivo de recaudación de una entidad. Formato `BUDGET` (presupuesto de una mejora) o `TICKETING` (entradas; la rifa se retiró en el Sprint 5.12a y la venta de vales llega en el 5.14). |
| **Estados** | `BUDGETING` (Presupuestación) · `FUNDRAISING` (Recaudando) · `GOAL_REACHED` (¡Conseguido!) · `CLOSED` (Cerrada) · `EXPIRED` (Vencida) · `RESIZE_VOTING` (Votación de redimensionamiento) · `REFUNDING` (Devolviendo) · `REFUNDED` (Reembolsada) · `CANCELLED` (Cancelada). Transiciones en el PRD §4. |
| **Hucha de la iniciativa (`WLT-ESC-XXX`)** | Referencia del dinero retenido de una iniciativa en Paycomet. En público se llama así; "Escrow" es solo el término interno. |
| **Todo o nada** | Si no se alcanza la meta, se devuelve el 100 % de lo cobrado (o se vota redimensionar). |
| **Redimensionamiento** | Votación vinculante de los donantes para ejecutar una versión más pequeña del proyecto. |
| **Reto colectivo** | Premio para un curso o equipo si suma un número de familias. Siempre en positivo. |
| **Placa conmemorativa** | Reconocimiento físico opcional del logro, independiente del reto. |
| **Quórum** | Número mínimo de firmas verificadas (`minVotes`) para que una idea pase a la doble firma. |
| **Fase 0** | Moderación previa de una idea antes de hacerse pública. |
| **Alias `#FAM-XXXX`** | Identificador privado de la familia que propone una idea. |

## Dinero

| Término | Significado |
| :--- | :--- |
| **Céntimos y bps** | Todo importe en céntimos enteros (`2500` = 25,00 €); todo porcentaje en puntos básicos (`100` = 1 %). |
| **Libro mayor** | Registro contable de doble partida: **asientos** (`LedgerJournal`) formados por **apuntes** (`EscrowLedgerEntry`) en los que cargos y abonos suman igual. |
| **Paycomet** | Entidad de pago que cobra, retiene, reparte y devuelve el dinero. KORUM no custodia fondos. |
| ***Split transfer*** | Reparto de Paycomet desde el saldo cobrado a la cuenta destino de una entidad. Solo dentro de los **90 días** siguientes al cobro. |
| **KYB** | Verificación de la entidad titular antes de cobrar: CIF, estatutos o escrituras, DNI de quien la representa y certificado de titularidad de su cuenta (más la acreditación de la Ley 49/2002 si la declara). Se suben en *Ajustes* del panel y se envían a revisión. |
| **Estudio de edición** | Pantalla de la entidad (`/panel/{slug}/estudio`) donde diseña una campaña de presupuesto o de taquilla (la rifa se retiró en el Sprint 5.12a; la venta de vales llega en el 5.14), ve la pizarra TCO en vivo y la publica con confirmación. |
| **Plantilla de campaña** | Punto de partida del Estudio (confort, patio, excursión, becas, festival…; la de rifa se retiró en el Sprint 5.12a): rellena título, descripción y categoría, nunca el presupuesto de un proveedor. |
| **Cartel A4 con QR** | Hoja imprimible de una campaña que está recaudando, con QR real hacia su ficha pública, título y mensaje de la entidad y la dirección escrita. |
| **TCO / pizarra TCO** | Desglose interno del coste total de una campaña en el Estudio (5 líneas en `BUDGET`). |
| **Desglose de 4 líneas** | Versión pública del presupuesto, que suma exactamente la meta. |
| **Importe exento** | Cupo anual sin comisión (`exemptLimitCents`, 1.000 € por defecto). |
| **Medallas y becas** | Bronce, Plata y Oro según campañas logradas; cada una amplía el importe exento. |
| **Comisión por tramos** | Porcentaje de KORUM sobre el resto sujeto (`t1`/`t2`/`t3`). |
| **Mantenimiento ("La Baza")** | Cuota opcional por campaña con tope anual que se desactiva sola al alcanzarse. |
| **Aportación voluntaria a KORUM** | Importe opcional que la familia puede añadir para sostener la plataforma (`guaranteeContributionCents`; sugerido por `fullIntegrityCheckCents`). Check **desmarcado** por defecto. Nunca "propina". |
| **Gastos de gestión digital** | Importe por entrada o, en los vales, por compra (la papeleta de rifa se retiró en el Sprint 5.12a) que cubre la pasarela y el servicio en taquilla. Nombre exacto obligatorio. |
| **Matching 2x** | Bolsa de un comercio que duplica las donaciones de las familias hasta agotarse. |
| **Comercios amigos** | Patrocinadores locales por categoría ORO, PLATA o BRONCE. El 100 % va a la iniciativa; el fee se cobra encima. |
| **`CREDIT_POOL`** | Bolsa donde espera (retenido en Paycomet) un patrocinio cuya campaña falló o una renovación, mientras no hay campaña a la que llevarlo; plazo limitado por la ventana de 90 días. Al vencer (día 70 desde el cobro como mucho) no se devuelve al comercio: pasa al Fondo de actividades de la entidad. |
| **Fondo de actividades** | Dinero de comercios admitidos que no se pudo llevar a ninguna campaña antes de que venciera su bolsa (Sprint 4.2f). Es de la entidad para sus actividades; lo liquida a su cuenta con un destino escrito, doble firma y justificante en PDF, antes de los 90 días de Paycomet. |
| **Auto-Impulso** | Aportación de KORUM para completar una campaña cuando es rentable hacerlo. Siempre asentada. **Decidido (Sprint 5.21):** siempre visible y sin importe, solo en campañas con presupuesto; es un gasto promocional de KORUM que se compensa cobrando de menos en el reparto. Hasta entonces, su visibilidad pública la decide el Super-Admin. |
| **Retorno negativo** | Campaña en la que KORUM pierde dinero (`netRevenueCents < 0`). |
| **Salud de precios** | Comprobación (`evaluatePricingHealth`) que avisa al Super-Admin con `❗` / `⚠️` cuando una regla de precio pierde dinero o es incoherente. Nunca bloquea: el Super-Admin ajusta o acepta y registra. |
| **Modo de tramos (`FLAT` / `MARGINAL`)** | `FLAT`: el tramo se elige por el importe total y se aplica a todo lo sujeto (con efecto escalón). `MARGINAL`: cada tramo grava solo su porción. |
| **Tareas externas aplazadas** | Gestiones con terceros (Paycomet, abogado, asesoría fiscal, proveedor Veri\*factu) que el promotor ha dejado para más adelante; bloquean el cobro de dinero real, no la construcción. |
| **6 fuentes de ingresos** | Aportación voluntaria, comisión por tramos, fee de comercios, gastos de gestión digital, mantenimiento y gestión de recargas de la Hucha. |
| **Real frente a proyectado** | Ingresos ya asentados en el libro mayor frente a los previstos si las campañas llegan al 100 %. |
| **Mi Hucha** | Área de la familia para aportar de forma recurrente. Modos: `DISABLED` (así sale en el lanzamiento, Sprint 5.15) y `PLEDGE` (aportación mensual programada, sin saldo). `REGULATED_WALLET` (monedero con saldo) queda **descartado** y se retira del código en el Sprint 5.24b. |
| **Vale** | Unidad de canje de pago anticipado que vende una entidad, como la ficha de una feria: precio único, sin numerar, en un solo QR con saldo que se gasta en su puesto. No es dinero ni una donación: sin certificado y fuera del Modelo 182. Sus Gastos de gestión digital van por compra, no por vale. Construido en los Sprints 5.14a, 5.14b y 5.14c. |
| **Puesto de canje** | Pantalla del móvil de quien atiende el puesto de una venta de vales (`/panel/{slug}/porteria/{código}`), con el PIN del puesto, que vale hasta que caducan los vales. Solo con red: se lee el QR, se ve cuántos vales quedan y se teclea cuántos se gastan (Sprint 5.14c). |
| **Devolución de lo no gastado** | Lo que vuelve de una compra de vales con algún vale gastado cuando la entidad cancela la venta antes de liquidarla o acorta la validez (decisión 69): la parte de lo pagado (vales y Gastos de gestión digital) que corresponde a los vales sin gastar. Lo gastado se queda y se liquida a la entidad (`PartialRefund`, Sprint 5.14c). |
| **Aportación «sin producto»** | Pago a una venta de vales agotada, si la entidad lo permite, sin recibir vales ni QR. Es una aportación sin certificado, fuera del Modelo 182, con los mismos Gastos de gestión digital; no se ofrece a un colegio con ánimo de lucro (decisiones 64 y 65). Sprint 5.14a. |
| **Modo donación / modo publicidad** | Los dos modos en que una entidad recibe dinero de comercios. *Donación* (por defecto): entra directo, sin moderación, y la entidad puede agradecerlo solo con el nombre. *Publicidad*: la entidad factura con IVA y el comercio recibe distintivo, categoría, ventaja y cartel. Sprint 5.16. |
| **Gestión (de comercios)** | Comisión de KORUM sobre la aportación de un comercio, con un porcentaje para cada modo. Sustituye a «gestión publicitaria» en el Sprint 5.16. |
| **Regla de los 14 días** | Plazo único de las devoluciones automáticas cuando quien debe decidir calla o cuando una persona se arrepiente de un pago que no es una donación (Regla 02 §12). |
| **Entrega automática** | Reparto que la plataforma hace sola a la cuenta verificada de la entidad cinco días antes de que venza la ventana de 90 días de un cobro. Sprint 5.19. |
| **Sesión** | Trabajo del plan que no escribe código de la aplicación (textos legales, decisiones, revisión crítica, maquetas, revisión de nativo). |
| **`JET-ID`** | Tokenización de tarjetas de Paycomet para cobros recurrentes sin guardar el número de tarjeta. |

## Seguridad, fiscalidad y privacidad

| Término | Significado |
| :--- | :--- |
| **Email canónico** | Email normalizado (sin `+alias` ni puntos de Gmail) para impedir firmas múltiples. |
| **Regla padre/madre** | Hasta 2 cuentas familiares por dispositivo cuentan como verificadas; la 3ª, como sospechosa. |
| **Candado semántico** | Bloqueo de categorías exentas cuando el texto describe obras o equipamiento (expresiones con límites de palabra). |
| **QR HMAC** | Código de entrada firmado que no se puede falsificar ni reutilizar. |
| **Ley 49/2002 (`ley49`)** | Régimen fiscal del mecenazgo. Solo con `ley49VerifiedAt` se emiten certificados fiscales y el Modelo 182. |
| **Modelo 182** | Declaración informativa anual de donativos a la AEAT. |
| **Justificante nominativo** | Documento de la aportación sin efectos fiscales (entidades sin Ley 49/2002). |
| **Veri\*factu** | Sistema de la AEAT para facturas verificables (huella encadenada y QR). KORUM factura a través de un proveedor homologado. |
| **HMAC** | Huella con clave de un dato (NIF, IP) que permite buscarlo sin guardarlo en claro. |
| **EIPD** | Evaluación de impacto en protección de datos. |

## Método de trabajo

| Término | Significado |
| :--- | :--- |
| **Sprint** | Unidad de entrega del plan (`4–8` archivos con sus tests). |
| **5 puertas** | Invariantes y tipos · tests unitarios · auditoría *War Room* · navegador real · no regresión. |
| ***War Room*** | Subagentes auditores independientes (financiero, seguridad y legal, experiencia, QA). |
| **Constructor (*builder*)** | Subagente que escribe el código de un sprint. |
| **Bitácora** | [BITACORA_SPRINTS.md](BITACORA_SPRINTS.md): estado y traspaso entre sesiones y modelos. |
| **Ancla** | Texto exacto (`id="..."` o `function ...`) para localizar un bloque del prototipo. |
