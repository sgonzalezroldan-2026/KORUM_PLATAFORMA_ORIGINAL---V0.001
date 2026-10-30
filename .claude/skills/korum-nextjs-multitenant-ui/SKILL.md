---
name: korum-nextjs-multitenant-ui
description: >-
  Arquitectura Next.js App Router multi-entidad de KORUM: rutas por idioma (es/ca/en), aislamiento
  estricto por organizationId, sistema visual dual (Varsity Heritage + patio), móvil a 430px con
  .mobile-stack, estados de carga/vacío/error, accesibilidad y mapa por anclas estables de
  prototype/Korum_v8.html. Cargar siempre antes de implementar cualquier vista, layout, modal o
  Server Action de los Entornos 0, 1, 2 o 3.
---

<!-- GENERADO AUTOMÁTICAMENTE desde .agents/skills/korum-nextjs-multitenant-ui/SKILL.md por scripts/sync-ai-context.mjs. No editar aquí: edita la fuente y vuelve a ejecutar el script. -->

# Skill · Arquitectura Next.js multi-entidad, sistema visual y paridad con `Korum_v8.html`

## 1. Cómo usar el prototipo (`prototype/Korum_v8.html`)

- Es la **referencia funcional**: define qué acciones, datos, filtros, columnas y alertas existen. **No es la referencia visual** (su paleta y su logotipo son de una fase descartada; manda [korum-brand-design-system](../korum-brand-design-system/SKILL.md)).
- Es un archivo grande. **Nunca lo leas entero.** Busca en [korum-v8-anatomy.md](./references/korum-v8-anatomy.md) el ancla del bloque que migras (`id="checkout-modal"`, `function openCheckoutModal`), localízala con una búsqueda de texto y lee unas 150–250 líneas desde ahí.
- El prototipo **está congelado**: no se edita. Si algo cambia, se cambia en la aplicación.

## 2. Rutas, idiomas y aislamiento entre entidades

1. **Rutas App Router** (con `next-intl`, `localePrefix: 'as-needed'`: castellano sin prefijo, `/ca` y `/en` con prefijo):
   - `src/app/[locale]/(marketing)/page.tsx` → landing, buscador de entidades y calculadora.
   - `src/app/[locale]/(auth)/login/page.tsx` y `registro-comunidad/page.tsx` → acceso y alta.
   - `src/app/[locale]/(public)/[orgSlug]/...` → Entorno 1 (familias, socios y comercios).
   - `src/app/[locale]/(dashboard)/panel/[orgSlug]/...` → Entorno 2 y `/panel/[orgSlug]/porteria`.
   - `src/app/[locale]/(superadmin)/admin/...` → Entorno 3 y `/admin/ajustes`.
   - `src/app/api/og/initiative/[id]/route.tsx` → tarjetas sociales (ver [korum-seo-discoverability](../korum-seo-discoverability/SKILL.md)).
2. **Guardia anti-IDOR en cada Server Action y Route Handler:** nunca confíes en un `organizationId` enviado por el cliente.
   - `FAMILY` / `MERCHANT`: solo operaciones públicas o recursos propios (`userId` / `canonicalEmail`).
   - `DIRECTOR` / `COSIGNER` / `GATEKEEPER`: membresía verificada en `OrganizationMember` para ese `organizationId` y el rol que exige la acción.
   - Sesión de portería (`GateSession`): solo el escáner y el sorteo de **su** evento.
   - `isSuperadmin`: acceso transversal, siempre registrado en `AuditLog`.
   - **Cómo se aplica (Sprint 1.3):** ninguna Server Action ni Route Handler toca `prisma` directamente para datos de una entidad: usa `src/repositories/*`. Cada función recibe el **actor de la sesión** (`SessionActor`, se carga con `loadUserActor(db, userId)`; nunca membresías enviadas por el cliente) y el `organizationId` que se QUIERE consultar, y llama primero a `authorizeTenant(db, actor, organizationId, { roles, action, targetType })`: denegado por defecto, `403` y `AuditLog` (`tenant.access_denied`) sin haber leído nada. Los recursos se piden siempre junto a su entidad (`requireOwnedResource`): un identificador de otra entidad responde un `404` idéntico al de uno inexistente y se registra. Las vistas eligen cada campo con `select` (sin correos de familias, sin NIF, sin PIN de portería, sin el correo de quien propone una idea). Las lecturas del Entorno 1 salen de `public.repository.ts`, que solo devuelve campos públicos. Una operación nueva = un repositorio + su prueba de aislamiento en `tests/integration/tenant-isolation.spec.ts`.
3. **Textos visibles:** siempre con `useTranslations` / `getTranslations` desde `messages/{es,ca,en}.json`. Ningún literal en JSX salvo nombres propios.

## 3. Sistema visual dual y regla de 430 px

> Carga siempre junto a [korum-brand-design-system](../korum-brand-design-system/SKILL.md), que manda en tokens, logotipo y activos.

