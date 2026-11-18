# KORUM · Contexto maestro para asistentes de IA

> **Eslogan:** *"Donde las buenas ideas suman y se logran."*
> **Qué es:** plataforma SaaS multi-entidad para colegios (a través de su AMPA/AFA o de su titular), clubes deportivos base y entidades culturales. Une un buzón de ideas con quórum, campañas de mecenazgo "todo o nada", taquilla y vales con QR, comercios amigos y Mi Hucha.
> **Decidido y pendiente de construir (2026-11-18):** las rifas se retiran (Sprint 5.12) y llegan los vales (5.14); comercios en dos modos (5.16); IVA incluido y facturas (5.20); liquidación solo a la cuenta de la entidad (5.19); Auto-Impulso siempre visible y compensado en el reparto (5.21); Mi Hucha apagada al lanzar y sin monedero con saldo (5.15). Hasta su sprint, **el código hace lo anterior y no se adelanta la regla nueva**. Lista completa: [CUMPLIMIENTO §8](docs/CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md), decisiones 21 a 62; orden y fichas: [plan](docs/PLAN_IMPLEMENTACION_ATOMICO.md).
> **Principio de independencia:** KORUM nunca intermedia ni cobra comisiones a proveedores de obras o equipamiento; la entidad elige libremente.
> **Pagos:** los cobros, retenciones, repartos y devoluciones los ejecuta **PAYCOMET** (entidad de pago autorizada por el Banco de España). **KORUM es una plataforma tecnológica: no es un banco ni custodia fondos.**
> **Marca:** *Escudo Varsity Heritage* (azul marino `#101F38`, oro deportivo `#F59E0B`, esmeralda `#047857`) + experiencia *Cuaderno Vivo de Patio*. Sin frialdad bancaria. Detalle en [korum-brand-design-system](.agents/skills/korum-brand-design-system/SKILL.md).
> **Referencia funcional:** `prototype/Korum_v8.html` (qué hace la app, no cómo se ve). Índice por anclas estables en [korum-v8-anatomy.md](.agents/skills/korum-nextjs-multitenant-ui/references/korum-v8-anatomy.md).

---

## 0. Fuente única de verdad

Cada tema tiene **un documento que manda**. Los demás remiten a él en lugar de copiarlo. Si dos documentos se contradicen, manda el de esta tabla y el otro se corrige en el mismo sprint.

| Tema | Documento que manda |
| :--- | :--- |
| Visión, problema y modelo de ingresos | [docs/00_IDEA_DE_NEGOCIO_Y_VISION.md](docs/00_IDEA_DE_NEGOCIO_Y_VISION.md) |
| Cifras de negocio y supuestos | [docs/BUSINESS_CASE_Y_ROADMAP.md](docs/BUSINESS_CASE_Y_ROADMAP.md) |
| Funcionalidad por entorno y máquinas de estado | [docs/PRD_3_ENTORNOS_KORUM.md](docs/PRD_3_ENTORNOS_KORUM.md) |
| Landing, acceso por rol y alta de entidades | [docs/ARQUITECTURA_LANDING_Y_AUTH_MULTIRROL.md](docs/ARQUITECTURA_LANDING_Y_AUTH_MULTIRROL.md) |
| Stack, proveedores, infraestructura y ajustes de la consola | [docs/DECISIONES_TECNICAS.md](docs/DECISIONES_TECNICAS.md) |
| Legal, privacidad y decisiones de negocio con impacto legal (las valida el promotor) | [docs/CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md](docs/CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md) |
| Experiencia: recorridos, emails, estados, animaciones, accesibilidad, idiomas, métricas | [docs/EXPERIENCIA_DE_PRODUCTO.md](docs/EXPERIENCIA_DE_PRODUCTO.md) |
| Sprints, orden de ejecución, alcance, modelo de IA y duración estimada por sprint | [docs/PLAN_IMPLEMENTACION_ATOMICO.md](docs/PLAN_IMPLEMENTACION_ATOMICO.md) |
| Criterios de aceptación | [docs/QA_ACCEPTANCE_CRITERIA.md](docs/QA_ACCEPTANCE_CRITERIA.md) |
| Estado del proyecto y traspaso entre sesiones o modelos | [docs/BITACORA_SPRINTS.md](docs/BITACORA_SPRINTS.md) |
| Deuda y puntos abiertos (qué queda, quién lo hace y en qué sprint se resuelve; el orden de ejecución está en el plan) | [docs/REGISTRO_DEUDA_Y_PUNTOS_ABIERTOS.md](docs/REGISTRO_DEUDA_Y_PUNTOS_ABIERTOS.md) |
| Significado de cada término | [docs/GLOSARIO.md](docs/GLOSARIO.md) |
| Cómo trabajar con Claude Code o con Gemini, imágenes incluidas | [docs/GUIA_IA_CLAUDE_Y_GEMINI.md](docs/GUIA_IA_CLAUDE_Y_GEMINI.md) |
| Modelo de datos | [schema/schema.prisma](schema/schema.prisma) |

