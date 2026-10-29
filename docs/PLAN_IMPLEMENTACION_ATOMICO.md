# Plan Maestro de Implementación Atómica · KORUM Full-Stack (v8.5 Calibrated Edition)

> **Protocolo de Ejecución de Máxima Capacidad y Cero Errores:**
> 1. **Dimensionamiento Óptimo por Entrega:** Cada Micro-Sprint está calibrado al *sweet spot* cognitivo y de tokens de salida del modelo (`4–8` archivos cohesivos, `~600–1.050` líneas de código de producción + su suite de tests automatizados), separando estrictamente los motores matemáticos/criptográficos puros (Fases 1–2) de las interfaces complejas (Fases 3–5).
> 2. **1 Micro-Sprint por Turno (salvo instrucción expresa de encadenar):** Dedica el 100% de la capacidad de razonamiento a entregar archivos completos, tipados (`strict: true`) y sin un solo `TODO` ni recorte.
> 3. **Cierre por 5 Puertas QA (`5-Gate DoD`):** Antes de cambiar `[ ]` por `[x]`, ejecuta siempre `verify-invariants.mjs`, `typecheck`, `Vitest`/`Playwright` y la auditoría independiente de los subagentes del **War Room** indicados en cada sprint.

---

## FASE 0: Prototipo Maestro, Blindaje Regulatorio v8.5 y Arquitectura Agéntica

- [x] **SPRINT 0.0 — Prototipo Funcional Maestro (`prototype/Korum_v8.html`):**
  - Entregado y preservado intacto (`5.217` líneas) con los 3 entornos, los 23 puntos estructurales y los 12 puntos de pulido.
- [x] **SPRINT 0.5 — Saneamiento de Repositorio, Blindaje PSD2/AEAT/Veri\*factu y Especificación v8.5:**
  - Principio de **100% Independencia de Proveedores (Operativa Zero-Touch / Lean)**, esquema Prisma de 18 modelos en céntimos enteros (`schema/schema.prisma`), contratos estrictos (`src/types/korum.types.ts`) y semilla contable de 8 iniciativas reconciliadas con `0` céntimos de desviación (`src/mocks/seed_data.json`).
- [x] **SPRINT 0.6 — Calibración del Plan, Matriz QA de 5 Puertas y Ecosistema de 8 Subagentes + 6 Skills:**
  - Corrección del truncamiento de contexto en `AGENTS.md`/`GEMINI.md`, creación de los 4 subagentes *Builders* + 4 subagentes *War-Room Auditors*, creación de `korum-nextjs-multitenant-ui` (con índice anatómico línea por línea de `Korum_v8.html`) y `korum-qa-harness-gatekeeper` (con escáner ejecutable `verify-invariants.mjs`), y matriz QA integral por fases.

---

## FASE 1: Cimientos Next.js, Arnés QA, Persistencia en Céntimos y Motor Matemático Puro (4 Micro-Sprints)

- [ ] **SPRINT 1.1 — Configuración Next.js 15 + Tailwind Dual (`corp` + `patio`) + Primitivas UI y Marca + Arnés Determinista QA (`Vitest` / `Playwright` / `Docker DB`):**
  - **Alcance (`~750 LOC`):** Crear `package.json` (Prisma `schema/schema.prisma`, Next 15, React 19, Tailwind, Zod, `qrcode`, Vitest, Playwright), `tsconfig.json` (`strict: true`, `noUncheckedIndexedAccess: true`), `next.config.ts`, `tailwind.config.ts` y `src/app/globals.css` (paletas `corp` y `patio`, tipografías `Fredoka`/`Plus Jakarta Sans`, `.korum-paper-dots`, `.korum-court-grid`, `.die-cut-sticker`, `.tactile-btn`, `.korum-trust-vault`, `.mobile-stack`, `.mobile-simulator-wrap`), `docker-compose.yml` (PostgreSQL 16 local en 1 comando), `src/config/env.ts` (Zod), `.env.example`, `vitest.config.ts`, `playwright.config.ts` (`1440x900` y `430x932`) y componentes primitivos base (`KorumLogo`, `EscrowTrustBadge`, `CurrencyText`, `DelayedTooltip` `1000ms`, `ToastProvider`, `SortableTh`, `StatusBadge`).
  - **Skills:** `korum-brand-design-system`, `korum-nextjs-multitenant-ui`, `korum-qa-harness-gatekeeper`.
  - **Builder / Auditores:** Orquestador Principal + `korum-brand-visual-director` ➔ `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-C01`, `QA-C02`.

