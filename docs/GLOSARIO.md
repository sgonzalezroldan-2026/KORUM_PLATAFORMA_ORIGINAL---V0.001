# Glosario · KORUM

> Significado único de cada término. Si un documento usa un término de otra forma, manda este glosario. Los **códigos internos** (en `monoespacio`) no se traducen; las **etiquetas visibles** viven en `messages/{es,ca,en}.json`.

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
| **Portería** | Vista móvil para validar entradas y hacer sorteos (`/panel/[orgSlug]/porteria`), con PIN por evento y `GateSession`. |
| **Super-Admin** | Persona que opera la plataforma KORUM (`User.isSuperadmin`). |

## Campañas y estados

| Término | Significado |
| :--- | :--- |
| **Iniciativa / campaña** | Objetivo de recaudación de una entidad. Formato `BUDGET` (presupuesto de una mejora) o `TICKETING` (entradas o rifa). |
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
| **TCO / pizarra TCO** | Desglose interno del coste total de una campaña en el Estudio (5 líneas en `BUDGET`). |
| **Desglose de 4 líneas** | Versión pública del presupuesto, que suma exactamente la meta. |
| **Importe exento** | Cupo anual sin comisión (`exemptLimitCents`, 1.000 € por defecto). |
| **Medallas y becas** | Bronce, Plata y Oro según campañas logradas; cada una amplía el importe exento. |
| **Comisión por tramos** | Porcentaje de KORUM sobre el resto sujeto (`t1`/`t2`/`t3`). |
| **Mantenimiento ("La Baza")** | Cuota opcional por campaña con tope anual que se desactiva sola al alcanzarse. |
| **Aportación voluntaria a KORUM** | Importe opcional que la familia puede añadir para sostener la plataforma (`guaranteeContributionCents`; sugerido por `fullIntegrityCheckCents`). Check **desmarcado** por defecto. Nunca "propina". |
| **Gastos de gestión digital** | Importe por entrada o papeleta que cubre la pasarela y el servicio en taquilla. Nombre exacto obligatorio. |
| **Matching 2x** | Bolsa de un comercio que duplica las donaciones de las familias hasta agotarse. |
| **Comercios amigos** | Patrocinadores locales por categoría ORO, PLATA o BRONCE. El 100 % va a la iniciativa; el fee se cobra encima. |
| **`CREDIT_POOL`** | Bolsa donde espera un patrocinio cuya campaña falló y no hay otra activa; plazo limitado por la ventana de 90 días. |
| **Auto-Impulso** | Aportación de KORUM para completar una campaña cuando es rentable hacerlo. Siempre asentada; su visibilidad pública la decide el Super-Admin. |
| **Retorno negativo** | Campaña en la que KORUM pierde dinero (`netRevenueCents < 0`). |
| **Salud de precios** | Comprobación (`evaluatePricingHealth`) que avisa al Super-Admin con `❗` / `⚠️` cuando una regla de precio pierde dinero o es incoherente. Nunca bloquea: el Super-Admin ajusta o acepta y registra. |
| **Modo de tramos (`FLAT` / `MARGINAL`)** | `FLAT`: el tramo se elige por el importe total y se aplica a todo lo sujeto (con efecto escalón). `MARGINAL`: cada tramo grava solo su porción. |
| **Tareas externas aplazadas** | Gestiones con terceros (Paycomet, abogado, asesoría fiscal, proveedor Veri\*factu) que el promotor ha dejado para más adelante; bloquean el cobro de dinero real, no la construcción. |
| **6 fuentes de ingresos** | Aportación voluntaria, comisión por tramos, fee de comercios, gastos de gestión digital, mantenimiento y gestión de recargas de la Hucha. |
| **Real frente a proyectado** | Ingresos ya asentados en el libro mayor frente a los previstos si las campañas llegan al 100 %. |
| **Mi Hucha** | Área de la familia para aportar de forma recurrente. Modos: `PLEDGE` (aportación mensual programada, sin saldo), `REGULATED_WALLET` (saldo custodiado por una entidad autorizada), `DISABLED`. |
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
