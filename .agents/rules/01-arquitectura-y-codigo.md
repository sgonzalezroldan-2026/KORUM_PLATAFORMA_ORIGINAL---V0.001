# Regla 01 · Arquitectura, Precisión Contable y Estándares de Código

> Decisiones completas y motivos: [docs/DECISIONES_TECNICAS.md](../../docs/DECISIONES_TECNICAS.md). Esta regla solo recoge lo que se aplica en cada línea de código.

## 1. Stack oficial

- **Versiones:** en el Sprint 1.1 se fija la última versión estable de cada pieza (comprobar con `npm view <paquete> version`) y se guarda en `package.json` sin rangos abiertos (`^`/`~` solo en dependencias de desarrollo). Referencia verificada en octubre de 2026: Next.js 16, React 19, Tailwind CSS 4, Prisma ORM 7.
- **Framework:** Next.js (App Router) + TypeScript estricto (`strict: true`, `noUncheckedIndexedAccess: true`). Tarjetas sociales con `next/og`.
- **Estilos:** Tailwind CSS 4 con configuración CSS-first (`@theme` en `src/app/globals.css`; no existe `tailwind.config.ts`). Tokens y capas visuales en [korum-brand-design-system](../skills/korum-brand-design-system/SKILL.md).
- **Tipografías:** `Plus Jakarta Sans` (`.font-corp`, `tabular-nums`) para la marca, importes, tablas y zonas de dinero; `Fredoka` (`.font-joy`) solo para titulares emocionales de campañas, retos y celebraciones. Prohibido `Fredoka` en el logotipo o en cifras.
- **Base de datos:** PostgreSQL (Supabase, región UE) con Prisma ORM 7 (`schema/schema.prisma` + `prisma.config.ts` + adaptador `@prisma/adapter-pg`). El cliente generado vive en `src/generated/prisma` y no se versiona.
- **Autenticación:** Better Auth (enlace mágico y OTP por email para familias y comercios; contraseña + 2FA obligatoria para firmantes y Super-Admin; passkeys opcionales).
- **Idiomas:** `next-intl` con castellano (`es`, por defecto), catalán (`ca`) e inglés (`en`). Ningún texto visible se escribe en el código: todo sale de `messages/{es,ca,en}.json`.
- **Validación:** Zod en toda entrada externa (formularios, Server Actions, webhooks, variables de entorno).

## 2. Dinero: céntimos enteros y libro mayor de doble partida

- **Prohibido `Float` para dinero.** Todo importe es un entero en céntimos (`2500` = `25,00 €`) y todo porcentaje en puntos básicos (`100` = `1,00 %`). Valida con `Number.isSafeInteger`.
- Todo movimiento de dinero genera un **asiento** (`LedgerJournal`) con sus **apuntes** (`EscrowLedgerEntry`) en la misma `prisma.$transaction`, con `idempotencyKey` única y `Σ DEBIT === Σ CREDIT`. Los asientos no se editan ni se borran: se corrigen con un contra-asiento. Detalle en la [Regla 02](02-invariantes-financieros.md).
- Nunca se actualiza `raisedCents`, un saldo o un estado de pago sin su asiento.

## 3. Pagos

- Paycomet REST API detrás de una interfaz `PaymentProvider` (`src/services/payments/`), con tres modos (`PAYCOMET_MODE`): `mock` (simulador local determinista con firmas reales, para desarrollo y tests), `sandbox` y `live`.
- Webhooks verificados por firma, registrados en `WebhookEvent` (idempotencia por `provider + externalEventId`) y procesados dentro de una transacción.
- El adaptador permite cambiar de proveedor (p. ej. un monedero regulado para Mi Hucha) sin tocar el resto del código.

## 4. Rutas y aislamiento multi-tenant