- [ ] **SPRINT 1.2 — Cliente Prisma, Helpers Monetarios Enteros y Libro Mayor de Doble Partida (`EscrowLedgerEntry`):**
  - **Alcance (`~700 LOC`):** Implementar `src/lib/prisma.ts`, `src/core/finance/money.ts` (`centsToEuros`, `formatCentsEs`, `eurosToCents`, `bpsOf`, guardias `assertSafeCents`) y `src/core/finance/ledger.service.ts` (asientos inmutables de doble partida equilibrados `DEBIT == CREDIT` con `idempotencyKey` obligatoria en `prisma.$transaction`, más reserva y liberación automática de `exemptRemainingCents` y `medalGrantAvailableCents` si una campaña expira o se reembolsa) + Suite `tests/unit/ledger.spec.ts`.
  - **Skills:** `korum-tco-calculator`, `korum-escrow-payments`, `korum-qa-harness-gatekeeper`.
  - **Builder / Auditores:** `korum-core-fintech-architect` ➔ `fintech-escrow-auditor` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-C03`, `QA-FIN01`.

- [ ] **SPRINT 1.3 — Semilla Contable Completa (`prisma/seed.ts`) y Capa de Repositorios con Aislamiento Multi-Tenant:**
  - **Alcance (`~850 LOC`):** Implementar `prisma/seed.ts` volcando el 100% de `src/mocks/seed_data.json` (reglas globales, medallas, *CEIP Cervantes*, *Colegio San José*, *Club Deportivo Basket Vallès* e *IES Mediterráneo*, las 8 iniciativas, 5 comercios, 3 ideas con auditoría y chat, entradas QR, facturas Veri\*factu y tickets, con reconciliación matemática post-seed) y `src/repositories/korum.repository.ts` con guardias obligatorias por `organizationId` (prevención anti-IDOR) + Suite `tests/unit/seed-and-tenant.spec.ts`.
  - **Skills:** `korum-nextjs-multitenant-ui`, `korum-tco-calculator`, `korum-qa-harness-gatekeeper`.
  - **Builder / Auditores:** `korum-core-fintech-architect` ➔ `fintech-escrow-auditor` + `antifraud-legal-guardian` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-C04`, `QA-SEC01`.