---

## 1. Arquitectura: Entorno 0 + 3 entornos operativos

1. **Entorno 0 · Marketing y acceso** (`/`, `/registro-comunidad`, `/login`): landing con buscador y calculadora, alta autónoma de entidades en 3 pasos y acceso por rol. Optimizado para buscadores, asistentes de IA y redes sociales.
2. **Entorno 1 · Portal público de familias, socios y comercios** (`/[orgSlug]`):
   - Iniciativas en `FUNDRAISING` (con *Matching 2x* opcional) y taquilla con QR (las rifas se retiran en el Sprint 5.12 y los vales llegan en el 5.14), con tarjetas para WhatsApp (`next/og`).
   - Checkout en 10 segundos sin registro (solo email en modo invitado), grupos por vertical (13 cursos escolares, categorías deportivas o grupos culturales), aportación voluntaria a KORUM **desmarcada por defecto** y texto fiscal según `organization.ley49`.
   - Buzón de ideas con quórum y control antifraude en servidor (máximo 2 cuentas familiares por dispositivo).
   - Logros conseguidos (Antes / Después), comercios amigos por categoría (sin importes), FAQ y soporte.
   - **Mi Hucha**: aportación mensual programada (`PLEDGE`). **Sale apagada en el lanzamiento** y la enciende el Super-Admin; el monedero con saldo (`REGULATED_WALLET`) queda descartado y se retira del código en el Sprint 5.24b. KORUM nunca guarda saldo.
3. **Entorno 2 · Panel de la entidad** (`/panel/[orgSlug]`):
   - Cuadro de mandos con línea de 6 estados, kit de medallas e ID de hucha `WLT-ESC-XXX`.
   - **Doble firma mancomunada real** entre dos personas distintas: `DIRECTOR` (gestión principal) y `COSIGNER` (Presidencia del AMPA/AFA, Tesorería del club, Representación del patronato…), para aprobar ideas y para liberar fondos. **La entidad elige** si exige las dos firmas (por defecto) o una sola, la de `DIRECTOR`, bajo su responsabilidad (`Organization.signatureMode`); cambia a sus firmantes y su modo de firma **ella misma, al instante y sin el Super-Admin**, con aviso por email y registro de auditoría que no puede borrar.
   - Estudio de edición con pizarra TCO cuadrada al céntimo (presupuesto con proveedor libre, taquilla o, desde el Sprint 5.14, venta de vales).
   - Liquidaciones a la cuenta verificada de la entidad, con la factura de su proveedor adjunta, fotos Antes/Después, redimensionamiento o reembolso del 100 %.
   - **Modo portería** (`/panel/[orgSlug]/porteria`) con PIN por evento y escáner QR (el sorteo se retira con las rifas en el Sprint 5.12; el puesto de canje de vales llega en el 5.14c); exportación del Modelo 182 y cartel A4 con QR.
   - **Registro de actividad** (`/panel/[orgSlug]/auditoria`): lo ocurrido en la entidad, solo lo suyo y sin nombres ajenos, y el expediente en PDF de sus campañas y liquidaciones.
