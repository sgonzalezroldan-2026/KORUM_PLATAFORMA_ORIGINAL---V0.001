# Plan de implementación por sprints · KORUM v8.5

> **Cómo se ejecuta cada sprint** (detalle en la [Regla 04](../.agents/rules/04-ejecucion-sin-recortes.md)):
>
> 1. **Antes de empezar**, el asistente lee [BITACORA_SPRINTS.md](BITACORA_SPRINTS.md) y **te dice qué modelo de IA y qué nivel de esfuerzo recomienda la línea `🤖` del sprint**. Si la sesión usa otro, te pregunta antes de seguir.
> 2. **Un sprint por entrega:** `4–8` archivos cohesivos y `~600–1.050` líneas de producción + tests.
> 3. **Cierre con las 5 puertas** y dictamen de los auditores indicados. Después se actualiza la bitácora y se indica el siguiente sprint.
>
> **Cómo leer la línea `🤖`:** *constructor* es el modelo que escribe el código del sprint; *auditoría* es el modelo de los subagentes del *War Room* (en Claude Code ya viene fijado en `.claude/agents/`). Los niveles de esfuerzo son los de cada herramienta (Claude: medio, alto, extra alto, máx.; Gemini: medio, alto). El criterio general está en [GUIA_IA_CLAUDE_Y_GEMINI.md](GUIA_IA_CLAUDE_Y_GEMINI.md) §3: **Opus** para dinero, seguridad y decisiones irreversibles; **Sonnet** para interfaz y piezas bien especificadas; **Gemini** como alternativa o para revisión cruzada, traducciones e imágenes. El esfuerzo **máx.** se reserva para desatascar un fallo que ha resistido dos vueltas del bucle de corrección.
>
> **Dependencias externas:** la línea `⛓️` indica qué se necesita fuera del código (credenciales, respuestas de Paycomet o del abogado). Si falta, el sprint se puede construir contra el simulador, pero no pasa a producción.

---

## Tareas externas aplazadas (decisión del promotor, 29-10-2026)

El promotor ha decidido **dejar para más adelante, hasta ver el resultado del proyecto**, las gestiones que dependen de terceros. No bloquean la construcción: todo se desarrolla contra el simulador y con textos marcados como borrador. **Sí bloquean el cobro de dinero real**: ninguna de estas tareas está hecha cuando termine el Sprint 5.6, y el Sprint 6.1 no puede empezar sin ellas.

| Tarea | Qué incluye | Qué se hace mientras tanto | Dónde bloquea |
| :--- | :--- | :--- | :--- |
| **Respuestas escritas de Paycomet** | Las 8 preguntas de [CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md](CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md) §2 (pago directo a IBAN de terceros, plazos y coste de devolución, contracargos, ventana de 90 días, redacción de «entidad de pago»…) y contrato en producción | Simulador `mock` con las suposiciones documentadas; el sandbox se usa cuando haya credenciales | Sprint 4.4 (pago al IBAN del proveedor), 6.1 y 6.2 |
| **Revisión del abogado** | Lista «Abogado» de [§9](CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md): textos legales, reparto de responsabilidades, antifraude frente a la LSSI, EIPD, textos del checkout y de rifas | Textos legales en `BORRADOR` y versionados desde la consola; sin cobros reales | Sprint 6.1 y 6.2 |
| **Revisión de la asesoría fiscal** | Lista «Asesoría fiscal» de [§9](CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md): IVA de los fees, colegios con ánimo de lucro, Modelo 182 y justificante | Documentos fiscales con la leyenda de borrador; Modelo 182 generado pero sin presentar | Sprint 6.1 y 6.2 |
| **Proveedor de facturación Veri\*factu** | Elegir proveedor homologado ([DECISIONES_TECNICAS.md](DECISIONES_TECNICAS.md) §4) | Adaptador `InvoicingProvider` simulado | Sprint 6.1 (la obligatoriedad real llega en 2027) |
| **Activar `REGULATED_WALLET` de Mi Hucha** | Confirmación escrita de un proveedor de monederos y revisión legal | La Hucha funciona en modo `PLEDGE` | Solo si se quiere activar ese modo |

Reglas mientras estén aplazadas: (1) **no se publica el sitio con cobros reales**; (2) el simulador se identifica como tal en pantalla (`PAYCOMET_MODE=mock`); (3) cada vez que un sprint toque una de estas áreas, la bitácora recoge qué suposición se ha usado, para revisarla el día que lleguen las respuestas; (4) el asistente recuerda esta lista al cerrar el Sprint 5.6 y al abrir el 6.1.

---

## FASE 0 · Prototipo, especificación y preparación de la documentación

- [x] **SPRINT 0.0 — Prototipo funcional (`prototype/Korum_v8.html`):** los 3 entornos con todos sus flujos. Congelado como referencia funcional.
- [x] **SPRINT 0.5 — Especificación v8.5:** esquema Prisma en céntimos enteros, contratos de tipos y semilla contable de 8 iniciativas cuadrada al céntimo.
- [x] **SPRINT 0.6 — Plan, matriz QA de 5 puertas y ecosistema de skills y subagentes.**
- [x] **SPRINT 0.7 — Revisión documental para Claude y Gemini:** marca unificada, esquema corregido (doble partida real, archivado en lugar de borrado, estados cerrados, cifrado, autenticación, auditoría, webhooks, notificaciones, ficheros, privacidad), decisiones técnicas y legales, experiencia de producto, SEO, idiomas, modelo de IA por sprint, configuración de Claude Code generada desde `.agents/` y repositorio git.

---

## FASE 1 · Cimientos: proyecto, arnés QA, persistencia y motor matemático