- [ ] **SPRINT 1.4 — Motor Matemático TCO Dual, Tope Anual Auto-Desactivable y Analítica BI (Real vs. Proyectada) con Fuzzing 1.000x:**
  - **Alcance (`~900 LOC`):** Programar en `src/core/finance/tco.service.ts` y `src/core/finance/bi-analytics.service.ts`: `calculateStudioBudgetTCO` (`Math.ceil` al euro superior absorbiendo `0–99` céntimos en `gatewayFeeCents` para `0` céntimos de desviación), `calculateStudioTicketingTCO` (coste Paycomet sobre cobro bruto real `precio + gestión`), `calculatePublicBreakdown4Lines`, `evaluateMaintenanceCapShutoff` (tope anual `147,00 €`), `calculateRevenueBreakdown6Sources` (separando Devengado Real vs. Proyectado al 100%, cero constantes ficticias) y detector de `💎 Auto-Impulso Rentable` y `🚨 Peligro Retorno Negativo` + Suite `tests/unit/tco-bi-fuzz.spec.ts` (incluyendo **1.000 iteraciones paramétricas deterministas**).
  - **Skills:** `korum-tco-calculator`, `korum-qa-harness-gatekeeper`.
  - **Builder / Auditores:** `korum-core-fintech-architect` ➔ `fintech-escrow-auditor` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-FIN02`, `QA-FIN03`, `QA-FIN04`, `QA-FIN05`.

---

## FASE 2: Motores Backend de Grado Bancario — Paycomet PSD2, Seguridad, QR HMAC y AEAT (3 Micro-Sprints)

- [ ] **SPRINT 2.1 — Adaptador Bancario Paycomet REST API, Webhooks HMAC Idempotentes y Refund PSD2 (`src/services/payments/...`):**
  - **Alcance (`~900 LOC`):** Implementar `paycomet.adapter.ts` (modo Live/Sandbox REST API + Simulador Determinista Local con firmas HMAC reales para E2E offline), onboarding KYB de subcomercios, órdenes Escrow (`WLT-ESC-XXX`), Bizum/Tarjeta en céntimos, suscripciones `JET-ID`, reembolso `executeRefundToOrigin` exclusivo al medio de pago original (prohibido IBAN libre, cumplimiento PSD2/AML), bolsa `CREDIT_POOL`, `Split Transfer` y endpoint `/api/webhooks/paycomet/route.ts` con idempotencia concurrente + Suite `tests/unit/paycomet-escrow.spec.ts`.
  - **Skills:** `korum-escrow-payments`, `korum-qa-harness-gatekeeper`.
  - **Builder / Auditores:** `korum-core-fintech-architect` ➔ `fintech-escrow-auditor` + `antifraud-legal-guardian` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-P01`, `QA-P02`.

