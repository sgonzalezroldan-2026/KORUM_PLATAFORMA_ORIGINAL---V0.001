# Índice anatómico de `prototype/Korum_v8.html`

> **Cómo usarlo:** localiza el **ancla** con una búsqueda de texto exacta (Grep / búsqueda del editor) y lee unas 150–250 líneas a partir de ella. La columna *Línea* está verificada y la comprueba el escáner `verify-invariants.mjs` en cada sprint: si el prototipo cambiara, el escáner fallaría y este índice se actualizaría en el mismo sprint.
>
> **Estado:** prototipo **congelado** (5.407 líneas). Es referencia **funcional**: su paleta, su logotipo y su barra de demostración no se trasladan a producción (ver Regla 01 §6).

## 1. Estilos y cabecera de demostración

| Bloque | Ancla | Línea |
| :--- | :--- | :--- |
| Configuración Tailwind del prototipo (paleta antigua: no usar) | `tailwind.config = {` | L10 |
| Clases CSS: `.korum-paper-dots`, `.korum-notebook-sheet`, `.die-cut-sticker`, `.tactile-btn`, `.korum-trust-vault`, `.mobile-stack`, `@media print` | `<style>` | L42 |
| Tooltip diferido de 1000 ms | `id="delayed-tooltip"` | L178 |
| Barra superior de demostración (no va a producción) | `<header class="sticky top-0` | L183 |
| Selector de entornos (demostración) | `id="env-btn-family"` | L230 |
| Avisos emergentes (toast) | `id="toast"` | L261 |

## 2. Entorno 1 · Familias y comercios (HTML)

| Bloque | Ancla | Línea |
| :--- | :--- | :--- |
| Contenedor del entorno de familias | `id="env-family"` | L273 |
| Portada del centro con barra de impacto | `id="school-hero-header"` | L277 |
| Píldora de Mi Hucha | `id="header-wallet-pill"` | L312 |
| Barra de filtros (oculta por defecto) | `id="family-filters-bar"` | L363 |
| Grid de campañas | `id="fview-activas"` | L390 |
| Ficha detallada (`.mobile-stack`) | `id="fview-detail"` | L395 |
| Buzón de ideas | `id="fview-ideas"` | L398 |
| Logros Antes / Después | `id="fview-logros"` | L415 |
| Comercios amigos | `id="fview-comercios"` | L427 |
| Mi Hucha (recargas, retirada, QR, chat, fiscal, RGPD) | `id="fview-mihucha"` | L447 |
| FAQ y soporte | `id="fview-faq"` | L599 |

## 3. Entorno 2 · Panel de la entidad (HTML)

| Bloque | Ancla | Línea |
| :--- | :--- | :--- |
| Contenedor del panel, cabecera y medallas | `id="env-school"` | L646 |
| Cuadro de mandos (6 estados, filtros ocultos) | `id="sch-sub-dashboard"` | L688 |
| Moderación, doble firma, comercios, KYB y ajustes | `id="sch-sub-moderation"` | L741 |
| Estudio dual y pizarra TCO | `id="sch-sub-studio"` | L858 |
| Liquidación, Antes/Después, redimensionamiento y reembolso | `id="sch-sub-escrow"` | L1102 |
| Soporte de la entidad al Super-Admin | `id="sch-sub-support"` | L1161 |

## 4. Entorno 3 · Consola del Super-Admin (HTML)

| Bloque | Ancla | Línea |
| :--- | :--- | :--- |
| Contenedor de la consola | `id="env-superadmin"` | L1187 |
| BI: KPIs, 6 fuentes, tablas ordenables | `id="sa-sub-bi"` | L1211 |
| Ficha 360º | `id="sa-sub-crm"` | L1350 |
| Reglas globales, costes y medallas | `id="sa-sub-rules"` | L1361 |
| Bandeja de soporte | `id="sa-sub-tickets"` | L1497 |

## 5. Modales e imprimibles (HTML)

| Bloque | Ancla | Línea |
| :--- | :--- | :--- |
| Checkout dual (familia, taquilla, comercio) | `id="checkout-modal"` | L1507 |
| Retirada de saldo (en producción: reembolso al medio original) | `id="withdraw-iban-modal"` | L1664 |
| Pop-up ejecutivo de iniciativa | `id="sa-init-popup-modal"` | L1692 |
| Entrada / papeleta imprimible | `id="printable-ticket-modal"` | L1708 |
| Kit de medalla | `id="medal-kit-modal"` | L1767 |
| Nueva idea | `id="new-idea-modal"` | L1806 |
| Detalle de comercio | `id="sponsor-detail-modal"` | L1827 |
| Cartel A4 con QR | `id="poster-modal"` | L1837 |
| Compartir en WhatsApp y redes | `id="share-modal"` | L1896 |
| Acceso (demostración) | `id="login-modal"` | L1912 |

## 6. Lógica JavaScript de referencia

