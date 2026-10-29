# Regla 01 · Arquitectura, Precisión Contable y Estándares de Código

## 1. Stack Tecnológico Oficial y Precisión Monetaria
- **Framework Full-Stack:** Next.js (App Router) con TypeScript estricto (`strict: true`), incluyendo generación dinámica de tarjetas virales OpenGraph (`next/og`).
- **Estilos, Marca Corporativa y Sistema Visual Dual:** Tailwind CSS con arquitectura visual de doble capa (`.agents/skills/korum-brand-design-system/SKILL.md`):
  - **Capa 1 · Institucional y Fiduciaria:** Paleta colegial varsity (`#101F38` marino sudadera, `#F59E0B`/`#D97706` oro mostaza deportivo, `#047857` esmeralda Escrow) + **Logotipo Colegial Oficial *"El Escudo Varsity Heritage"*** (`public/brand/korum-logo.svg`, `korum-logo-dark.svg`, `korum-mark.svg`, `korum-escrow-seal.svg`) en cabeceras, Checkout, custodia `WLT-ESC-XXX`, Mi Hucha, paneles de gestión y documentos fiscales. Cero frialdad bancaria. Repositorio histórico en `public/brand/_old/`.
  - **Capa 2 · Emocional y Desenfadada de Comunidad:** Paleta cálida `patio` (`#FFFDF8` crema con `.korum-paper-dots`, `#FF5A43` coral KORUM, `#FFB800` sol, `#0F172A` marino) y variables CSS dinámicas (`--brand-primary`, `--brand-secondary`) con pegatinas `.die-cut-sticker`, subrayados de cera y botones táctiles `.tactile-btn` en portadas de centros, retos colectivos, buzón de ideas y logros.
- **Tipografías con Separación Estricta de Rol:** `Plus Jakarta Sans` (`700`/`800`, clase `.font-corp` y `tabular-nums`) obligatoria para el logotipo corporativo `KORUM`, cabeceras institucionales, zonas de pago Escrow, importes monetarios y tablas; `Fredoka` (clase `.font-joy`) reservada exclusivamente para titulares emocionales de campañas comunitarias, retos infantiles/deportivos y celebraciones (prohibida en el logo `KORUM` o en cifras financieras).
- **Base de Datos, ORM y Regla de Céntimos Enteros:** PostgreSQL (Supabase / RDS) gestionado con Prisma ORM (`schema/schema.prisma`). **Está prohibido usar `Float` para dinero:** todo importe monetario se almacena y procesa en **céntimos enteros (`Int`, ej. `2500` = `25,00 €`)** respaldado por un libro mayor inmutable de doble partida (`EscrowLedgerEntry`).
- **Pasarela Bancaria Escrow:** Paycomet REST API mediante patrón *Adapter* (`src/services/payments/paycomet.adapter.ts`) con webhooks verificados por HMAC e idempotencia estricta (`idempotencyKey`).

## 2. Separación Modular de Entornos y Seguridad Multi-Tenant
Nunca mezcles lógica de diferentes roles en un mismo componente de vista y aplica aislamiento estricto por `organizationId` en cada Server Action / API Route:
- `src/app/(marketing)/...` y `src/app/(auth)/...` ➔ Entorno 0: Landing comercial, calculadora de impacto, onboarding B2B y autenticación multi-rol.
- `src/app/(public)/[orgSlug]/...` ➔ Entorno 1: Web/App Familias, Socios y Comercios + `src/app/api/og/...` (tarjetas virales WhatsApp).
- `src/app/(dashboard)/school/[orgSlug]/...` ➔ Entorno 2: Panel Gestor Colegio / AFA / Club (incluyendo subruta ligera `/porteria` para escaneo QR de entradas con PIN temporal).
- `src/app/(superadmin)/admin/...` ➔ Entorno 3: Consola Ejecutiva Super-Admin KORUM.
- `src/core/finance/...` y `src/core/security/...` ➔ Funciones puras, deterministas y en céntimos enteros del motor TCO, Ledger, Veri\*factu, Modelo 182 y anti-fraude.

## 3. Variables de Entorno Requeridas (`.env.example`)
Todo módulo de pagos, criptografía QR o seguridad debe leer exclusivamente de variables de entorno validadas con Zod al arrancar:
- `DATABASE_URL`
- `PAYCOMET_API_KEY`
- `PAYCOMET_MERCHANT_CODE`
- `PAYCOMET_TERMINAL_ID`
- `PAYCOMET_WEBHOOK_SECRET`
- `AUTH_SECRET`
- `QR_HMAC_SECRET`
- `VERIFACTU_ISSUER_NIF`
- `NEXT_PUBLIC_APP_URL`

## 4. Preservación Funcional ("Zero Regression Policy") e Independencia Lean
- El archivo `prototype/Korum_v8.html` contiene todas las funcionalidades base validadas por negocio.
- Al migrar cualquier vista a componentes TypeScript/React, está **prohibido eliminar botones, desplegables, columnas de tablas, alertas o flujos** presentes en `prototype/Korum_v8.html`, integrando sobre ellos las mejoras de blindaje v8.5.
- **Principio de Independencia Absoluta:** KORUM nunca intermedia ni homologa proveedores de obras/equipamiento ni cobra comisiones a instaladores; el centro mantiene el 100% de soberanía sobre sus proveedores locales.