4. **Entorno 3 · Consola del Super-Admin** (`/admin`):
   - Cuadro de mandos con ingresos reales (libro mayor) frente a proyectados, 6 fuentes de ingresos, tablas ordenables y alertas 💎 Auto-Impulso / 🚨 Retorno negativo.
   - Ficha 360º de cada entidad, facturas Veri\*factu, motor de reglas globales, medallas y bandeja de soporte.
   - **Ajustes de la plataforma** (`/admin/ajustes`): credenciales de Paycomet, email, Veri\*factu, modo de Mi Hucha, textos legales y límites (el ajuste de divulgación del Auto-Impulso desaparece en el Sprint 5.21).
   - **Auditoría** (`/admin/auditoria`): quién hizo qué, cuándo y desde dónde, con búsqueda por persona, entidad, campaña, acción y fechas, y el expediente exportable en PDF de una aportación, una campaña o una liquidación (cuadrado con el libro mayor y sin datos personales de más).

---

## 2. Reglas, skills y subagentes

### 2.1 Reglas permanentes (se aplican siempre)

- [01 · Arquitectura y código](.agents/rules/01-arquitectura-y-codigo.md)
- [02 · Invariantes financieros](.agents/rules/02-invariantes-financieros.md)
- [03 · UX, idiomas, accesibilidad y textos](.agents/rules/03-ux-mobile-y-copywriting.md)
- [04 · Ejecución por sprints y QA](.agents/rules/04-ejecucion-sin-recortes.md)

### 2.2 Skills (se cargan según el sprint)

| Skill | Cuándo |
| :--- | :--- |
| [korum-tco-calculator](.agents/skills/korum-tco-calculator/SKILL.md) | Presupuestos, exenciones, medallas, BI y alertas |
| [korum-escrow-payments](.agents/skills/korum-escrow-payments/SKILL.md) | Paycomet, libro mayor, Mi Hucha, reembolsos, liquidaciones, Veri\*factu |
| [korum-quorum-antifraud](.agents/skills/korum-quorum-antifraud/SKILL.md) | Buzón de ideas, doble firma, candado semántico, fiscalidad y RGPD |
| [korum-ticketing-qr](.agents/skills/korum-ticketing-qr/SKILL.md) | Entradas, vales, QR firmados y portería |
| [korum-fiscal-invoicing](.agents/skills/korum-fiscal-invoicing/SKILL.md) | IVA incluido, facturas, Veri\*factu, certificados y Modelo 182 |
| [korum-nextjs-multitenant-ui](.agents/skills/korum-nextjs-multitenant-ui/SKILL.md) | Cualquier vista, layout o Server Action |
| [korum-qa-harness-gatekeeper](.agents/skills/korum-qa-harness-gatekeeper/SKILL.md) | Cierre de cada sprint (5 puertas) |
| [korum-brand-design-system](.agents/skills/korum-brand-design-system/SKILL.md) | Marca, tokens, activos visuales e imágenes |
| [korum-seo-discoverability](.agents/skills/korum-seo-discoverability/SKILL.md) | Metadatos, robots, sitemap, datos estructurados, tarjetas sociales y buscadores de IA |

### 2.3 Subagentes constructores y especialistas (`.agents/agents/`)

- `korum-core-fintech-architect`: backend financiero, Prisma, libro mayor, TCO/BI, adaptador Paycomet, tareas programadas.
- `korum-security-gov-engineer`: autenticación y roles, antifraude, doble firma, QR, portería, fiscalidad, privacidad y ajustes cifrados.
- `korum-family-viral-builder`: interfaz del Entorno 0 y del Entorno 1.
- `korum-backoffice-bi-builder`: interfaz del Entorno 2 y del Entorno 3.
- `korum-brand-visual-director`: marca, activos SVG, cartelería, pases QR, tarjetas sociales e imágenes.
- `korum-community-target-psychologist`: psicología de familias y entidades, microcopy, recorridos y momentos de celebración.
- `korum-seo-discoverability-specialist`: SEO técnico, indexación en buscadores y asistentes de IA, y vista previa en redes.

### 2.4 Subagentes auditores del *War Room* (solo lectura + tests)