- [ ] **SPRINT 2.2 — Motor de Seguridad, Quórum Padre/Madre en Servidor, Doble Firma Criptográfica y Candado Semántico `\b`:**
  - **Alcance (`~850 LOC`):** Implementar en `src/core/security/`: `email-normalizer.ts` (`canonicalEmail` anti-puntos/`+alias` Gmail y bloqueo de dominios desechables), `device-quorum.service.ts` (`<= 2` cuentas familiares `VERIFIED`, `>= 3` o ráfaga IP `/24` = `SUSPICIOUS`), `double-check.service.ts` (regla `2-Man Rule` exigiendo `ROLE_DIRECTOR` + `ROLE_AFA_PRESIDENT` por dos usuarios distintos y token OTP de firma 1-clic) y `semantic-lock.ts` (regex `\b` con lista blanca contextual para `"sin cobrar"`, `"maniobra"`, `"sobras"`, `"obra de teatro"`) + Suite `tests/unit/security-quorum.spec.ts`.
  - **Skills:** `korum-quorum-antifraud`, `korum-qa-harness-gatekeeper`.
  - **Builder / Auditores:** `korum-security-gov-engineer` ➔ `antifraud-legal-guardian` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-SEC02`, `QA-SEC03`, `QA-SEC04`.

- [ ] **SPRINT 2.3 — Motor Criptográfico de Taquilla QR (`HMAC-SHA256`), Sorteo Certificado (`CSPRNG`) y Cumplimiento Tributario AEAT (`Modelo 182` + `Veri*factu`):**
  - **Alcance (`~950 LOC`):** Implementar `src/core/ticketing/ticketing-qr.service.ts` (reserva atómica de aforo contra condiciones de carrera `Promise.all`, numeración correlativa `#0001..#NNNN` en rifas, firma/verificación `HMAC-SHA256` con `timingSafeEqual`, check-in parcial familiar y sorteo `crypto.randomInt`) y `src/core/tax/tax-compliance.service.ts` (validador oficial DNI/NIE/CIF módulo 23, generador de Certificado Ley 49 / Justificante Nominativo excluyendo `TOPUP` y `TICKET`, exportador de ancho fijo `.BOE` Tipo 1 y Tipo 2 del **Modelo 182 AEAT** y encadenamiento hash `SHA-256` + URL QR **Veri\*factu**) + Suite `tests/unit/ticketing-tax.spec.ts`.
  - **Skills:** `korum-ticketing-qr`, `korum-quorum-antifraud`, `korum-escrow-payments`, `korum-qa-harness-gatekeeper`.
  - **Builder / Auditores:** `korum-security-gov-engineer` ➔ `fintech-escrow-auditor` + `antifraud-legal-guardian` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-P03`, `QA-REG01`, `QA-REG02`, `QA-REG03`.

---

## FASE 3: Entorno 0 (Marketing/Auth) y Entorno 1 (Familias, Comercios y Viralidad WhatsApp) (7 Micro-Sprints)

- [ ] **SPRINT 3.1 — Entorno 0: Landing Comercial Autónoma, Buscador Instantáneo y Calculadora de Impacto (`src/app/(marketing)/page.tsx`):**
  - **Alcance (`~750 LOC`):** Hero B2B/B2C, buscador instantáneo de colegios y clubes activos, simulador interactivo de recaudación en vivo, sello prominente de **100% Independencia de Proveedores (0% intermediación)** y escaparate de logros reales + Test Playwright `tests/e2e/marketing.spec.ts`.
  - **Skills:** `korum-nextjs-multitenant-ui`, `korum-tco-calculator`, `korum-qa-harness-gatekeeper`.
  - **Builder / Auditores:** `korum-family-viral-builder` ➔ `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-M01`, `QA-F06`.

- [ ] **SPRINT 3.2 — Autenticación Multi-Rol, Onboarding "Zero-Touch" de Comunidades y Barra Maestra KORUM (`src/app/(auth)/...`):**
  - **Alcance (`~850 LOC`):** `/login` (Magic Link/OTP para familias/comercios; 2FA para Dirección/AFA y Super-Admin), `/registro-comunidad` (alta autónoma con `1.000,00 €` exentos automáticos y plantilla `SCHOOL` vs `SPORTS_CLUB`), Middleware RBAC (`/school/[orgSlug]`, `/porteria` PIN temporal, `/admin`) y Barra Superior Maestra KORUM (`Korum_v8.html` `L103–166`: selector de entornos, conmutador `🖥️ Web / 📱 Móvil 430px` y selector demo de 3 perfiles anti-fraude + invitado) + Test Playwright `tests/e2e/auth-rbac.spec.ts`.
  - **Skills:** `korum-nextjs-multitenant-ui`, `korum-quorum-antifraud`, `korum-qa-harness-gatekeeper`.
  - **Builder / Auditores:** `korum-security-gov-engineer` ➔ `antifraud-legal-guardian` + `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-M02`, `QA-SEC05`.

- [ ] **SPRINT 3.3 — Shell Público Multi-Vertical (`/[orgSlug]`), Portada (`Recaudando`), Ficha Cuadrada al 100% y Tarjetas Virales WhatsApp (`next/og`):**
  - **Alcance (`~950 LOC`):** Cabecera dinámica del centro/club (`L170–271`), píldora `🐷 Mi Hucha`, barra de impacto colectivo, botón `🔍 Filtrar` con barra oculta por defecto, grid de iniciativas `Recaudando` con `💛 X aportaciones` e insignia *Matching 2x*, Ficha Detallada `.mobile-stack` (`L2444–2602`: solo `Hucha Escrow` + `Fecha límite`, 4 líneas = `100%` meta, Reto Colectivo por Curso/Categoría y Placa independientes), Modal Compartir WhatsApp y endpoint `/api/og/initiative/[id]/route.tsx` + Test Playwright `tests/e2e/family-catalog-detail.spec.ts`.
  - **Skills:** `korum-nextjs-multitenant-ui`, `korum-tco-calculator`, `korum-qa-harness-gatekeeper`.
  - **Builder / Auditores:** `korum-family-viral-builder` ➔ `fintech-escrow-auditor` + `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-F01`, `QA-F02`, `QA-F03`, `QA-F06`.

- [ ] **SPRINT 3.4 — Checkout Express 10s (Familias y Taquilla/Rifas QR): Email Invitado, Multi-Vertical y Pase QR Imprimible:**
  - **Alcance (`~950 LOC`):** Modal de Checkout (`L1390–1535`, `L2603–2967`) para Donación Familiar y Taquilla/Rifa: captura de `guestEmail` sin contraseña en modo invitado, selector dinámico (`13 cursos oficiales + 2 comunidad` en Colegios vs `categorías deportivas` en Clubes), check `🛡️ Activar aportación de garantía KORUM (+X,XX €)` con texto condicional `organization.ley49`, selector manual de aportación voluntaria, pago con *Mi Hucha* (deshabilitada si saldo insuficiente) / Bizum / Tarjeta, control atómico de entradas, *Gastos de gestión digital* y Modal Imprimible de Entrada/Papeleta (`L1583–1623`) con QR `HMAC` real + Test Playwright `tests/e2e/family-checkout-tickets.spec.ts`.
  - **Skills:** `korum-nextjs-multitenant-ui`, `korum-escrow-payments`, `korum-ticketing-qr`, `korum-qa-harness-gatekeeper`.
  - **Builder / Auditores:** `korum-family-viral-builder` ➔ `fintech-escrow-auditor` + `antifraud-legal-guardian` + `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-F04`, `QA-F07`.

- [ ] **SPRINT 3.5 — Directorio de Comercios Amigos (`Oro > Plata > Bronce`) y Checkout B2B de Patrocinio 100% Íntegro + Factura Veri\*factu:**
  - **Alcance (`~750 LOC`):** Vista `🏪 Comercios Amigos` (`L310–329`, `L3129–3164`: estrictamente sin importes ni fees en público, orden `🥇 ORO > 🥈 PLATA > 🥉 BRONCE`, modal de ventaja/código para familias) + pestaña Comercio del Checkout (selección de rango, opción de Reto Multiplicador *Matching 2x*, `+15%` encima, datos fiscales CIF y descarga inmediata de justificante + factura con hash/QR **Veri\*factu**) + Test Playwright `tests/e2e/sponsors-verifactu.spec.ts`.
  - **Skills:** `korum-nextjs-multitenant-ui`, `korum-escrow-payments`, `korum-qa-harness-gatekeeper`.
  - **Builder / Auditores:** `korum-family-viral-builder` ➔ `fintech-escrow-auditor` + `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-F05`.

- [ ] **SPRINT 3.6 — Buzón de Ideas con Quórum Auditado en Servidor y Galería Interactiva Antes / Después:**
  - **Alcance (`~750 LOC`):** Vista `💡 Buzón de Ideas` (`L281–297`, `L1666–1686`, `L2968–3099`: modal de propuesta anónima Fase 0 `#FAM-XXXX`, firma registrada en 1 clic con normalización `canonicalEmail` y regla Padre/Madre `<=2` en servidor) + Vista `🎉 Logros Conseguidos` (`L298–309`, `L3100–3128`: comparador visual Antes y Después, mensaje de agradecimiento y botón de compartir logro) + Test Playwright `tests/e2e/ideas-achievements.spec.ts`.
  - **Skills:** `korum-nextjs-multitenant-ui`, `korum-quorum-antifraud`, `korum-qa-harness-gatekeeper`.
  - **Builder / Auditores:** `korum-family-viral-builder` ➔ `antifraud-legal-guardian` + `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-F09`.

