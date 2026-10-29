# KORUM · Plataforma SaaS Multi-Tenant de Quórum Comunitario, Mecenazgo Escrow y Taquilla QR

> **Eslogan Oficial:** *"Donde las buenas ideas suman y se logran."*
> **Ámbito Multi-Vertical:** Colegios / AFAs / AMPAs, Clubes Deportivos Base, Escuelas de Música y Asociaciones Culturales.
> **Principio Rector de Neutralidad:** **100% Independencia de Proveedores** (Cero intermediación comercial ni comisiones ocultas; automatización pura SaaS/Fintech "Zero-Touch / Lean" con estructura de costes mínima).
> **Motor Bancario y Escrow Principal:** **Paycomet** (REST API Marketplace / Split / Escrow en céntimos enteros + Bizum + Tokenización `JET-ID` + Reembolsos `Refund` al origen).
> **Identidad de Marca y Arquitectura Visual Híbrida:** **Logotipo Colegial *"El Escudo Varsity Heritage"*** (`public/brand/korum-logo.svg`, `korum-logo-dark.svg`, `korum-mark.svg`, `korum-escrow-seal.svg`, `korum-logo.jpg`) inspirado en sudaderas y uniformes universitarios de prestigio (*Stanford / Yale / Santa Isabel*), con presencia seria y sólida de centro educativo (azul marino sudadera `#101F38` + tipografía colegial con doble perfil en oro deportivo `#F59E0B` + laureles bordados con cinta *EST. 2026*), sin frialdad bancaria y armonizado con la experiencia del **Cuaderno Vivo de Patio** (`.korum-notebook-sheet`, `.korum-stamp-badge`, notas con washi tape y sellos entintados de mérito para el Buzón de Ideas y Logros). Repositorio histórico organizado en `public/brand/_old/`.
> **Referencia Funcional Base:** `prototype/Korum_v8.html` (consultar índice anatómico exacto en `.agents/skills/korum-nextjs-multitenant-ui/references/korum-v8-anatomy.md`) evolucionada con el blindaje de producción **v8.5 Next-Level**.

---

## 1. Visión General de la Arquitectura

KORUM es una plataforma web/móvil Multi-Tenant dividida en **Entorno 0 (Marketing/Auth)** y **3 entornos operativos estrictamente sincronizados**:

1. **Entorno 1 — Portal Público (`Web/App Familias, Socios y Comercios`):**
   - Iniciativas en estado `Recaudando` (con soporte opcional de retos multiplicadores *Matching 2x*) y Taquilla de Eventos / Rifas Digitales QR con tarjetas virales dinámicas para WhatsApp (`next/og`).
   - Checkout en 10 segundos sin registro obligatorio (capturando email ligero en modo invitado para entrega segura de entradas QR y recibos), grupos dinámicos según vertical (`13 Cursos Escolares` o `Categorías Deportivas`) y texto legal condicional de deducción IRPF según `organization.ley49`.
   - Buzón de Ideas con Quórum comunitario y auditoría anti-fraude reforzada en servidor (`<= 2` cuentas familiares verificadas por dispositivo).
   - Galería de Logros Conseguidos (Comparativa Antes / Después).
   - Directorio de Comercios Amigos (Clasificados exclusivamente por categoría `🥇 Oro`, `🥈 Plata` y `🥉 Bronce`, ordenados de mayor a menor rango y sin exponer importes en público).
   - Área privada **Mi Hucha KORUM** (Saldo pre-asignado en céntimos, recarga puntual instantánea, recarga mensual programada `JET-ID`, reembolso seguro `Refund` al medio de pago original con advertencia —cumplimiento PSD2/AML—, entradas QR firmadas con HMAC y autogestión fiscal separando estrictamente donativos irrevocables de recargas/entradas).
   - FAQ y Buzón inteligente de soporte.
2. **Entorno 2 — Panel Gestor (`Colegio / AFA / Club`):**
   - Cuadro de Mandos cuantitativo e Histórico con línea gráfica de 6 estados, Kit de Medallas e ID de Hucha Escrow (`WLT-ESC-XXX`).
   - Gestor de aprobaciones con **Doble Check mancomunado criptográfico real (`ROLE_DIRECTOR` + `ROLE_AFA_PRESIDENT`)**, auditoría de firmas, moderación de comercios (con bolsa `CREDIT_POOL` de respaldo) y conexión bancaria KYB Paycomet.
   - Estudio de Edición con pizarra TCO dual cuadrada al céntimo (Modo Presupuesto de Obra con 100% libertad de proveedor del centro vs. Modo Taquilla/Rifas QR con aviso normativo en rifas).
   - Módulo de Logros y Liquidaciones (Doble firma mancomunada para pago a proveedor con factura PDF adjunta o cuenta del centro, fotos Antes/Después, o votación de redimensionamiento / reembolso 100% automático).
   - **Modo Portería QR (`/school/[orgSlug]/porteria`)** con PIN temporal sin instalar app (escáner de cámara contra fotocopias y sorteador certificado en vivo para rifas), exportador automático del **Modelo 182 AEAT (`.BOE`)** para entidades `ley49` y Generador de Cartel Oficial A4 + QR.
3. **Entorno 3 — Consola Ejecutiva (`Super-Admin KORUM`):**
   - Cuadro de Mandos BI con tablas interactivas ordenables (`↕`), separando **Ingresos Reales Devengados** (leídos del Ledger contable) de **Previsión Proyectada al 100%**, Gráfico cuadrado de las 6 Fuentes de Ingresos, Top 10 Iniciativas y Listado Global.
   - Alertas algorítmicas en tiempo real: **💎 Alerta de Auto-Impulso Rentable** y **🚨 Alerta Roja de Peligro de Retorno Negativo**.
   - Ficha 360º de Centro (Condiciones individuales, categorías personalizadas, facturación automática **Veri\*factu** y analítica completa del centro).
   - Motor de Reglas Globales, Costes de Pasarela Paycomet, Gastos de Gestión Digital (validando el % variable sobre el cobro bruto total), Gamificación de Medallas y Bandeja Central de Tickets.