| Bloque | Ancla | Línea |
| :--- | :--- | :--- |
| Plantilla de 13 cursos | `const OFFICIAL_13_COURSES` | L1937 |
| Estado maestro de demostración | `const appState = {` | L1944 |
| Categorías efectivas y exenciones | `function getEffectiveCategoriesForSchool` | L2368 |
| Gastos de gestión digital por entidad | `function getTicketDigitalFeeForSchool` | L2386 |
| Candado semántico (versión con `.includes`, sustituir por `\b`) | `function checkCategoryComplianceFraud` | L2394 |
| Portada de familias | `function renderFamilyCampaigns` | L2500 |
| Ficha detallada y desglose de 4 líneas | `function openInitiativeDetail` | L2608 |
| Selector de cursos | `function buildCoursesSelectHtml` | L2790 |
| Abrir checkout | `function openCheckoutModal` | L2831 |
| Resumen del checkout | `function updateChkSummary` | L2973 |
| Completar pago | `function completeDonation` | L3010 |
| Buzón de ideas | `function renderFamilyIdeas` | L3150 |
| Firmar una idea | `function votePublicIdea` | L3208 |
| Proponer una idea (Fase 0) | `function submitAnonymousIdeaPhase0` | L3267 |
| Logros | `function renderFamilyAchievements` | L3290 |
| Comercios amigos | `function renderFamilySponsors` | L3319 |
| Recarga puntual | `function executeInstantTopup` | L3389 |
| Recarga mensual | `function activateMonthlyTopup` | L3415 |
| Retirada de saldo | `function confirmWithdrawHuchaToBank` | L3451 |
| Vista de Mi Hucha | `function renderMiHucha` | L3464 |
| Validación DNI/NIE | `function validateSpanishIDLive` | L3524 |
| Certificado fiscal | `function downloadAutonomousTaxCert` | L3536 |
| Derecho al olvido | `function exerciseRightToBeForgotten` | L3540 |
| Explicación de medallas | `function renderSchoolMedalsExplainer` | L3562 |
| Cuadro de mandos de la entidad | `function renderSchoolDashboard` | L3606 |
| Moderación | `function renderSchoolModeration` | L3674 |
| Renovación automática de comercios | `function simulateSponsorAutomaticRenewal` | L3792 |
| Ajustes de la entidad | `function saveSchoolGlobalSettings` | L3825 |
| Cargar iniciativa en el Estudio | `function loadInitiativeIntoStudio` | L3885 |
| Pizarra TCO | `function recalcStudioTCO` | L3942 |
| Guardar desde el Estudio | `function saveInitiativeFromStudio` | L4060 |
| Cerrar y publicar un logro | `function closeAndPublishAchievedInitiative` | L4167 |
| Encuesta de redimensionamiento | `function sendResizePollToDonors` | L4199 |
| Reembolso y reasignación de comercios | `function executeAutomaticRefundAndSponsorReassign` | L4203 |
| Cartel A4 | `function updatePosterPreview` | L4251 |
| Ingresos de una iniciativa | `function calculateInitiativeRevenueBreakdown` | L4273 |
| Análisis de Auto-Impulso | `function calculateSelfBoostAnalysis` | L4325 |
| Corregir tarifa con retorno negativo | `function fixNegativeReturnTariff` | L4343 |
| Ejecutar Auto-Impulso | `function executeSuperAdminSelfBoost` | L4358 |
| Gráfico de 6 fuentes | `function renderRevenueSourcesChartInto` | L4381 |
| Ordenación de tablas | `function sortSaTable` | L4430 |
| Pop-up ejecutivo | `function openSuperAdminInitiativePopup` | L4460 |
| BI del Super-Admin | `function renderSuperAdminBI` | L4552 |
| Ficha 360º | `function renderSchoolCRM360` | L4760 |
| Reglas individuales de la entidad | `function saveIndividualSchoolRules` | L5001 |
| Validador de gastos de gestión digital | `function validateTicketFeeCoverageLive` | L5022 |
| Costes de pasarela y recarga | `function saveGatewayAndTopupCosts` | L5043 |
| Reglas económicas globales | `function saveGlobalEconomicRules` | L5055 |
| Configuración de medallas | `function saveMedalsConfiguration` | L5075 |
| Categorías globales y tickets | `function renderSuperAdminCategoriesAndTickets` | L5089 |
| Ticket de ayuda inteligente | `function submitSmartHelpTicket` | L5136 |
| Aprobar idea en Fase 0 | `function approvePhase0ToPublic` | L5174 |
| Doble firma de idea a presupuesto | `function approveDoubleCheckToBudget` | L5185 |
| Moderar comercio | `function moderateSponsor` | L5212 |
| Navegación entre entornos (demostración) | `function switchEnv` | L5231 |
| Simulador móvil (demostración) | `function setFamilyViewport` | L5308 |
| Compartir | `function openShareModal` | L5323 |
| Perfiles simulados (demostración) | `function switchSimulatedUserProfile` | L5338 |