- [ ] **SPRINT 3.7 — Área Privada "Mi Hucha KORUM" (Recarga Dual, Refund PSD2 y Rigor Fiscal) + Chat Anónimo + RGPD + FAQ/Soporte (`.mobile-stack`):**
  - **Alcance (`~950 LOC`):** Vista `🐷 Mi Hucha` (`L330–481`, `L3165–3356`: recarga puntual instantánea y suscripción mensual `JET-ID` `9 meses`, modal de reembolso `Refund` exclusivo al medio de pago original con advertencia PSD2, cartera de entradas QR, validación en vivo DNI/NIE, descarga autónoma de Certificado Ley 49 / Justificante Nominativo excluyendo `TOPUP` y `TICKET`, chat bidireccional `#FAM-XXXX` y botón de Derecho al Olvido RGPD) + Vista `❓ FAQ y Soporte` (`L482–525`) con enrutamiento inteligente + Test Playwright `tests/e2e/mi-hucha-faq.spec.ts`.
  - **Skills:** `korum-nextjs-multitenant-ui`, `korum-escrow-payments`, `korum-quorum-antifraud`, `korum-qa-harness-gatekeeper`.
  - **Builder / Auditores:** `korum-family-viral-builder` ➔ `fintech-escrow-auditor` + `antifraud-legal-guardian` + `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-F06`, `QA-F08`, `QA-REG03`.