Nunca mezcles lógica de entornos distintos en un mismo componente de vista. Rutas (con `localePrefix: 'as-needed'`: el castellano va sin prefijo, `/ca/...` y `/en/...` con él):
- `src/app/[locale]/(marketing)/...` y `src/app/[locale]/(auth)/...` → **Entorno 0**: landing, calculadora, onboarding y acceso.
- `src/app/[locale]/(public)/[orgSlug]/...` → **Entorno 1**: familias, socios y comercios.
- `src/app/[locale]/(dashboard)/panel/[orgSlug]/...` → **Entorno 2**: panel de la entidad, incluida la subruta `/panel/[orgSlug]/porteria` (acceso con PIN del evento).
- `src/app/[locale]/(superadmin)/admin/...` → **Entorno 3**: consola del Super-Admin, incluida `/admin/ajustes`.
- `src/app/api/og/...` (tarjetas sociales), `src/app/api/webhooks/paycomet/route.ts`, `src/app/api/cron/[job]/route.ts` (protegido con `CRON_SECRET`).
- `src/app/robots.ts`, `src/app/sitemap.ts` y `src/app/llms.txt/route.ts` → descubribilidad ([korum-seo-discoverability](../skills/korum-seo-discoverability/SKILL.md)).
- `src/core/finance|security|ticketing|tax/...` → funciones puras y deterministas.
- `src/services/payments|email|storage|invoicing/...` → adaptadores a proveedores externos.

Toda Server Action y Route Handler obtiene `organizationId` y rol **de la sesión**, nunca del cliente, y registra en `AuditLog` los accesos denegados.

## 5. Configuración: consola del Super-Admin primero, variables de entorno solo para lo imprescindible

- **Desde `/admin/ajustes` (tablas `PlatformSetting` y `PlatformSecret`)** se configura todo lo operativo: credenciales de Paycomet, proveedor y remitente de email, NIF emisor y proveedor Veri\*factu, modo de Mi Hucha, divulgación del Auto-Impulso, textos legales versionados y límites de la plataforma. Los secretos se guardan cifrados (AES-256-GCM), nunca se vuelven a mostrar completos, exigen reautenticación con 2FA para cambiarlos y quedan en `AuditLog`.
- **Solo variables de entorno** (validadas con Zod al arrancar en `src/config/env.ts`) para lo que protege la propia consola o los datos cifrados, y para la infraestructura:

| Variable | Para qué |
| :--- | :--- |
| `DATABASE_URL` / `DIRECT_URL` | Conexión a PostgreSQL (pooler) y conexión directa para migraciones |
| `BETTER_AUTH_SECRET` | Firma de sesiones |
| `ENCRYPTION_KEY` / `ENCRYPTION_KEY_VERSION` | Cifrado de secretos, tokens de pago y NIF |
| `DATA_HMAC_SECRET` | HMAC de NIF, IP y huellas (búsquedas sin guardar el dato en claro) |
| `QR_HMAC_SECRET` | Firma de los pases QR |
| `CRON_SECRET` | Autenticación de las tareas programadas |
| `PAYCOMET_MODE` | `mock` · `sandbox` · `live` |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Almacenamiento de ficheros |
| `NEXT_PUBLIC_APP_URL` | URL canónica pública |
| `NEXT_PUBLIC_SENTRY_DSN` / `SENTRY_AUTH_TOKEN` | Registro de errores (el DSN es público por diseño; el token no) |
| `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` | Analítica sin cookies |
| `SUPERADMIN_BOOTSTRAP_EMAIL` | Alta del primer Super-Admin |

- Opcionales como **respaldo** si la consola aún no tiene valor (CI, primer arranque): `PAYCOMET_API_KEY`, `PAYCOMET_MERCHANT_CODE`, `PAYCOMET_TERMINAL_ID`, `PAYCOMET_WEBHOOK_SECRET`, `EMAIL_API_KEY`, `VERIFACTU_ISSUER_NIF`. El valor de la consola siempre tiene prioridad.
- Plantilla completa en [.env.example](../../.env.example). Prohibido exponer secretos con el prefijo `NEXT_PUBLIC_`.

## 6. Preservación funcional e independencia

- `prototype/Korum_v8.html` es la **referencia funcional** (qué hace la app), no la visual: su paleta y su logotipo son anteriores a la marca vigente.
- Al migrar una vista se conserva **cada función** del prototipo (acciones, datos, filtros, columnas, alertas, flujos). La interfaz puede reorganizarse o simplificarse si la función sigue disponible y `ux-school-director-reviewer` lo aprueba. Eliminar una función requiere aprobación expresa del usuario.
- La barra de demostración del prototipo (selector de entornos, perfiles simulados y conmutador web/móvil) **no llega a producción**: solo existe con `NEXT_PUBLIC_DEMO_MODE=true` en el entorno de demostración.
- **Independencia de proveedores:** KORUM nunca intermedia ni homologa proveedores de obras o equipamiento ni les cobra comisiones; la entidad elige libremente.
