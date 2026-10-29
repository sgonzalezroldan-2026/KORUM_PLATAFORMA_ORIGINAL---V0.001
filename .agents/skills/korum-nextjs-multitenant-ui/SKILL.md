---
name: korum-nextjs-multitenant-ui
description: >-
  Arquitectura Next.js 15 App Router Multi-Tenant, aislamiento estricto por organizationId,
  sistema visual Tailwind patio (Mobile-First 430px .mobile-stack), tarjetas virales next/og y
  mapa anatómico exacto por líneas de prototype/Korum_v8.html. Cargar siempre antes de implementar
  cualquier vista, layout, modal o Server Action de los Entornos 0, 1, 2 o 3.
---

# Skill · Arquitectura Next.js Multi-Tenant, Design System `patio` y Paridad `Korum_v8.html`

## 1. Uso Inteligente de la Referencia Funcional (`prototype/Korum_v8.html`)
- `prototype/Korum_v8.html` tiene `5.217` líneas (`332 KB`). **Nunca leas el archivo entero de golpe.**
- Consulta primero [korum-v8-anatomy.md](./references/korum-v8-anatomy.md) para localizar el rango exacto de líneas (`StartLine`–`EndLine`) del bloque HTML, modal y función JS que estás migrando, y lee únicamente esas `100–250` líneas para garantizar **0% de regresión visual o funcional** ahorrando el `85%` de la ventana de contexto.

## 2. Estructura de Rutas y Aislamiento Multi-Tenant (`organizationId`)
1. **Grupos de Rutas App Router:**
   - `src/app/(marketing)/page.tsx` ➔ Landing B2B/B2C, buscador de centros y simulador en vivo.
   - `src/app/(auth)/login/page.tsx` y `registro-comunidad/page.tsx` ➔ Magic Link/OTP, 2FA y alta "Zero-Touch".
   - `src/app/(public)/[orgSlug]/...` ➔ Entorno 1 (Familias, Socios y Comercios Amigos) + `src/app/api/og/initiative/[id]/route.tsx`.
   - `src/app/(dashboard)/school/[orgSlug]/...` ➔ Entorno 2 (Panel Mancomunado Dirección + AFA/Club) y `/school/[orgSlug]/porteria` (acceso PIN temporal).
   - `src/app/(superadmin)/admin/...` ➔ Entorno 3 (Consola Ejecutiva BI Super-Admin KORUM).
2. **Guardia Obligatoria Anti-IDOR en Server Actions y Route Handlers:**
   - Jamás confíes en un `organizationId` enviado por el cliente sin contrastarlo contra la sesión activa:
     - `FAMILY` / `MERCHANT`: solo operaciones públicas permitidas o recursos propios (`userId` / `canonicalEmail`).
     - `DIRECTOR` / `AFA_PRESIDENT` / `GATEKEEPER`: exige membresía verificada en `OrganizationMember` para ese exacto `organizationId` y el rol concreto requerido por la acción.
     - `SUPERADMIN`: acceso transversal auditado.

## 3. Arquitectura Visual Dual: *"Autoridad Corporativa Fiduciaria + Emoción de Patio"* y Regla `430px`
> **Nota obligatoria:** Carga siempre en conjunto `.agents/skills/korum-brand-design-system/SKILL.md` para aplicar las reglas completas de marca y tokens visuales.

1. **Identidad Corporativa de Alta Presencia y Activos en `public/brand/`:**
   - **Nuevo Logotipo Corporativo Oficial (*"El Escudo Ágora-K"*):** Escudo heráldico-arquitectónico en Marino Soberano (`#0B1526`) con bisel en Oro Fiduciario (`#D97706` / `#F59E0B`), monograma `K` estructural interior y piedra angular dorada, acompañado del wordmark geométrico pesado `KORUM` en `Plus Jakarta Sans ExtraBold` (`.font-corp`). **Prohibido usar estética infantil de muñecos en corro o tipografía `Fredoka` en el logotipo corporativo `KORUM`.**
   - **Activos Vectoriales e Ilustraciones Oficiales:** Usa `public/brand/korum-logo.svg` (claro), `public/brand/korum-logo-dark.svg` (cabeceras oscuras `#0B1526`), `public/brand/korum-mark.svg` (escudo aislado/favicon/QR) y `public/brand/korum-escrow-seal.svg` para el **Marco Institucional y Fiduciario (Capa 1)**; utiliza `public/brand/korum-hero-patio.jpg` y `public/brand/korum-notebook-stickers.jpg` para la **Experiencia Comunitaria Emocional (Capa 2)**.
2. **Separación Estricta de las 2 Capas Visuales (CSS Puro de `0 KB`):**
   - **Capa 1 · Seriedad Bancaria en Zonas de Dinero y Gobernanza (`.korum-trust-vault`):** En cabeceras maestras, barra `WLT-ESC-XXX`, Desglose de 4 líneas, Pizarra TCO, Checkout Express 10s, Mi Hucha, Doble Firma, Certificados IRPF, Facturas Veri\*factu y Pases/Carteles QR, aplica superficies limpias, bordes estructurados en marino/esmeralda (`#047857`) y `Plus Jakarta Sans` con `tabular-nums` para inspirar confianza financiera absoluta.
   - **Capa 2 · Emoción Cercana y Desenfadada en el Patio y Comunidad:**
     - **Lienzo Cuaderno Punteado (`.korum-paper-dots`):** `#FFFDF8` con trama sutil de libreta (`radial-gradient`) para `SCHOOL`, cambiando a trama táctica suave de cancha (`.korum-court-grid`) en `SPORTS_CLUB`.
     - **Hoja de Libreta en Buzón de Ideas (`.korum-notebook-sheet`):** margen vertical coral suave y tacto cálido de papel.
     - **Pegatinas Troqueladas (`.die-cut-sticker`) y Botones Táctiles (`.tactile-btn`):** borde blanco nítido, sombra suave y micro-giro desenfadado (`-rotate-1` / `rotate-1`) en retos colectivos, medallas y sellos *Matching 2x*, junto con trazos vectoriales `SVG` estilo cera/rotulador (`#FFB800` / `#FF5A43`) bajo palabras emocionales.
3. **Jerarquía Tipográfica Dual, Datos Tabulares y Micro-Interacciones Obligatorias:**
   - **Corporativa y Financiera (`.font-corp`):** `Plus Jakarta Sans` (`700`/`800`) + `tabular-nums` obligatorio en el logo `KORUM`, cabeceras corporativas, recibos, tablas y todo importe en euros.
   - **Emocional y Comunitaria (`.font-joy`):** `Fredoka` (`600`/`700`) reservada para titulares cercanos de campañas, nombre del centro en su portada, retos de cursos/categorías y celebraciones de logros.
   - **Tooltip Contextual con Retardo Exacto de `1000ms`:** `<DelayedTooltip delayMs={1000}>`.
   - **Filtros Siempre Ocultos al Cargar:** ocultos (`isOpen = false`) tras `🔍 Filtrar`.
4. **Blindaje Mobile-First (`430x932`) y Conmutador `🖥️ Web / 📱 Móvil`:**
   - Toda vista multicolumna de Familias (`Ficha Detallada`, `Mi Hucha`, `FAQ y Soporte`) y `Modo Portería` debe aplicar `.mobile-stack`, forzando **1 sola columna vertical** tanto en `< 768px` como dentro del simulador móvil (`max-w-[430px]`), garantizando `document.documentElement.scrollWidth <= 430`.