- `korum-legal-fiscal-prereviewer`: prerrevisión legal y fiscal de textos, puntos abiertos y cambios con impacto legal o fiscal; propone, y **decide y valida el promotor**.
- `fintech-escrow-auditor`: matemática al céntimo, libro mayor, Paycomet y Veri\*factu.
- `antifraud-legal-guardian`: seguridad, aislamiento entre entidades, doble firma, QR, fiscalidad y RGPD.
- `ux-school-director-reviewer`: experiencia móvil, accesibilidad, idiomas, textos y paridad funcional con el prototipo.
- `qa-e2e-verifier`: ejecución de las 5 puertas; aprueba solo con el 100 % en verde.

---

## 3. Protocolo de cada sprint (resumen de la Regla 04)

1. Leer [docs/BITACORA_SPRINTS.md](docs/BITACORA_SPRINTS.md) y la ficha del sprint.
2. **Decir al usuario qué modelo de IA, qué nivel de esfuerzo y qué duración estimada indica la ficha** y, si el modelo no coincide con la sesión actual, preguntar antes de seguir. Las dudas para terceros (abogado, asesoría, Paycomet, Veri\*factu) se plantean primero al promotor.
3. Cargar las skills de la ficha, construir, pasar las 5 puertas y actualizar la bitácora.
4. Terminar sin deuda nueva (lo que no quepa, al registro con su sprint) e indicando el siguiente sprint, su modelo y su duración.

---

## 4. Comandos (disponibles desde el Sprint 1.1)

- Invariantes y coherencia documental: `node .agents/skills/korum-qa-harness-gatekeeper/scripts/verify-invariants.mjs` (alias `npm run verify:invariants`)
- Regenerar la configuración de Claude Code a partir de `.agents/`: `node scripts/sync-ai-context.mjs` (comprobar sin escribir: `--check`)
- Desarrollo: `npm run dev`
- Tipos: `npm run typecheck` · Lint: `npm run lint`
- Tests unitarios (Vitest): `npm run test:unit`
- Tests de integración con PostgreSQL real (libro mayor, triggers, concurrencia): `npm run test:integration` (base local sin Docker: `npm run db:dev`)
- Tests E2E de escritorio (`1440px`) y móvil (`430px`) con accesibilidad (Playwright + axe): `npm run test:e2e` (necesitan la base local de `npm run db:dev` o `E2E_DATABASE_URL`, mucho más rápida con un PostgreSQL 16 real en UTC, ver DECISIONES_TECNICAS §3: crean, migran y siembran su propio esquema `korum_e2e`; para certificar, mejor contra la compilación de producción con `CI=1`)
- Alta del primer Super-Admin: `npm run superadmin:bootstrap` (invita a `SUPERADMIN_BOOTSTRAP_EMAIL` si aún no hay ninguno)
- Migraciones: `npm run db:migrate` (aplica `prisma/migrations/`); las migraciones del libro mayor se escriben a mano y el escáner vigila que no se pierdan sus triggers. Datos de demostración: `npm run db:seed` (idempotente, ~25 s en la base local; nunca en producción real; sus fechas se calculan respecto al día de la carga y, en una base ya sembrada, se conservan las de la primera carga: para renovarlas, `npm run db:reset`) y `npm run db:reset` (borra la base, migra y siembra; ambos solo en bases locales o de demostración y nunca con `PAYCOMET_MODE=live`, vigilado por `seed-guard`). Los E2E en modo CI (`CI=1`, sobre `npm run build`) necesitan compilar con `NEXT_PUBLIC_DEMO_MODE=true`, como hace el CI: sin eso la galería `/dev/ui` no existe en la compilación

---

## 5. Dónde vive la configuración de cada asistente

- **Fuente canónica (se edita aquí):** `AGENTS.md`, `.agents/rules/`, `.agents/skills/`, `.agents/agents/`.
- **Claude Code:** `CLAUDE.md` importa este archivo y las reglas; `.claude/skills/` y `.claude/agents/` se **generan** con `node scripts/sync-ai-context.mjs` (no se editan a mano); servidores MCP en `.mcp.json`.
- **Gemini (Antigravity):** `GEMINI.md` + este archivo + `.agents/`; servidores MCP en `.agents/mcp_config.json`.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