---

## FASE 4: Entorno 2 — Panel Mancomunado Colegio / AFA / Club y Modo Portería QR (5 Micro-Sprints)

- [ ] **SPRINT 4.1 — Cabecera Gestora, Kit Oficial de Medallas (`Bronce/Plata/Oro`), Exportador Modelo 182 AEAT y Cuadro de Mandos (6 Estados):**
  - **Alcance (`~850 LOC`):** Layout `/school/[orgSlug]` (`L529–623`, `L1627–1665`, `L3357–3483`): cabecera mancomunada, las 3 tarjetas de medallas con modal de Kit Oficial (Informe PDF + Sello + Post Redes copiable), botón de descarga 1-clic del fichero `.BOE` del **Modelo 182 AEAT** (para centros `ley49`), filtros ocultos por defecto tras botón y línea gráfica de 6 estados con ID Escrow `WLT-ESC-XXX` + Test Playwright `tests/e2e/school-dashboard-medals.spec.ts`.
  - **Skills:** `korum-nextjs-multitenant-ui`, `korum-quorum-antifraud`, `korum-qa-harness-gatekeeper`.
  - **Builder / Auditores:** `korum-backoffice-bi-builder` ➔ `antifraud-legal-guardian` + `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-S02` (Modelo 182), `QA-S05`.

- [ ] **SPRINT 4.2 — Gestor de Aprobaciones, Doble Firma Criptográfica (`1/2 → 2/2`), Moderación de Comercios (`CREDIT_POOL`) y KYB Paycomet:**
  - **Alcance (`~950 LOC`):** Subvista `#sch-sub-moderation` (`L624–740`, `L3484–3658`, `L4973–5039`): moderación Fase 0, auditoría desplegable de firmas (`🟢 Verificadas` vs `⚠️ Sospechosas`), chat privado con `#FAM-XXXX`, flujo criptográfico real de **Doble Firma Mancomunada** (`ROLE_DIRECTOR` + `ROLE_AFA_PRESIDENT`) con enlace OTP 1-clic, moderación/renovación de comercios con bolsa `CREDIT_POOL`, alta KYB Paycomet y personalización de marca/reglas del centro + Test Playwright `tests/e2e/school-moderation-doublecheck.spec.ts`.
  - **Skills:** `korum-nextjs-multitenant-ui`, `korum-quorum-antifraud`, `korum-escrow-payments`, `korum-qa-harness-gatekeeper`.
  - **Builder / Auditores:** `korum-backoffice-bi-builder` ➔ `fintech-escrow-auditor` + `antifraud-legal-guardian` + `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-S02` (Doble Firma & KYB).

- [ ] **SPRINT 4.3 — Estudio de Edición Dual (100% Independencia Proveedor vs. Taquilla/Rifa), Pizarra TCO al Céntimo y Cartel Oficial A4 + QR:**
  - **Alcance (`~950 LOC`):** Subvista `#sch-sub-studio` + `#poster-modal` (`L741–984`, `L1697–1743`, `L3659–3944`, `L4061–4082`): editor dual `BUDGET` (soberanía 100% de proveedor local) y `TICKETING` (`EVENT`/`RAFFLE` con aviso normativo DGOJ), candado semántico `\b` en vivo sin falsos positivos, toggles independientes de Placa y Reto Colectivo, Pizarra TCO de 5 líneas cuadrada al céntimo (`"0,00 €"` limpio cuando mantenimiento es `0`) y modal imprimible de **Cartel Oficial A4 con QR real** + Test Playwright `tests/e2e/school-studio-poster.spec.ts`.
  - **Skills:** `korum-nextjs-multitenant-ui`, `korum-tco-calculator`, `korum-quorum-antifraud`, `korum-ticketing-qr`, `korum-qa-harness-gatekeeper`.
  - **Builder / Auditores:** `korum-backoffice-bi-builder` ➔ `fintech-escrow-auditor` + `antifraud-legal-guardian` + `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-S01`.