- [x] **SPRINT 1.1 — Proyecto Next.js + Tailwind 4 + idiomas + primitivas de marca + arnés QA:**
  - 🤖 **IA recomendada:** constructor **Claude Sonnet 5.5 · esfuerzo alto** (alternativa: Gemini Argon · alto) · auditoría **Claude Sonnet 5.5 · alto**.
  - **Marca:** `KorumMark` y `KorumLogo` se dibujan como SVG a partir de la lámina de referencia `public/brand/korum-logo.jpg` (parche redondo con la K colegial, laureles y cinta), **sin año ni subtítulo** para que sirvan a colegios, clubes y entidades culturales. Los SVG antiguos están descartados en `public/brand/_old/fase2_propuestas_descartadas/`.
  - **Alcance (`~750 LOC`):** `package.json` con versiones exactas verificadas (`npm view`), `tsconfig.json` (`strict`, `noUncheckedIndexedAccess`), `next.config.ts`, `prisma.config.ts` (esquema en `schema/schema.prisma`, cliente en `src/generated/prisma`), `src/app/globals.css` con `@theme` de Tailwind 4 (tokens de marca, tipografías, `.korum-paper-dots`, `.korum-court-grid`, `.korum-notebook-sheet`, `.die-cut-sticker`, `.tactile-btn`, `.korum-trust-vault`, `.mobile-stack`), `next-intl` con `es`/`ca`/`en` y catálogos base, `docker-compose.yml` (PostgreSQL 16), `src/config/env.ts` (Zod, fail-fast), `.env.example` actualizado, ESLint, `vitest.config.ts`, `playwright.config.ts` (proyectos `desktop` 1440×900 y `mobile` 430×932, con `@axe-core/playwright`), scripts `npm run verify:invariants | typecheck | lint | test:unit | test:e2e`, flujo de CI (`.github/workflows/ci.yml`) y primitivas (`KorumLogo`, `TrustBadge`, `CurrencyText`, `DelayedTooltip` de 1000 ms, `ToastProvider`, `SortableTh`, `StatusBadge`, `LanguageSwitcher`, `EmptyState`, `Skeleton`). Añadir el servidor MCP de Prisma a `.mcp.json` cuando Prisma esté instalado.
  - **Skills:** `korum-brand-design-system`, `korum-nextjs-multitenant-ui`, `korum-qa-harness-gatekeeper`.
  - **Constructor / auditores:** orquestador + `korum-brand-visual-director` ➔ `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-C01`, `QA-C02`, `QA-C05`.

