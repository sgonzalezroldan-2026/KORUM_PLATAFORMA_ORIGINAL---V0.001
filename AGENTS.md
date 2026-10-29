# KORUM · Contexto maestro para asistentes de IA

> **Eslogan:** *"Donde las buenas ideas suman y se logran."*
> **Qué es:** plataforma SaaS multi-entidad para colegios (a través de su AMPA/AFA o de su titular), clubes deportivos base y entidades culturales. Une un buzón de ideas con quórum, campañas de mecenazgo "todo o nada", taquilla y rifas con QR, comercios amigos y Mi Hucha.
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
| Legal, privacidad y decisiones de negocio con impacto legal | [docs/CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md](docs/CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md) |
| Experiencia: recorridos, emails, estados, animaciones, accesibilidad, idiomas, métricas | [docs/EXPERIENCIA_DE_PRODUCTO.md](docs/EXPERIENCIA_DE_PRODUCTO.md) |
| Sprints, alcance y modelo de IA recomendado por sprint | [docs/PLAN_IMPLEMENTACION_ATOMICO.md](docs/PLAN_IMPLEMENTACION_ATOMICO.md) |
| Criterios de aceptación | [docs/QA_ACCEPTANCE_CRITERIA.md](docs/QA_ACCEPTANCE_CRITERIA.md) |
| Estado del proyecto y traspaso entre sesiones o modelos | [docs/BITACORA_SPRINTS.md](docs/BITACORA_SPRINTS.md) |
| Significado de cada término | [docs/GLOSARIO.md](docs/GLOSARIO.md) |
| Cómo trabajar con Claude Code o con Gemini, imágenes incluidas | [docs/GUIA_IA_CLAUDE_Y_GEMINI.md](docs/GUIA_IA_CLAUDE_Y_GEMINI.md) |
| Modelo de datos | [schema/schema.prisma](schema/schema.prisma) |

---

## 1. Arquitectura: Entorno 0 + 3 entornos operativos

1. **Entorno 0 · Marketing y acceso** (`/`, `/registro-comunidad`, `/login`): landing con buscador y calculadora, alta autónoma de entidades en 3 pasos y acceso por rol. Optimizado para buscadores, asistentes de IA y redes sociales.
2. **Entorno 1 · Portal público de familias, socios y comercios** (`/[orgSlug]`):
   - Iniciativas en `FUNDRAISING` (con *Matching 2x* opcional) y taquilla o rifas con QR, con tarjetas para WhatsApp (`next/og`).
   - Checkout en 10 segundos sin registro (solo email en modo invitado), grupos por vertical (13 cursos escolares, categorías deportivas o grupos culturales), aportación voluntaria a KORUM **desmarcada por defecto** y texto fiscal según `organization.ley49`.
   - Buzón de ideas con quórum y control antifraude en servidor (máximo 2 cuentas familiares por dispositivo).
   - Logros conseguidos (Antes / Después), comercios amigos por categoría (sin importes), FAQ y soporte.
   - **Mi Hucha**, según el modo configurado por el Super-Admin: aportación mensual programada (`PLEDGE`) o monedero custodiado por una entidad autorizada (`REGULATED_WALLET`). KORUM nunca guarda saldo propio.
3. **Entorno 2 · Panel de la entidad** (`/panel/[orgSlug]`):
   - Cuadro de mandos con línea de 6 estados, kit de medallas e ID de hucha `WLT-ESC-XXX`.
   - **Doble firma mancomunada real** entre dos personas distintas: `DIRECTOR` (gestión principal) y `COSIGNER` (Presidencia del AMPA/AFA, Tesorería del club, Representación del patronato…), para aprobar ideas y para liberar fondos.
   - Estudio de edición con pizarra TCO cuadrada al céntimo (presupuesto con proveedor libre, o taquilla/rifa con aviso normativo).
   - Liquidaciones con factura del proveedor, fotos Antes/Después, redimensionamiento o reembolso del 100 %.
   - **Modo portería** (`/panel/[orgSlug]/porteria`) con PIN por evento, escáner QR y sorteo certificado; exportación del Modelo 182 y cartel A4 con QR.
4. **Entorno 3 · Consola del Super-Admin** (`/admin`):
   - Cuadro de mandos con ingresos reales (libro mayor) frente a proyectados, 6 fuentes de ingresos, tablas ordenables y alertas 💎 Auto-Impulso / 🚨 Retorno negativo.
   - Ficha 360º de cada entidad, facturas Veri\*factu, motor de reglas globales, medallas y bandeja de soporte.
   - **Ajustes de la plataforma** (`/admin/ajustes`): credenciales de Paycomet, email, Veri\*factu, modo de Mi Hucha, divulgación del Auto-Impulso, textos legales y límites.

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
| [korum-ticketing-qr](.agents/skills/korum-ticketing-qr/SKILL.md) | Entradas, rifas, QR firmados, portería y sorteo |
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

- `fintech-escrow-auditor`: matemática al céntimo, libro mayor, Paycomet y Veri\*factu.
- `antifraud-legal-guardian`: seguridad, aislamiento entre entidades, doble firma, QR, fiscalidad y RGPD.
- `ux-school-director-reviewer`: experiencia móvil, accesibilidad, idiomas, textos y paridad funcional con el prototipo.
- `qa-e2e-verifier`: ejecución de las 5 puertas; aprueba solo con el 100 % en verde.

---

## 3. Protocolo de cada sprint (resumen de la Regla 04)

1. Leer [docs/BITACORA_SPRINTS.md](docs/BITACORA_SPRINTS.md) y la ficha del sprint.
2. **Decir al usuario qué modelo de IA y qué nivel de esfuerzo recomienda la ficha** y, si no coinciden con la sesión actual, preguntar antes de seguir.
3. Cargar las skills de la ficha, construir, pasar las 5 puertas y actualizar la bitácora.
4. Terminar indicando el siguiente sprint y su modelo recomendado.

---

## 4. Comandos (disponibles desde el Sprint 1.1)

- Invariantes y coherencia documental: `node .agents/skills/korum-qa-harness-gatekeeper/scripts/verify-invariants.mjs` (alias `npm run verify:invariants`)
- Regenerar la configuración de Claude Code a partir de `.agents/`: `node scripts/sync-ai-context.mjs` (comprobar sin escribir: `--check`)
- Desarrollo: `npm run dev`
- Tipos: `npm run typecheck` · Lint: `npm run lint`
- Tests unitarios (Vitest): `npm run test:unit`
- Tests E2E de escritorio (`1440px`) y móvil (`430px`) con accesibilidad (Playwright + axe): `npm run test:e2e`
- Migración y semilla: `npx prisma migrate dev && npx prisma db seed`

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