- [ ] **SPRINT 4.4 — Módulo de Logros, Liquidación Escrow Mancomunada (Factura Proveedor + Fotos Antes/Después) y Redimensionamiento / Reembolso 100%:**
  - **Alcance (`~850 LOC`):** Subvistas `#sch-sub-escrow` y `#sch-sub-support` (`L985–1066`, `L3945–4059`, `L4960–4972`): cierre al 100% con **Doble Firma Mancomunada** (`1/2 → 2/2`), selector de pago directo a IBAN de proveedor local (exigiendo factura PDF adjunta) o cuenta del centro, subida de fotos Antes/Después, encuesta vinculante de redimensionamiento para donantes, reembolso automático 100% + reasignación de comercios (`CREDIT_POOL`) y buzón prioritario Centro ➔ Super-Admin + Test Playwright `tests/e2e/school-escrow-payout.spec.ts`.
  - **Skills:** `korum-nextjs-multitenant-ui`, `korum-escrow-payments`, `korum-quorum-antifraud`, `korum-qa-harness-gatekeeper`.
  - **Builder / Auditores:** `korum-backoffice-bi-builder` ➔ `fintech-escrow-auditor` + `antifraud-legal-guardian` + `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-S03`.

- [ ] **SPRINT 4.5 — "Modo Portería QR" Móvil (`/school/[orgSlug]/porteria`) y Sorteador Público Certificado de Rifas:**
  - **Alcance (`~800 LOC`):** Vista móvil dedicada `/school/[orgSlug]/porteria` accesible por PIN temporal sin instalar app: escáner de cámara + validación criptográfica `HMAC-SHA256` en `< 0,5s`, check-in parcial familiar (`Entran X de Y`), bloqueo sonoro/visual en rojo ante fotocopias ya validadas, contador de aforo en puerta en tiempo real y pantalla proyectable de **Sorteo Aleatorio Certificado (`CSPRNG`)** para rifas numeradas + Test Playwright `tests/e2e/school-porteria-raffle.spec.ts`.
  - **Skills:** `korum-ticketing-qr`, `korum-nextjs-multitenant-ui`, `korum-qa-harness-gatekeeper`.
  - **Builder / Auditores:** `korum-backoffice-bi-builder` ➔ `antifraud-legal-guardian` + `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-S04`, `QA-F06`.

---

## FASE 5: Entorno 3 — Consola Ejecutiva Super-Admin KORUM y Certificación E2E Final (4 Micro-Sprints)

- [ ] **SPRINT 5.1 — Cuadro de Mandos BI (Devengado Real vs. Proyectado), Gráfico de 6 Fuentes, Tablas Ordenables (`↕`) y Alertas (`💎` / `🚨`):**
  - **Alcance (`~900 LOC`):** Vista `/admin` `#sa-sub-bi` (`L1070–1232`, `L4083–4561`): KPIs globales separando **Devengado Real (Ledger)** de **Previsión Proyectada al 100%**, Gráfico cuadrado de las 6 Fuentes de Ingresos (cero constantes ficticias), Tabla de Centros (`Cerradas Año/Hist.`, `Comercios Act./Hist.`), Top 10 y Listado Global con `💛 Aportaciones`, ordenación clicable (`↕`) en todas las columnas y alertas `💎 Auto-Impulso Rentable` y `🚨 Peligro Retorno Negativo` + Test Playwright `tests/e2e/superadmin-bi.spec.ts`.
  - **Skills:** `korum-tco-calculator`, `korum-nextjs-multitenant-ui`, `korum-qa-harness-gatekeeper`.
  - **Builder / Auditores:** `korum-backoffice-bi-builder` ➔ `fintech-escrow-auditor` + `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-A01`, `QA-A02`.