- [x] **SPRINT 1.2 — Cliente Prisma, utilidades monetarias y libro mayor de doble partida:**
  - 🤖 **IA recomendada:** constructor **Claude Opus 5.5 · esfuerzo extra alto** (alternativa: Gemini Argon · alto) · auditoría **Claude Opus 5.5 · alto**.
  - **Alcance (`~750 LOC`):** primera migración con triggers de inmutabilidad (`LedgerJournal`, `EscrowLedgerEntry`, `AuditLog`) y `CHECK (amountCents > 0)`; `src/lib/prisma.ts` (adaptador `@prisma/adapter-pg` + extensión que bloquea `update`/`delete` en tablas inmutables); `src/core/finance/money.ts` (`formatCents` y `assertSafeCents` ya existen desde el Sprint 1.1; se añaden `parseEurosToCents` —llamada antes `eurosToCents` en esta ficha— y `bpsOf`); `src/core/finance/ledger.service.ts` (`postJournal` con `Σ DEBIT === Σ CREDIT`, idempotencia, contra-asientos, saldos por cuenta y dimensión), `ledger-accounts.ts` y `ledger-validation.ts` (plan de cuentas, dimensiones obligatorias, validación pura), `quota-reservation.ts` (reserva y liberación de cupos) + `tests/unit/ledger-validation.spec.ts` y `tests/integration/{ledger,quota-reservation}.spec.ts` contra PostgreSQL real (esquema aislado `korum_test`).
  - **Skills:** `korum-tco-calculator`, `korum-escrow-payments`, `korum-qa-harness-gatekeeper`.
  - **Constructor / auditores:** `korum-core-fintech-architect` ➔ `fintech-escrow-auditor` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-C03`, `QA-FIN01`.

- [ ] **SPRINT 1.3 — Semilla completa y repositorios con aislamiento entre entidades:**
  - 🤖 **IA recomendada:** constructor **Claude Sonnet 5.5 · esfuerzo alto** (alternativa: Gemini Argon · alto) · auditoría **Claude Opus 5.5 · alto**.
  - **Alcance (`~850 LOC`):** `prisma/seed.ts` que vuelca `src/mocks/seed_data.json` (reglas, medallas, 4 entidades con su titular legal y sus 2 firmantes, 8 iniciativas, 5 comercios, 3 ideas con auditoría y chat, pases QR, facturas y tickets), generando los asientos de cada cobro y verificando al final que los saldos del libro mayor cuadran con `raisedCents`; `src/repositories/*` con guardias obligatorias por `organizationId` y registro de accesos denegados + `tests/unit/seed-and-tenant.spec.ts`.
  - **Skills:** `korum-nextjs-multitenant-ui`, `korum-tco-calculator`, `korum-qa-harness-gatekeeper`.
  - **Constructor / auditores:** `korum-core-fintech-architect` ➔ `fintech-escrow-auditor` + `antifraud-legal-guardian` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-C04`, `QA-SEC01`.

- [ ] **SPRINT 1.4 — Motor TCO dual, tope anual de mantenimiento y BI real frente a proyectado (fuzzing 1.000x):**
  - 🤖 **IA recomendada:** constructor **Claude Opus 5.5 · esfuerzo alto** (alternativa: Gemini Argon · alto) · auditoría **Claude Opus 5.5 · alto**.
  - **Alcance (`~950 LOC`):** `src/core/finance/tco.service.ts`, `pricing-health.ts` y `bi-analytics.service.ts`: `calculateBracketFeeCents` (modos `FLAT` y `MARGINAL`, umbrales configurables), `calculateStudioBudgetTCO`, `calculateStudioTicketingTCO`, `calculatePublicBreakdown4Lines`, `evaluateMaintenanceCapShutoff`, `calculateRevenueBreakdown6Sources` (real frente a proyectado, con tasa de activación real de la aportación voluntaria), detectores 💎 / 🚨 y **`evaluatePricingHealth`** (avisos al Super-Admin cuando una regla pierde dinero o es incoherente; [skill TCO §2.1](../.agents/skills/korum-tco-calculator/SKILL.md)) + `tests/unit/tco-bi-fuzz.spec.ts` (1.000 iteraciones deterministas en los dos modos de tramos) y `tests/unit/pricing-health.spec.ts`.
  - **Skills:** `korum-tco-calculator`, `korum-qa-harness-gatekeeper`.
  - **Constructor / auditores:** `korum-core-fintech-architect` ➔ `fintech-escrow-auditor` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-FIN02`, `QA-FIN03`, `QA-FIN04`, `QA-FIN05`, `QA-FIN06`.

---

## FASE 2 · Motores de backend: pagos, seguridad, QR, fiscalidad, operación y privacidad

- [ ] **SPRINT 2.1 — Adaptador Paycomet, webhooks idempotentes, split transfer y reembolsos al origen:**
  - 🤖 **IA recomendada:** constructor **Claude Opus 5.5 · esfuerzo extra alto** (alternativa: Gemini Argon · alto) · auditoría **Claude Opus 5.5 · alto** + revisión cruzada opcional con **Gemini Argon · alto**.
  - ⛓️ **Depende de (aplazado, ver «Tareas externas aplazadas»):** credenciales de sandbox de Paycomet y respuestas a la lista de [CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md](CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md) §2 (pago a IBAN de terceros, coste y plazos de devolución, contracargos). Se construye contra el simulador y se anotan en la bitácora las suposiciones usadas.
  - **Alcance (`~950 LOC`):** `src/services/payments/` (interfaz `PaymentProvider`, adaptador Paycomet con modos `mock`/`sandbox`/`live`, simulador determinista con firmas reales), cobros Bizum/tarjeta en céntimos, tokenización `JET-ID` cifrada, cuentas destino (`paycometSplitId`), `split transfer` con control de la ventana de 90 días, reembolso al origen, contracargos, `/api/webhooks/paycomet/route.ts` con `WebhookEvent` y asientos en la misma transacción + `tests/unit/paycomet-escrow.spec.ts`.
  - **Skills:** `korum-escrow-payments`, `korum-qa-harness-gatekeeper`.
  - **Constructor / auditores:** `korum-core-fintech-architect` ➔ `fintech-escrow-auditor` + `antifraud-legal-guardian` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-P01`, `QA-P02`, `QA-P04`.

- [ ] **SPRINT 2.2 — Antifraude del quórum, doble firma y candado semántico:**
  - 🤖 **IA recomendada:** constructor **Claude Opus 5.5 · esfuerzo alto** (alternativa: Gemini Argon · alto) · auditoría **Claude Opus 5.5 · alto**.
  - **Alcance (`~850 LOC`):** `src/core/security/`: `email-normalizer.ts` (email canónico y dominios desechables), `device-quorum.service.ts` (cookie de dispositivo, subred IP como HMAC, huella solo con consentimiento, regla de 2 cuentas), `double-check.service.ts` (`DIRECTOR` + `COSIGNER`, `signatureHash`, enlace de un solo uso + OTP) y `semantic-lock.ts` (límites de palabra en es/ca/en con lista blanca cultural) + `tests/unit/security-quorum.spec.ts`.
  - **Skills:** `korum-quorum-antifraud`, `korum-qa-harness-gatekeeper`.
  - **Constructor / auditores:** `korum-security-gov-engineer` ➔ `antifraud-legal-guardian` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-SEC02`, `QA-SEC03`, `QA-SEC04`.

- [ ] **SPRINT 2.3 — Taquilla QR, PIN de portería por evento, sorteo certificado y fiscalidad (Modelo 182 + Veri\*factu):**
  - 🤖 **IA recomendada:** constructor **Claude Opus 5.5 · esfuerzo alto** (alternativa: Gemini Argon · alto) · auditoría **Claude Opus 5.5 · alto**.
  - ⛓️ **Depende de:** elección del proveedor de facturación Veri\*factu ([DECISIONES_TECNICAS.md](DECISIONES_TECNICAS.md) §4). Sin él, el adaptador funciona en modo simulado.
  - **Alcance (`~950 LOC`):** `src/core/ticketing/` (reserva atómica de aforo, numeración de rifas, firma y verificación HMAC en tiempo constante, check-in parcial con `TicketCheckIn`, PIN por evento con hash lento, límite de intentos y `GateSession`, sorteo con `crypto.randomInt` y acta con huella) y `src/core/tax/` (validación NIF/NIE/CIF, certificado o justificante, fichero del Modelo 182 con recurrencia por `donorTaxIdHmac`, interfaz `InvoicingProvider` para Veri\*factu) + `tests/unit/ticketing-tax.spec.ts`.
  - **Skills:** `korum-ticketing-qr`, `korum-quorum-antifraud`, `korum-escrow-payments`, `korum-qa-harness-gatekeeper`.
  - **Constructor / auditores:** `korum-security-gov-engineer` ➔ `fintech-escrow-auditor` + `antifraud-legal-guardian` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-P03`, `QA-REG01`, `QA-REG02`, `QA-REG03`, `QA-SEC06`.

- [ ] **SPRINT 2.4 — Operación: tareas programadas, conciliación, ficheros, observabilidad y límites de intentos:**
  - 🤖 **IA recomendada:** constructor **Claude Sonnet 5.5 · esfuerzo alto** (alternativa: Gemini Argon · alto) · auditoría **Claude Opus 5.5 · alto**.
  - **Alcance (`~850 LOC`):** `src/app/api/cron/[job]/route.ts` protegido con `CRON_SECRET` y procesador de `Job` (bloqueo, lotes, reintentos con espera creciente) con los tipos `CAMPAIGN_EXPIRY`, `MASS_REFUND`, `MONTHLY_TOPUP`, `SPONSOR_RENEWAL_NOTICE`, `SPONSOR_RENEWAL_CHARGE`, `CREDIT_POOL_EXPIRY`, `SPLIT_WINDOW_GUARD`, `PSP_RECONCILIATION`, `MODEL182_REMINDER` y la **renovación anual de cupos** de cada entidad (nuevo `Organization.quotaPeriod`, exento y beca de medalla del curso nuevo, `maintPaidCents` a 0; las reservas del curso anterior ya no abonan al nuevo); `src/services/storage/` (Supabase Storage: cubos público y privado, URL firmadas, `FileAsset` con hash y tipo verificado); `src/lib/rate-limit.ts` sobre `RateLimit`; Sentry con limpieza de datos personales + `tests/unit/jobs-storage.spec.ts`.
  - **Skills:** `korum-escrow-payments`, `korum-qa-harness-gatekeeper`.
  - **Constructor / auditores:** `korum-core-fintech-architect` ➔ `fintech-escrow-auditor` + `antifraud-legal-guardian` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-OPS01`, `QA-OPS02`.

- [ ] **SPRINT 2.5 — Ajustes cifrados de la plataforma, registro de auditoría y privacidad RGPD:**
  - 🤖 **IA recomendada:** constructor **Claude Opus 5.5 · esfuerzo alto** (alternativa: Gemini Argon · alto) · auditoría **Claude Opus 5.5 · alto**.
  - **Alcance (`~800 LOC`):** `src/core/security/crypto.ts` (AES-256-GCM con versión de clave y rotación; HMAC de datos personales), `src/services/settings/` (lectura tipada de `PlatformSetting` y `PlatformSecret` con caché, prioridad sobre las variables de respaldo y validación Zod por clave), `src/services/audit/` (escritura de `AuditLog` sin datos sensibles), `src/core/privacy/` (consentimientos, solicitudes de acceso, exportación y supresión con anonimización que conserva lo contable, `DATA_RETENTION_PURGE` con los plazos legales) + `tests/unit/settings-privacy.spec.ts`.
  - **Skills:** `korum-quorum-antifraud`, `korum-qa-harness-gatekeeper`.
  - **Constructor / auditores:** `korum-security-gov-engineer` ➔ `antifraud-legal-guardian` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-SEC07`, `QA-PRIV01`, `QA-PRIV02`.

- [ ] **SPRINT 2.6 — Notificaciones: bandeja de salida y emails transaccionales en 3 idiomas:**
  - 🤖 **IA recomendada:** constructor **Claude Sonnet 5.5 · esfuerzo alto** (alternativa: Gemini Argon · alto); textos en catalán e inglés revisados con **Gemini Argon · alto** · auditoría **Claude Sonnet 5.5 · alto**.
  - ⛓️ **Depende de:** cuenta del proveedor de email y dominio con SPF, DKIM y DMARC (se puede construir con el modo de vista previa local).
  - **Alcance (`~900 LOC`):** `src/services/email/` (interfaz `EmailProvider`, adaptador del proveedor elegido, modo vista previa en desarrollo), procesador de `OutboxMessage` con reintentos, plantillas con React Email para el catálogo de [EXPERIENCIA_DE_PRODUCTO.md](EXPERIENCIA_DE_PRODUCTO.md) §4 (recibo, entrada QR, logro conseguido, reembolso, firma pendiente, preaviso de renovación, certificado fiscal, acceso) en `es`/`ca`/`en`, con versión de texto plano + `tests/unit/email-outbox.spec.ts`.
  - **Imágenes:** cabecera y pie de los emails en SVG/PNG generados por código (Claude o Gemini).
  - **Skills:** `korum-brand-design-system`, `korum-nextjs-multitenant-ui`, `korum-qa-harness-gatekeeper`.
  - **Constructor / auditores:** `korum-family-viral-builder` + `korum-community-target-psychologist` (textos) ➔ `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-NOT01`, `QA-NOT02`.

---

## FASE 3 · Entorno 0 (marketing y acceso) y Entorno 1 (familias, comercios y viralidad)

- [ ] **SPRINT 3.1 — Landing, páginas pilar, calculadora de impacto y base SEO:**
  - 🤖 **IA recomendada:** constructor **Claude Sonnet 5.5 · esfuerzo alto** (alternativa: Gemini Argon · alto); textos de marketing en catalán e inglés con **Gemini Argon · alto** · auditoría **Claude Sonnet 5.5 · alto**.
  - **Alcance (`~950 LOC`):** `src/app/[locale]/(marketing)/` (portada con buscador de entidades y simulador, `para-colegios`, `para-clubes`, `para-entidades-culturales`, `para-comercios`, `como-funciona`, `precios`, `seguridad-y-transparencia`, `preguntas-frecuentes`), `robots.ts`, `sitemap.ts`, `llms.txt`, metadatos y JSON-LD por página, selector de idioma y aviso de cookies (solo si se activan cookies no esenciales) + `tests/e2e/marketing-seo.spec.ts`.
  - **Imágenes:** fotografía o ilustración de ambiente para la portada y las páginas pilar → **modelo de imagen de Gemini** (reglas de [GUIA_IA_CLAUDE_Y_GEMINI.md](GUIA_IA_CLAUDE_Y_GEMINI.md) §5); iconos e ilustraciones planas → SVG con Claude o Gemini.
  - **Skills:** `korum-nextjs-multitenant-ui`, `korum-seo-discoverability`, `korum-brand-design-system`, `korum-tco-calculator`, `korum-qa-harness-gatekeeper`.
  - **Constructor / auditores:** `korum-family-viral-builder` + `korum-seo-discoverability-specialist` + `korum-community-target-psychologist` ➔ `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-M01`, `QA-SEO01`, `QA-SEO02`, `QA-F06`.

- [ ] **SPRINT 3.2 — Autenticación por rol, alta autónoma de entidades y control de acceso:**
  - 🤖 **IA recomendada:** constructor **Claude Opus 5.5 · esfuerzo alto** (alternativa: Gemini Argon · alto) · auditoría **Claude Opus 5.5 · alto**.
  - **Alcance (`~900 LOC`):** Better Auth (enlace mágico y OTP para familias y comercios; contraseña + 2FA para firmantes y Super-Admin; passkeys opcionales), `/login`, `/registro-comunidad` en 3 pasos (vertical, titular legal con forma jurídica y titularidad del centro, firmantes con su cargo, idioma del contenido e indexación pública, 1.000 € exentos y plantilla de grupos), invitación al cofirmante, middleware de roles (`/panel/[orgSlug]`, `/porteria`, `/admin`) y alta del primer Super-Admin. La barra de demostración del prototipo solo existe con `NEXT_PUBLIC_DEMO_MODE=true` + `tests/e2e/auth-rbac.spec.ts`.
  - **Skills:** `korum-nextjs-multitenant-ui`, `korum-quorum-antifraud`, `korum-qa-harness-gatekeeper`.
  - **Constructor / auditores:** `korum-security-gov-engineer` ➔ `antifraud-legal-guardian` + `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-M02`, `QA-SEC05`.

- [ ] **SPRINT 3.3 — Portal público de la entidad, ficha de iniciativa y tarjetas para WhatsApp:**
  - 🤖 **IA recomendada:** constructor **Claude Sonnet 5.5 · esfuerzo alto** (alternativa: Gemini Argon · alto) · auditoría **Claude Sonnet 5.5 · alto** + `fintech-escrow-auditor` en **Claude Opus 5.5 · alto**.
  - **Alcance (`~950 LOC`):** cabecera dinámica de la entidad (ancla `id="school-hero-header"`), píldora de Mi Hucha según su modo, barra de impacto, `🔍 Filtrar` oculto por defecto, grid de iniciativas `FUNDRAISING` con `💛 X aportaciones` e insignia *Matching 2x*, ficha (`function openInitiativeDetail`) con hucha de la iniciativa + fecha límite, 4 líneas = 100 % de la meta, reto por curso en positivo y placa, modal de compartir y `/api/og/initiative/[id]/route.tsx` (< 300 KB, URL versionada; usa `KorumMarkSvg variant="simple"`, el isotipo sin hooks del Sprint 1.1), metadatos y JSON-LD + `tests/e2e/family-catalog-detail.spec.ts`.
  - **Skills:** `korum-nextjs-multitenant-ui`, `korum-seo-discoverability`, `korum-tco-calculator`, `korum-qa-harness-gatekeeper`.
  - **Constructor / auditores:** `korum-family-viral-builder` + `korum-seo-discoverability-specialist` ➔ `fintech-escrow-auditor` + `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-F01`, `QA-F02`, `QA-F03`, `QA-F06`, `QA-SEO03`.

- [ ] **SPRINT 3.4 — Checkout en 10 segundos (donación y taquilla), email de invitado y pase QR:**
  - 🤖 **IA recomendada:** constructor **Claude Opus 5.5 · esfuerzo alto** (alternativa: Gemini Argon · alto) · auditoría **Claude Opus 5.5 · alto**.
  - **Alcance (`~950 LOC`):** checkout (anclas `id="checkout-modal"` y `function openCheckoutModal`) para donación y taquilla/rifa: email de invitado sin contraseña, selector de grupo según el vertical, **aportación voluntaria a KORUM con el check desmarcado** y texto según `ley49` verificada, selector manual desde 0 €, NIF opcional para el certificado, Bizum / tarjeta (y Hucha solo en `REGULATED_WALLET`), aforo atómico, *Gastos de gestión digital*, pantalla de celebración tras pagar y pase imprimible con QR firmado + `tests/e2e/family-checkout-tickets.spec.ts`.
  - **Skills:** `korum-nextjs-multitenant-ui`, `korum-escrow-payments`, `korum-ticketing-qr`, `korum-qa-harness-gatekeeper`.
  - **Constructor / auditores:** `korum-family-viral-builder` + `korum-community-target-psychologist` ➔ `fintech-escrow-auditor` + `antifraud-legal-guardian` + `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-F04`, `QA-F07`, `QA-F10`.

- [ ] **SPRINT 3.5 — Comercios amigos (ORO > PLATA > BRONCE) y patrocinio con factura Veri\*factu:**
  - 🤖 **IA recomendada:** constructor **Claude Sonnet 5.5 · esfuerzo alto** (alternativa: Gemini Argon · alto) · auditoría `fintech-escrow-auditor` en **Claude Opus 5.5 · alto**.
  - **Alcance (`~750 LOC`):** vista de comercios amigos (anclas `id="fview-comercios"` y `function renderFamilySponsors`) sin importes en público y con orden estricto, modal de ventaja o código para familias, pestaña de comercio del checkout (nivel, *Matching 2x* opcional, fee encima, datos fiscales, renovación anual con preaviso) y descarga del justificante y la factura + `tests/e2e/sponsors-verifactu.spec.ts`.
  - **Skills:** `korum-nextjs-multitenant-ui`, `korum-escrow-payments`, `korum-qa-harness-gatekeeper`.
  - **Constructor / auditores:** `korum-family-viral-builder` ➔ `fintech-escrow-auditor` + `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-F05`.

- [ ] **SPRINT 3.6 — Buzón de ideas con quórum auditado y galería Antes / Después:**
  - 🤖 **IA recomendada:** constructor **Claude Sonnet 5.5 · esfuerzo alto** (alternativa: Gemini Argon · alto) · auditoría `antifraud-legal-guardian` en **Claude Opus 5.5 · alto**.
  - **Alcance (`~800 LOC`):** buzón (anclas `id="fview-ideas"`, `function renderFamilyIdeas`, `function votePublicIdea`, `function submitAnonymousIdeaPhase0`): propuesta con alias `#FAM-XXXX`, firma en 1 clic con email verificado y regla padre/madre en servidor, aviso y consentimiento de la huella; logros (`id="fview-logros"`, `function renderFamilyAchievements`): comparador Antes/Después, agradecimiento y botón de compartir; subida de fotos con confirmación de que no aparecen menores identificables + `tests/e2e/ideas-achievements.spec.ts`.
  - **Skills:** `korum-nextjs-multitenant-ui`, `korum-quorum-antifraud`, `korum-qa-harness-gatekeeper`.
  - **Constructor / auditores:** `korum-family-viral-builder` + `korum-community-target-psychologist` ➔ `antifraud-legal-guardian` + `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-F09`.

- [ ] **SPRINT 3.7 — Mi Hucha (según su modo), Mi cuenta con derechos RGPD, entradas, FAQ y soporte:**
  - 🤖 **IA recomendada:** constructor **Claude Opus 5.5 · esfuerzo alto** (alternativa: Gemini Argon · alto) · auditoría **Claude Opus 5.5 · alto**.
  - ⛓️ **Depende de:** para `REGULATED_WALLET`, confirmación escrita del proveedor de monederos. Mientras tanto se entrega `PLEDGE`.
  - **Alcance (`~950 LOC`):** Mi Hucha (ancla `id="fview-mihucha"`): modo `PLEDGE` (aportación mensual programada a una entidad, pausa y cancelación en 1 clic) y modo `REGULATED_WALLET` (recarga puntual y mensual, retirada solo al medio de pago original con el aviso oficial); **Mi cuenta**: mis aportaciones, mis entradas QR, datos fiscales y certificados, consentimientos, exportar mis datos y suprimir mi cuenta; chat anónimo `#FAM-XXXX`; FAQ y soporte (`id="fview-faq"`) + `tests/e2e/mi-hucha-cuenta-faq.spec.ts`.
  - **Skills:** `korum-nextjs-multitenant-ui`, `korum-escrow-payments`, `korum-quorum-antifraud`, `korum-qa-harness-gatekeeper`.
  - **Constructor / auditores:** `korum-family-viral-builder` ➔ `fintech-escrow-auditor` + `antifraud-legal-guardian` + `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-F06`, `QA-F08`, `QA-REG03`, `QA-PRIV01`.

---

## FASE 4 · Entorno 2: panel mancomunado de la entidad y modo portería

- [ ] **SPRINT 4.1 — Cabecera de gestión, kit de medallas, exportación del Modelo 182 y cuadro de mandos:**
  - 🤖 **IA recomendada:** constructor **Claude Sonnet 5.5 · esfuerzo alto** (alternativa: Gemini Argon · alto) · auditoría `antifraud-legal-guardian` en **Claude Opus 5.5 · alto**.
  - **Alcance (`~850 LOC`):** layout `/panel/[orgSlug]` (anclas `id="env-school"`, `id="sch-sub-dashboard"`, `function renderSchoolDashboard`, `function renderSchoolMedalsExplainer`): cabecera con los dos firmantes y su cargo, estado KYB, cupos, kit de medallas (informe, sello y texto para redes), descarga del Modelo 182 solo con Ley 49/2002 verificada, filtros ocultos, línea de 6 estados con `WLT-ESC-XXX` y estado vacío guiado para la primera campaña + `tests/e2e/panel-dashboard-medals.spec.ts`.
  - **Skills:** `korum-nextjs-multitenant-ui`, `korum-quorum-antifraud`, `korum-qa-harness-gatekeeper`.
  - **Constructor / auditores:** `korum-backoffice-bi-builder` ➔ `antifraud-legal-guardian` + `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-S02`, `QA-S05`.

- [ ] **SPRINT 4.2 — Aprobaciones, doble firma (`1/2 → 2/2`), moderación de comercios, KYB y ajustes de la entidad:**
  - 🤖 **IA recomendada:** constructor **Claude Opus 5.5 · esfuerzo alto** (alternativa: Gemini Argon · alto) · auditoría **Claude Opus 5.5 · alto**.
  - **Alcance (`~950 LOC`):** moderación (anclas `id="sch-sub-moderation"`, `function renderSchoolModeration`, `function approvePhase0ToPublic`, `function approveDoubleCheckToBudget`, `function moderateSponsor`): Fase 0, auditoría de firmas, chat con `#FAM-XXXX`, **doble firma** `DIRECTOR` + `COSIGNER` con enlace de un solo uso y OTP, moderación y renovación de comercios con `CREDIT_POOL`, alta KYB con subida privada de documentos, botones de donación, grupos, marca, idioma del contenido e indexación + `tests/e2e/panel-moderation-doublecheck.spec.ts`.
  - **Skills:** `korum-nextjs-multitenant-ui`, `korum-quorum-antifraud`, `korum-escrow-payments`, `korum-qa-harness-gatekeeper`.
  - **Constructor / auditores:** `korum-backoffice-bi-builder` ➔ `fintech-escrow-auditor` + `antifraud-legal-guardian` + `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-S02`.

- [ ] **SPRINT 4.3 — Estudio dual, pizarra TCO al céntimo, plantillas de campaña y cartel A4 con QR:**
  - 🤖 **IA recomendada:** constructor **Claude Sonnet 5.5 · esfuerzo alto** (alternativa: Gemini Argon · alto) · auditoría `fintech-escrow-auditor` en **Claude Opus 5.5 · alto**.
  - **Alcance (`~950 LOC`):** Estudio (anclas `id="sch-sub-studio"`, `function loadInitiativeIntoStudio`, `function recalcStudioTCO`, `function saveInitiativeFromStudio`) y cartel (`id="poster-modal"`, `function updatePosterPreview`): modos `BUDGET` y `TICKETING` (`EVENT`/`RAFFLE` con aviso y confirmación de normativa), **plantillas de campaña listas para usar**, candado semántico en vivo, placa y reto independientes, duración máxima de 60 días, pizarra de 5 líneas cuadrada al céntimo (`"0,00 €"` limpio) y cartel A4 imprimible con QR real + `tests/e2e/panel-studio-poster.spec.ts`.
  - **Imágenes:** ilustraciones de portada para las plantillas de campaña → SVG (Claude o Gemini) o ilustración en mapa de bits con el **modelo de imagen de Gemini**.
  - **Skills:** `korum-nextjs-multitenant-ui`, `korum-tco-calculator`, `korum-quorum-antifraud`, `korum-ticketing-qr`, `korum-qa-harness-gatekeeper`.
  - **Constructor / auditores:** `korum-backoffice-bi-builder` + `korum-brand-visual-director` ➔ `fintech-escrow-auditor` + `antifraud-legal-guardian` + `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-S01`.

- [ ] **SPRINT 4.4 — Logros, liquidación con doble firma, redimensionamiento y reembolso del 100 %:**
  - 🤖 **IA recomendada:** constructor **Claude Opus 5.5 · esfuerzo alto** (alternativa: Gemini Argon · alto) · auditoría **Claude Opus 5.5 · alto**.
  - ⛓️ **Depende de (aplazado):** respuesta de Paycomet sobre el pago directo al IBAN del proveedor. Mientras tanto el simulador paga a una cuenta destino de Paycomet y el destino «proveedor» queda marcado como no verificado.
  - **Alcance (`~900 LOC`):** liquidaciones y soporte (anclas `id="sch-sub-escrow"`, `id="sch-sub-support"`, `function closeAndPublishAchievedInitiative`, `function sendResizePollToDonors`, `function executeAutomaticRefundAndSponsorReassign`): cierre al 100 % con doble firma, destino entidad o proveedor con factura adjunta, aviso de la ventana de 90 días, fotos Antes/Después, votación vinculante de redimensionamiento, reembolso masivo con progreso visible, reasignación de comercios o `CREDIT_POOL` y buzón prioritario al Super-Admin + `tests/e2e/panel-payout-refund.spec.ts`.
  - **Skills:** `korum-nextjs-multitenant-ui`, `korum-escrow-payments`, `korum-quorum-antifraud`, `korum-qa-harness-gatekeeper`.
  - **Constructor / auditores:** `korum-backoffice-bi-builder` ➔ `fintech-escrow-auditor` + `antifraud-legal-guardian` + `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-S03`.

- [ ] **SPRINT 4.5 — Modo portería móvil y sorteador certificado de rifas:**
  - 🤖 **IA recomendada:** constructor **Claude Sonnet 5.5 · esfuerzo alto** (alternativa: Gemini Argon · alto) · auditoría `antifraud-legal-guardian` en **Claude Opus 5.5 · alto**.
  - **Alcance (`~850 LOC`):** `/panel/[orgSlug]/porteria`: entrada con PIN del evento (límite de intentos), lector QR con respaldo para iOS, validación en < 0,5 s, check-in parcial, alerta roja con sonido y vibración ante pases usados, contador de aforo en vivo, modo sin cobertura con cola local y sincronización, y pantalla proyectable de sorteo certificado con acta + `tests/e2e/panel-porteria-raffle.spec.ts`.
  - **Skills:** `korum-ticketing-qr`, `korum-nextjs-multitenant-ui`, `korum-qa-harness-gatekeeper`.
  - **Constructor / auditores:** `korum-backoffice-bi-builder` ➔ `antifraud-legal-guardian` + `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-S04`, `QA-F06`.

---

## FASE 5 · Entorno 3: consola del Super-Admin, ajustes, pulido final y certificación

- [ ] **SPRINT 5.1 — BI (real frente a proyectado), gráfico de 6 fuentes, tablas ordenables y alertas:**
  - 🤖 **IA recomendada:** constructor **Claude Sonnet 5.5 · esfuerzo alto** (alternativa: Gemini Argon · alto) · auditoría `fintech-escrow-auditor` en **Claude Opus 5.5 · alto**.
  - **Alcance (`~900 LOC`):** `/admin` (anclas `id="sa-sub-bi"`, `function renderSuperAdminBI`, `function renderRevenueSourcesChartInto`, `function sortSaTable`): KPIs del libro mayor separados de la proyección, gráfico de 6 fuentes, tabla de entidades, top 10 y listado global con `💛 Aportaciones`, ordenación `↕` en todas las columnas, alertas 💎 / 🚨, avisos de conciliación y **avisos de salud de precios** (insignia con el número de avisos abiertos en la cabecera, banner si hay alguno `CRITICAL` y aviso `SOURCE_NEGATIVE_MARGIN` calculado con el libro mayor) + `tests/e2e/superadmin-bi.spec.ts`.
  - **Skills:** `korum-tco-calculator`, `korum-nextjs-multitenant-ui`, `korum-qa-harness-gatekeeper`.
  - **Constructor / auditores:** `korum-backoffice-bi-builder` ➔ `fintech-escrow-auditor` + `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-A01`, `QA-A02`.

- [ ] **SPRINT 5.2 — Pop-up ejecutivo (Auto-Impulso con decisión de visibilidad) y ficha 360º con facturas:**
  - 🤖 **IA recomendada:** constructor **Claude Sonnet 5.5 · esfuerzo alto** (alternativa: Gemini Argon · alto) · auditoría `fintech-escrow-auditor` en **Claude Opus 5.5 · alto**.
  - **Alcance (`~900 LOC`):** pop-up (anclas `id="sa-init-popup-modal"`, `function openSuperAdminInitiativePopup`, `function executeSuperAdminSelfBoost`, `function fixNegativeReturnTariff`): enlace público, comercios participantes, **ejecución del Auto-Impulso con selector "mostrar en público / no mostrar"** (valor por defecto del ajuste) y asiento en el libro mayor, corrección de tarifa en 1 clic; ficha 360º (`id="sa-sub-crm"`, `function renderSchoolCRM360`): titular legal, KYB y verificación de Ley 49/2002, tarifas individuales, categorías propias, facturas Veri\*factu, gráfico de 6 fuentes y tabla ordenable de iniciativas + `tests/e2e/superadmin-crm360.spec.ts`.
  - **Skills:** `korum-tco-calculator`, `korum-escrow-payments`, `korum-nextjs-multitenant-ui`, `korum-qa-harness-gatekeeper`.
  - **Constructor / auditores:** `korum-backoffice-bi-builder` ➔ `fintech-escrow-auditor` + `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-A02`, `QA-A03`.

- [ ] **SPRINT 5.3 — Motor de reglas globales, validador de gestión digital, medallas y bandeja de soporte:**
  - 🤖 **IA recomendada:** constructor **Claude Sonnet 5.5 · esfuerzo medio** (alternativa: Gemini Flash 3.8 · alto) · auditoría `fintech-escrow-auditor` en **Claude Opus 5.5 · alto**.
  - **Alcance (`~850 LOC`):** reglas y tickets (anclas `id="sa-sub-rules"`, `id="sa-sub-tickets"`, `function saveGlobalEconomicRules`, `function validateTicketFeeCoverageLive`, `function saveMedalsConfiguration`): tramos (modo plano o marginal, umbrales y tarifas), fee de Mi Hucha (fijo + porcentaje), categorías globales, costes de Paycomet, duración máxima de campaña, validador en vivo, mantenimiento con tope anual, medallas y bandeja de soporte con estados; **panel de salud de precios** con aviso `❗` / `⚠️` y cifra concreta junto a cada campo afectado, recálculo mientras se escribe y botones «Ajustar» y «Aceptar y registrar» (nota obligatoria, `pricing.acknowledgements` y `AuditLog`); guardar nunca se bloquea + `tests/e2e/superadmin-rules-tickets.spec.ts`.
  - **Skills:** `korum-tco-calculator`, `korum-nextjs-multitenant-ui`, `korum-qa-harness-gatekeeper`.
  - **Constructor / auditores:** `korum-backoffice-bi-builder` ➔ `fintech-escrow-auditor` + `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-A03`, `QA-A04`.

- [ ] **SPRINT 5.4 — Ajustes de la plataforma (`/admin/ajustes`):**
  - 🤖 **IA recomendada:** constructor **Claude Sonnet 5.5 · esfuerzo alto** (alternativa: Gemini Argon · alto) · auditoría `antifraud-legal-guardian` en **Claude Opus 5.5 · alto**.
  - **Alcance (`~850 LOC`):** pantallas para los ajustes de [DECISIONES_TECNICAS.md](DECISIONES_TECNICAS.md) §6 (Paycomet y modo, email y remitente, Veri\*factu, modo de Mi Hucha, divulgación por defecto del Auto-Impulso, SEO y rastreadores de IA, textos legales versionados por idioma, límites) con secretos enmascarados, reautenticación 2FA, botón "probar conexión" y historial de cambios desde `AuditLog` + `tests/e2e/superadmin-settings.spec.ts`.
  - **Skills:** `korum-nextjs-multitenant-ui`, `korum-escrow-payments`, `korum-seo-discoverability`, `korum-qa-harness-gatekeeper`.
  - **Constructor / auditores:** `korum-backoffice-bi-builder` ➔ `antifraud-legal-guardian` + `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-A05`, `QA-SEC07`.

- [ ] **SPRINT 5.5 — Pulido "espectacular": SEO final, rendimiento, accesibilidad, traducciones y celebraciones:**
  - 🤖 **IA recomendada:** constructor **Claude Sonnet 5.5 · esfuerzo alto**; revisión nativa de catalán e inglés con **Gemini Argon · alto**; tareas repetitivas de metadatos con **Gemini Flash 3.8 · alto** · auditoría **Claude Sonnet 5.5 · alto**.
  - **Alcance (`~800 LOC`):** auditoría y corrección de todas las páginas públicas con la lista de [korum-seo-discoverability](../.agents/skills/korum-seo-discoverability/SKILL.md) §8, presupuesto de rendimiento, axe en todas las rutas, revisión completa de `ca` y `en`, animaciones y celebraciones de [EXPERIENCIA_DE_PRODUCTO.md](EXPERIENCIA_DE_PRODUCTO.md) §6 y estados vacíos y de error pendientes + `tests/e2e/polish-a11y-perf.spec.ts`.
  - **Imágenes:** revisión final de todas las imágenes generadas (peso, `alt` en 3 idiomas, sin menores identificables).
  - **Skills:** `korum-seo-discoverability`, `korum-nextjs-multitenant-ui`, `korum-brand-design-system`, `korum-qa-harness-gatekeeper`.
  - **Constructor / auditores:** `korum-seo-discoverability-specialist` + `korum-family-viral-builder` + `korum-community-target-psychologist` ➔ `ux-school-director-reviewer` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-SEO01`–`QA-SEO03`, `QA-X01`, `QA-X02`.

- [ ] **SPRINT 5.6 — Certificación de extremo a extremo, prueba de intrusión entre entidades y build de producción:**
  - 🤖 **IA recomendada:** orquestador **Claude Opus 5.5 · esfuerzo extra alto** · *War Room* completo en **Claude Opus 5.5 · alto** + revisión cruzada con **Gemini Argon · alto**.
  - **Alcance (`~750 LOC`):** `tests/e2e/full-lifecycle-journey.spec.ts` en `1440×900` y `430×932` y en dos idiomas (*alta de entidad ➔ idea ➔ quórum ➔ doble firma ➔ Estudio ➔ donación + comercio + taquilla ➔ portería + sorteo ➔ Auto-Impulso ➔ liquidación con factura y Antes/Después ➔ Modelo 182*), pruebas de intrusión entre entidades, `npm run build` sin errores y dictamen conjunto del *War Room*. **Al cerrarlo, el asistente recuerda al promotor las «Tareas externas aplazadas»**, que son requisito del Sprint 6.1.
  - **Skills:** todas.
  - **Constructor / auditores:** orquestador ➔ *War Room* completo (`fintech-escrow-auditor` + `antifraud-legal-guardian` + `ux-school-director-reviewer` + `qa-e2e-verifier`).
  - **Gate QA:** 100 % de la matriz.

---

## FASE 6 · Preproducción y piloto

- [ ] **SPRINT 6.1 — Preproducción: infraestructura en la UE, dominios, copias de seguridad y manual de operación:**
  - 🤖 **IA recomendada:** **Claude Opus 5.5 · esfuerzo alto** (alternativa: Gemini Argon · alto).
  - ⛓️ **Depende de:** cuentas de Vercel, Supabase, proveedor de email, Sentry y Paycomet (sandbox → producción), dominio y **todas las tareas de «Tareas externas aplazadas»** (respuestas de Paycomet, abogado y asesoría fiscal con el visto bueno de [CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md](CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md) §9). **Al abrir este sprint el asistente recuerda al promotor que sin ellas no se pasa a cobros reales.**
  - **Alcance:** entornos `preview` y `production` (funciones en Frankfurt, base de datos en la UE con copias diarias y recuperación a un punto en el tiempo), DNS (SPF, DKIM, DMARC), cron programados, Search Console y Bing Webmaster Tools, alertas de Sentry, prueba completa en sandbox real de Paycomet, simulacro de restauración de copia y `docs/MANUAL_OPERACION.md` (qué hacer ante un pago fallido, un contracargo, una caída o una solicitud RGPD).
  - **Constructor / auditores:** `korum-core-fintech-architect` + `korum-security-gov-engineer` ➔ `antifraud-legal-guardian` + `qa-e2e-verifier`.
  - **Gate QA:** `QA-OPS03`.

- [ ] **SPRINT 6.2 — Piloto con las primeras 3 entidades:**
  - 🤖 **IA recomendada:** **Claude Sonnet 5.5 · esfuerzo medio** para ajustes y soporte; **Claude Opus 5.5 · alto** si aparece un problema de dinero o seguridad.
  - ⛓️ **Depende de:** contrato de Paycomet en producción, KYB real de las 3 entidades y textos legales publicados.
  - **Alcance:** alta acompañada de las 3 entidades, primera campaña de presupuesto y primera taquilla o rifa, seguimiento diario de las métricas de [EXPERIENCIA_DE_PRODUCTO.md](EXPERIENCIA_DE_PRODUCTO.md) §9, registro de incidencias en la bitácora y lista priorizada de mejoras.
  - **Gate QA:** conciliación diaria sin diferencias durante todo el piloto.