1. **Capa 1 · Solidez colegial en dinero y gobierno (`.korum-trust-vault`):** cabecera, hucha `WLT-ESC-XXX`, desglose de 4 líneas, pizarra TCO, checkout, Mi Hucha, doble firma, certificados, facturas y pases/carteles QR. Superficies limpias, bordes en azul marino `#101F38` y esmeralda `#047857`, `Plus Jakarta Sans` con `tabular-nums`. Logotipo: *Parche Varsity Heritage* (componentes `KorumLogo` y `KorumMark` de `src/components/brand/`, dibujados a partir de la lámina `public/brand/korum-logo.jpg`; variante para fondos oscuros).
2. **Capa 2 · Emoción de patio en la comunidad:**
   - Fondo `.korum-paper-dots` (`#FFFDF8`) en `SCHOOL`; `.korum-court-grid` en `SPORTS_CLUB`.
   - `.korum-notebook-sheet` en el buzón de ideas; `.die-cut-sticker` y `.tactile-btn` en retos, medallas y *Matching 2x*; subrayados de cera (`#FFB800` / `#FF5A43`).
3. **Tipografía:** `.font-corp` (`Plus Jakarta Sans` 700/800 + `tabular-nums`) para marca, cabeceras, recibos, tablas e importes; `.font-joy` (`Fredoka` 600/700) solo para titulares de campañas, nombre del centro en su portada, retos y celebraciones.
4. **Micro-interacciones:** tooltip contextual con retardo exacto de `1000 ms` (`<DelayedTooltip delayMs={1000}>`); filtros ocultos al cargar tras `🔍 Filtrar`.
5. **Móvil (`430×932`):** toda vista multicolumna de familias y la portería usa `.mobile-stack` (una sola columna en `< 768px`) y garantiza `document.documentElement.scrollWidth <= 430`. En producción no existe el simulador móvil del prototipo: el diseño responde al ancho real.

## 4. Estados obligatorios de cada vista

Toda vista con datos implementa sus cuatro estados con el texto que indica [docs/EXPERIENCIA_DE_PRODUCTO.md](../../../docs/EXPERIENCIA_DE_PRODUCTO.md) §5:

- **Cargando:** esqueleto con la forma del contenido (nunca un spinner a pantalla completa), mediante `loading.tsx` o `Suspense`.
- **Vacío:** mensaje que explica qué falta y un botón con la siguiente acción.
- **Error:** `error.tsx` con explicación en lenguaje llano, botón de reintentar y referencia del error para soporte; nunca un error técnico en pantalla.
- **Éxito:** confirmación visible (toast o pantalla de celebración) y foco movido al resultado.

### Primitivas de `src/components/ui/` (Sprint 1.1): reglas de uso

- **`DelayedTooltip`** (1000 ms con puntero, instantáneo con teclado, Escape en todo momento, la burbuja se puede pisar): el hijo debe ser enfocable y reenviar `aria-describedby`. Un botón `disabled` no recibe foco ni puntero: envuélvelo en `<span tabIndex={0}>`.
- **`ToastProvider` / `useToast`:** para confirmaciones y errores **globales**. Un error de formulario dentro de un modal va **dentro del modal** (`role="alert"` junto al campo): la región de avisos queda fuera del diálogo y un lector de pantalla no la anunciaría.
- **`EmptyState`:** `headingLevel={1}` en páginas completas (404, error: cada página tiene un único `h1`); `playful` solo en la comunidad (Fredoka), nunca en zonas de dinero; `role="alert"` + `headingRef` para errores.
- **`LoadingRegion`** envuelve los esqueletos: anuncia «Cargando…» una vez y marca la zona como ocupada.
- **`SortableTh`** + `useSortableRows`: pasa `columnName` si el `label` lleva emojis. Cada zona con scroll horizontal (`overflow-x-auto`) lleva `tabIndex={0}`, `role="region"` y `aria-label`. `LanguageSwitcher` conserva la ruta pero no los parámetros de búsqueda (deuda hasta que haya filtros en la URL).
- **`CurrencyText` / `formatCents`:** cualquier importe visible pasa por ellos; nunca `toFixed` ni `Intl` suelto.

## 5. Accesibilidad y rendimiento (se comprueban en la Puerta 4)

- WCAG 2.2 AA (Regla 03 §8): HTML semántico, foco visible, etiquetas en formularios, `aria-live` para errores y cambios de progreso, `prefers-reduced-motion`.
- Presupuesto en móvil medio con 4G: LCP < 2,5 s, INP < 200 ms, CLS < 0,1; JavaScript inicial de las páginas públicas < 170 KB comprimido. Server Components por defecto; `"use client"` solo donde hay interacción.
- Imágenes con `next/image`, tamaños declarados y formatos modernos.
- **Páginas públicas estáticas (`● /es`, `● /ca`, `● /en` en la tabla de `npm run build`):** cada layout y página de `[locale]` llama a `setRequestLocale(locale)` antes de usar traducciones, y pasa el idioma explícito en `generateMetadata` (`getTranslations({ locale, namespace })`). **`loading.tsx` es siempre componente de cliente**: no recibe `params`, y si usa las traducciones de servidor hace que toda la ruta pase a renderizarse en cada petición (lección del Sprint 1.1). Tras cualquier cambio de estructura, comprueba que la tabla de `npm run build` sigue mostrando `●` en las páginas públicas.
- **404 con código 404 (no «soft 404»):** un `loading.tsx` hace *streaming* y envía antes el código `200`, de modo que un `notFound()` posterior ya no puede cambiarlo y Google lo trata como página válida. Por eso **no hay `loading.tsx` en la raíz de `[locale]`**: se coloca solo dentro de los segmentos con datos (portal, panel, consola) y la comprobación de existencia (`organización no encontrada` → `notFound()`) se hace en el `layout.tsx` de ese segmento, que se resuelve antes del *streaming*. `tests/e2e/i18n-base.spec.ts` comprueba que una URL inexistente responde `404`.