- [ ] **SPRINT 5.2 — Pop-up Ejecutivo de Iniciativa (Acción 1-Clic) y Ficha 360º Ampliada del Centro con Facturas Veri\*factu:**
  - **Alcance (`~900 LOC`):** `#sa-init-popup-modal` (`L1567–1579`, `L4270–4340`: link público, comercios participantes, ejecución de **Auto-Impulso Rentable** con asiento Ledger y corrección 1-clic de tarifa con retorno negativo) y `#sa-sub-crm` Ficha 360º (`L1233–1243`, `L4562–4831`: tarifas individuales, categorías propias y overrides, listado descargable de facturas **Veri\*factu**, gráfico de 6 fuentes del centro y tabla ordenable `↕` de sus iniciativas) + Test Playwright `tests/e2e/superadmin-crm360.spec.ts`.
  - **Skills:** `korum-tco-calculator`, `korum-escrow-payments`, `korum-nextjs-multitenant-ui`, `korum-qa-harness-gatekeeper`.
  - **Builder / Auditores:** `korum-backoffice-bi-builder` ➔ `fintech-escrow-auditor` + `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-A02`, `QA-A03`.

- [ ] **SPRINT 5.3 — Motor de Reglas Globales, Validador Bruto de Gestión Digital, Tope Anual de Mantenimiento, Medallas y Bandeja Central de Tickets:**
  - **Alcance (`~850 LOC`):** `#sa-sub-rules` y `#sa-sub-tickets` (`L1244–1386`, `L4832–4959`): persistencia real en BD de tramos globales, gestor de categorías globales, costes Paycomet, validador en vivo de *Gastos de gestión digital* sobre cobro bruto (`precio + gestión`), mantenimiento con tope anual auto-desactivable, gamificación de medallas (`Bronce`, `Plata`, `Oro`) y bandeja centralizada de soporte + Test Playwright `tests/e2e/superadmin-rules-tickets.spec.ts`.
  - **Skills:** `korum-tco-calculator`, `korum-nextjs-multitenant-ui`, `korum-qa-harness-gatekeeper`.
  - **Builder / Auditores:** `korum-backoffice-bi-builder` ➔ `fintech-escrow-auditor` + `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-A03`, `QA-A04`.

- [ ] **SPRINT 5.4 — Certificación Maestra End-to-End Multi-Entorno, Auditoría de Penetración Multi-Tenant y Build de Producción (`100%` QA):**
  - **Alcance (`~750 LOC`):** Suite transversal `tests/e2e/full-lifecycle-journey.spec.ts` recorriendo en `1440x900` y `430x932` el viaje completo sin cortes (*Alta Centro ➔ Idea Familiar ➔ Quórum Padre/Madre ➔ Doble Firma Colegio ➔ Estudio TCO ➔ Donación + Comercio Veri\*factu + Taquilla QR ➔ Escaneo Portería + Sorteo Rifa ➔ Auto-Impulso Super-Admin ➔ Liquidación con Factura Proveedor + Antes/Después ➔ Exportación Modelo 182 `.BOE`*), `npm run build` de producción con `0` errores y firma colegiada de los 4 subagentes del **War Room**.
  - **Skills:** Todas las 6 skills activas.
  - **Builder / Auditores:** Orquestador Principal ➔ **Pleno del War Room** (`fintech-escrow-auditor` + `antifraud-legal-guardian` + `ux-school-director-reviewer` + `qa-e2e-verifier`).
  - **Gate QA:** `100%` Matriz Global (`QA-C`, `QA-FIN`, `QA-P`, `QA-SEC`, `QA-REG`, `QA-M`, `QA-F`, `QA-S`, `QA-A`).