---

## 2. Ecosistema de Super-Especialización Agéntica (7 Skills + 9 Subagentes)

Antes de ejecutar cualquier tarea, consulta la hoja de ruta dimensionada en [PLAN_IMPLEMENTACION_ATOMICO.md](docs/PLAN_IMPLEMENTACION_ATOMICO.md) y la matriz determinista en [QA_ACCEPTANCE_CRITERIA.md](docs/QA_ACCEPTANCE_CRITERIA.md):

### 2.1 Reglas Permanentes (`.agents/rules/`)
- [01-arquitectura-y-codigo.md](.agents/rules/01-arquitectura-y-codigo.md)
- [02-invariantes-financieros.md](.agents/rules/02-invariantes-financieros.md)
- [03-ux-mobile-y-copywriting.md](.agents/rules/03-ux-mobile-y-copywriting.md)
- [04-ejecucion-sin-recortes.md](.agents/rules/04-ejecucion-sin-recortes.md)

### 2.2 Skills Bajo Demanda (`.agents/skills/` — Activar según el Sprint)
1. **Motor TCO en Céntimos, Exenciones, Medallas y BI Real vs. Proyectado:** `korum-tco-calculator` (`.agents/skills/korum-tco-calculator/SKILL.md`)
2. **Paycomet REST API, Ledger Escrow, Refund PSD2 y Veri\*factu:** `korum-escrow-payments` (`.agents/skills/korum-escrow-payments/SKILL.md`)
3. **Quórum Padre/Madre, Doble Firma, Candado `\b`, Ley 49 y Modelo 182:** `korum-quorum-antifraud` (`.agents/skills/korum-quorum-antifraud/SKILL.md`)
4. **Taquilla Atómica, QR HMAC-SHA256, Modo Portería y Sorteo CSPRNG:** `korum-ticketing-qr` (`.agents/skills/korum-ticketing-qr/SKILL.md`)
5. **Arquitectura Next.js Multi-Tenant, Sistema `patio` y Anatomía `Korum_v8.html`:** `korum-nextjs-multitenant-ui` (`.agents/skills/korum-nextjs-multitenant-ui/SKILL.md`)
6. **Arnés de Calidad 5-Gates, Vitest/Playwright y Escáner de Invariantes:** `korum-qa-harness-gatekeeper` (`.agents/skills/korum-qa-harness-gatekeeper/SKILL.md`)
7. **Identidad Corporativa (*Escudo Ágora-K*), Tokens Fiduciarios y Diseño Visual Dual:** `korum-brand-design-system` (`.agents/skills/korum-brand-design-system/SKILL.md`)

### 2.3 Subagentes Constructores y Directores de Diseño (*Builders* — `.agents/agents/`)
- `korum-core-fintech-architect`: Backend financiero puro, Prisma Multi-Tenant, Ledger de doble partida, TCO/BI y adaptador Paycomet.
- `korum-security-gov-engineer`: Seguridad anti-fraude, Auth/RBAC, Doble Firma criptográfica, QR HMAC, Sorteo CSPRNG y cumplimiento AEAT (Modelo 182 / Veri\*factu).
- `korum-family-viral-builder`: Frontend Mobile-First (`430px`) de Entorno 0 (Landing/Auth) y Entorno 1 (Familias, Checkout 10s, Comercios, Mi Hucha y WhatsApp `next/og`).
- `korum-backoffice-bi-builder`: Frontend de Entorno 2 (Panel Colegio/AFA/Club, Estudio Dual, Liquidaciones y Modo Portería QR) y Entorno 3 (Consola BI Super-Admin).
- `korum-brand-visual-director`: Dirección de Identidad Corporativa (*Escudo Ágora-K*), activos SVG fiduciarios, jerarquía visual dual (seriedad bancaria + emoción de patio), cartelería A4 y pases QR.

### 2.4 Subagentes Independientes del War Room (*Auditors* — Solo Lectura + Ejecución de Tests)
- `fintech-escrow-auditor`: Auditoría matemática al céntimo, Ledger, Paycomet PSD2 y Veri\*factu.
- `antifraud-legal-guardian`: Auditoría de seguridad, aislamiento Multi-Tenant (IDOR), Doble Firma, candado `\b`, QR HMAC y AEAT/RGPD.
- `ux-school-director-reviewer`: Auditoría UX Mobile-First (`430px`), multi-verticalidad, copywriting inmutable y paridad 1:1 con `Korum_v8.html`.
- `qa-e2e-verifier`: Ejecución objetiva de las 5 puertas QA (`verify-invariants`, `typecheck`, `test:unit`, `test:e2e` en `1440px` y `430px`, confianza `>= 95%`).

---

## 3. Comandos Estándar del Proyecto

- **Escáner determinista de invariantes y cero placeholders:** `npm run verify:invariants`
- **Desarrollo local:** `npm run dev`
- **Verificación estricta TypeScript:** `npm run typecheck`
- **Tests unitarios y de concurrencia (Vitest):** `npm run test:unit`
- **Tests E2E Desktop (`1440px`) + Mobile (`430px`) (Playwright):** `npm run test:e2e`
- **Migración y semilla verificada:** `npx prisma migrate dev --schema=schema/schema.prisma && npx prisma db seed`
