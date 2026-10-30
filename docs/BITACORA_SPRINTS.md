# Bitácora de sprints · KORUM

> Memoria compartida del proyecto. **Cada asistente (Claude o Gemini) la lee al empezar un sprint y añade una entrada al terminarlo** (Regla 04). Las entradas más recientes van arriba. No se borran entradas antiguas.

## Plantilla de entrada

```markdown
### Sprint X.Y — Título · AAAA-MM-DD · ESTADO (terminado / en curso / bloqueado)

- **Modelo y esfuerzo usados:** (p. ej. Claude Sonnet 5.5 · alto; auditoría Claude Opus 5.5 · alto)
- **Qué se ha hecho:** archivos creados o modificados y funcionalidad entregada.
- **Decisiones tomadas:** y por qué (si cambian un documento que manda, enlazarlo).
- **Pendiente / deuda:** lo que queda y en qué sprint se resuelve.
- **Puertas:** P1 ✅/❌ · P2 ✅/❌ · P3 ✅/❌ (auditores) · P4 ✅/❌ · P5 ✅/❌
- **Siguiente sprint:** X.Z · modelo recomendado: …
```

---

## Entradas

### Sprint 1.2 — Libro mayor de doble partida, cliente Prisma y cupos reversibles · 2026-10-30 · terminado

- **Modelo y esfuerzo usados:** constructor Claude Opus 5.5 (esfuerzo recomendado extra alto; el asistente no puede leer el configurado). Auditoría: `fintech-escrow-auditor` (Opus) y `qa-e2e-verifier` (Sonnet).
- **Qué se ha hecho:**
  - **Migraciones** en `prisma/migrations/`:
    - `init`: se genera desde el esquema.
    - `ledger_immutability`: impide `UPDATE`/`DELETE`/`TRUNCATE` en asientos, apuntes y auditoría; comprueba el cuadre al confirmar; `CHECK amountCents > 0`, solo EUR y enlace de los contra-asientos.
    - `ledger_append_guard`: ningún apunte puede añadirse a un asiento ya registrado; claves foráneas en las dimensiones; instantánea de cupos y curso.
  - **Cliente y servicios:**
    - `src/lib/prisma.ts`: adaptador `pg`, cliente perezoso y extensión `korum-append-only`. `src/lib/db.ts`: tipo `Db`, `inTransaction`.
    - `money.ts`: `parseEurosToCents` y `bpsOf`, exactos con `BigInt`.
    - `ledger-accounts.ts`: plan de cuentas con naturaleza y dimensiones obligatorias. `ledger-validation.ts`: validación pura.
    - `ledger.service.ts`: `postJournal` idempotente y `reverseJournal`. `ledger-balances.ts`: saldos por cuenta y dimensión, y balance de sumas.
    - `quota-reservation.ts`: reserva y liberación de cupos (QA-FIN01).
  - **Pruebas:**
    - `tests/integration/` contra PostgreSQL real en un esquema aislado `korum_test`, que se recrea en cada ejecución. 42 pruebas: QA-C03, QA-FIN01 y todos los ataques de la auditoría.
    - Base local sin Docker: `npm run db:dev`. CI con un servicio `postgres:16`.
  - **Escáner:** comprueba que ninguna migración borra ni desactiva los triggers del libro mayor.
  - **Producción:** `prisma/sql/runtime-role.sql` crea un rol de ejecución sin privilegios, que se aplicará en el Sprint 6.1.
- **Decisiones tomadas:**
  - `formatCents`/`eurosToCents` de la ficha pasan a `formatCents`/`parseEurosToCents`.
  - Los saldos se separan en `ledger-balances.ts` para no superar 300 líneas.
  - La renovación anual de cupos (`Organization.quotaPeriod`) queda para el Sprint 2.4.
  - En local las pruebas usan 1 conexión porque PGlite (la base de `npm run db:dev`) mezcla mensajes de protocolo con varias.
- **Auditoría (Puerta 3):**
  - **Financiera:** rechazado a la primera, aprobado en la reauditoría. Los apuntes podían añadirse a un asiento ya confirmado: el auditor sumó 1.000 € a una hucha con SQL directo. Corregido con el sello de transacción.
  - **Defectos ya corregidos y probados:**
    - la reserva de cupos podía quedar marcada sin descuento si quien llamaba capturaba el error;
    - la liberación usaba el presupuesto actual en vez de lo reservado;
    - la idempotencia no comparaba las referencias de origen;
    - había una carrera en los contra-asientos;
    - los apuntes no tenían claves foráneas.
  - **QA:** aprobado; sus hallazgos coincidían con los anteriores.
- **Pendiente / deuda:**
  - **La concurrencia real solo la demuestra la CI con PostgreSQL 16, que aún no se ha ejecutado** (no hay repositorio remoto). Hasta entonces, QA-C03 queda verificado en funcionalidad pero no en «concurrencia real».
  - El rol `korum_app` bloquea el paso a producción (casilla de [DECISIONES_TECNICAS.md](DECISIONES_TECNICAS.md) §8).
  - La supresión RGPD (Sprints 2.5 y 3.7) debe anonimizar al usuario y no borrarlo: los apuntes tienen clave foránea `RESTRICT` hacia `User`.
  - `amountCents` es `Int`: máximo 21.474.836,47 € por apunte.
- **Puertas:**
  - P1 ✅: invariantes con 3 migraciones vigiladas, esquema, `typecheck` y `lint` a 0.
  - P2 ✅: 104 unitarias y 42 de integración, estables en 3 ejecuciones seguidas.
  - P3 ✅: financiera y QA aprobadas.
  - P4 ✅: el sprint no tiene interfaz; la no regresión del 1.1 pasa con 41 E2E en verde.
  - P5 ✅: todas las puertas repetidas tras cada corrección.
- **Siguiente sprint:** 1.3 · modelo recomendado: **Claude Sonnet 5.5 · esfuerzo alto** (alternativa: Gemini Argon · alto) · auditoría Claude Opus 5.5 · alto. Semilla completa con sus asientos y repositorios con aislamiento entre entidades.

### Sprint 1.1 — Proyecto Next.js, idiomas, primitivas de marca y arnés QA · 2026-10-29 · terminado

- **Modelo y esfuerzo usados:** constructor Claude Sonnet 5.5 (esfuerzo recomendado: alto; el asistente no puede leer el nivel configurado en la sesión). Auditoría: subagentes `ux-school-director-reviewer` y `qa-e2e-verifier` en Claude Sonnet 5.5.
- **Qué se ha hecho:**
  - **Proyecto:** `package.json` con versiones exactas (ver motivos en [DECISIONES_TECNICAS.md](DECISIONES_TECNICAS.md) §2), `tsconfig` estricto, `next.config.ts` con cabeceras de seguridad, `postcss`, ESLint (con la regla `react/jsx-no-literals`: ningún texto visible fuera de `messages/`), Vitest, Playwright (`desktop` 1440×900 y `mobile` 430×932, con axe), `docker-compose.yml` (PostgreSQL 16), `prisma.config.ts`, CI (`.github/workflows/ci.yml`) y Dependabot, `README.md`, servidor MCP de Prisma en `.mcp.json` y `.agents/mcp_config.json`.
  - **Entorno:** `src/config/env.ts` (Zod) + `src/instrumentation-node.ts`: el servidor **se detiene** al arrancar si falta una variable crítica, con un mensaje que las nombra todas. `npm run setup:env` genera `.env.local` con los secretos.
  - **Idiomas:** `next-intl` con `es` (sin prefijo), `ca` y `en`; catálogos con las mismas claves (comprobado por test); **la URL decide el idioma** (sin redirección por el navegador ni cookie).
  - **Diseño:** `globals.css` con los tokens de marca en `@theme` de Tailwind 4 y las clases `.korum-paper-dots`, `.korum-court-grid`, `.korum-notebook-sheet`, `.die-cut-sticker`, `.tactile-btn`, `.korum-trust-vault`, `.korum-stamp-badge`, `.varsity-patch` y `.mobile-stack`.
  - **Marca provisional:** `KorumMarkSvg` (SVG puro, apto para `next/og`), `KorumMark`, `KorumLogo` e `icon.svg`, dibujados a partir de `korum-logo.jpg`, sin año ni subtítulo.
  - **Primitivas:** `CurrencyText` + `formatCents` (importes exactos en `es`/`ca`/`en`), `TrustBadge`, `DelayedTooltip` (1000 ms; WCAG 1.4.13), `ToastProvider`, `SortableTh` + `useSortableRows`, `StatusBadge` (9 estados), `LanguageSwitcher`, `EmptyState`, `Skeleton` y `LoadingRegion`; páginas base (`/`, 404 localizado, error) y galería interna `/dev/ui` (solo en desarrollo y en el entorno de demostración).
- **Decisiones tomadas:**
  - Prisma 7.10.1 (la 8 está en candidata), TypeScript 6.0.3 (la 7 no es compatible aún con `typescript-eslint`), ESLint 9.39.5 (los plugins de Next no llegan a la 10), Node ≥ 24.
  - **No hay `loading.tsx` en la raíz de `[locale]`:** hacía *streaming* y las URL inexistentes devolvían 200 (soft-404); además, con traducciones de servidor volvía dinámica toda la ruta. Reglas anotadas en la skill de interfaz.
  - `formatCents` se adelanta del Sprint 1.2 al 1.1 (lo necesita `CurrencyText`).
  - Sin `preload` en HSTS hasta la preproducción.
- **Pendiente / deuda:**
  - ESLint 9 figura como «sin soporte» en npm: subir a la 10 cuando `eslint-config-next` lo permita. TypeScript 7 igual.
  - `LanguageSwitcher` no conserva los parámetros de búsqueda (aún no hay filtros en la URL). El `<title>` del 404 es el de la portada (Next no admite metadata localizada en `not-found`).
  - El logotipo es provisional (el laurel es una aproximación); se sustituye por el vectorial definitivo cuando exista.
  - `docker compose` no se ha podido probar en esta máquina (no hay Docker); el servidor MCP de Prisma tampoco se ha ejercitado.
  - El esfuerzo de IA configurado en la sesión no es legible por el asistente: se pregunta al usuario cuando importa.
- **Puertas:** P1 ✅ (invariantes, esquema Prisma, `typecheck` y `lint` a 0; `npm audit` de producción: 0 vulnerabilidades) · P2 ✅ (83/83 unitarias) · P3 ✅ (QA: aprobado con reservas, sin bloqueantes, 2 importantes corregidas; UX: rechazado a la primera por el tooltip —WCAG 1.4.13—, **aprobado tras la corrección**) · P4 ✅ (41 pruebas de navegador pasan en escritorio y móvil con axe, tanto contra `next dev` como contra la compilación de producción; 3 omitidas a propósito: el retardo con ratón no aplica a táctil; más exploración manual a 1440, 430, 360 y 320 px por los auditores) · P5 ✅ (todas las puertas repetidas tras cada corrección).
- **Siguiente sprint:** 1.2 · modelo recomendado: **Claude Opus 5.5 · esfuerzo extra alto** (alternativa: Gemini Argon · alto) · auditoría Claude Opus 5.5 · alto. Es el libro mayor de doble partida: dinero, inmutabilidad y migración con triggers.

### Sprint 0.8 — Decisiones del promotor tras la revisión · 2026-10-29 · terminado

- **Modelo usado:** Claude Sonnet 5.5 (Claude Code).
- **Qué se ha hecho:**
  - **Gestiones externas aplazadas:** nueva sección «Tareas externas aplazadas» en el plan (Paycomet, abogado, asesoría fiscal, proveedor Veri\*factu, `REGULATED_WALLET`), con qué se hace mientras tanto y dónde bloquean (Sprints 6.1 y 6.2). Anotado en el documento legal (§2, §9 y decisiones 11–13), el business case, la Regla 04 y las dependencias `⛓️` de los sprints 2.1, 4.4, 5.6 y 6.1.
  - **Logotipo y sello:** cerrados como descartados. El logotipo de referencia es la lámina `public/brand/korum-logo.jpg`; los SVG antiguos y el sello de custodia viven en `public/brand/_old/fase2_propuestas_descartadas/`. La skill de marca, su especificación SVG y la skill de interfaz se corrigen (el inventario citaba archivos que ya no existían) y el escáner comprueba ahora que todo archivo de `public/brand/` citado existe.
  - **Tramos, fee de Mi Hucha y comisiones configurables:** `GlobalConfig` gana `bracketMode` (`FLAT`/`MARGINAL`), `t1MaxCents`, `t2MaxCents` y `topupFeeBps`; tipos y semilla actualizados; `calculateBracketFeeCents` y la nueva **salud de precios** (`evaluatePricingHealth`, avisos `❗`/`⚠️` con «Ajustar» y «Aceptar y registrar») documentadas en la skill TCO §2.1 y en [DECISIONES_TECNICAS.md](DECISIONES_TECNICAS.md) §6.1; sprints 1.4, 5.1 y 5.3 y criterios `QA-FIN06` y `QA-A04` actualizados.
- **Decisiones tomadas:** los valores por defecto (`FLAT`, fee de Hucha `0,25 € + 0 %`) siguen siendo los del prototipo; con ellos la consola ya mostrará los avisos `HUCHA_FEE_BELOW_GATEWAY_COST` y `BRACKET_CLIFF`, a propósito, para que el Super-Admin decida con la cifra delante.
- **Pendiente / deuda:** el esquema se reformatea con `prisma format` en el Sprint 1.1 (cuando Prisma esté instalado); el lema opcional del logotipo queda abierto sin urgencia.
- **Puertas:** P1 ✅ (escáner de invariantes en verde). P2–P5 no aplican.

### Sprint 0.7 — Revisión documental para Claude y Gemini · 2026-10-29 · terminado

- **Modelo usado:** Claude Opus 5.5 (Claude Code).
- **Qué se ha hecho:**
  - **Marca unificada** en *Escudo Varsity Heritage*: eliminados los restos de la propuesta bancaria descartada en el contexto maestro, las skills y los agentes.
  - **Referencias al prototipo** convertidas en anclas estables con línea verificada automáticamente; cifras desfasadas eliminadas; duplicado de la matriz QA eliminado.
  - **Esquema de datos** corregido: libro mayor de doble partida real, organizaciones que se archivan en lugar de borrarse, estados como enum, titular legal de los fondos, KYB por estados, cifrado de NIF, tokens y secretos, modelos de autenticación (Better Auth), dispositivos, auditoría, webhooks, bandeja de salida, tareas programadas, ficheros, consentimientos y solicitudes RGPD, PIN de portería por evento, ventana de 90 días de Paycomet.
  - **Rol `COSIGNER`** en lugar del rol específico del AFA, con etiqueta de cargo por entidad.
  - **Documentos nuevos:** decisiones técnicas, cumplimiento legal y privacidad, experiencia de producto, guía de IA, glosario y esta bitácora.
  - **SEO:** skill `korum-seo-discoverability` y subagente `korum-seo-discoverability-specialist`.
  - **Plan** reorganizado (sprints nuevos de operación, privacidad, notificaciones, ajustes de la consola, pulido y piloto) con modelo de IA y esfuerzo recomendados en cada sprint.
  - **Claude Code:** `CLAUDE.md` con importaciones, `.claude/skills` y `.claude/agents` generados por `scripts/sync-ai-context.mjs`, `.mcp.json`; Antigravity: `GEMINI.md` y `.agents/mcp_config.json` actualizados.
  - **Escáner de invariantes** ampliado: coherencia de marca y roles, anclas del prototipo, línea `🤖` en cada sprint y sincronía de `.claude/`.
  - **Repositorio git** creado con el estado original como primer commit.
- **Decisiones tomadas:** ver [CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md](CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md) §8 y [DECISIONES_TECNICAS.md](DECISIONES_TECNICAS.md).
- **Pendiente para el promotor:**
  1. Respuestas por escrito de Paycomet (8 preguntas, legal §2).
  2. Abogado y asesoría fiscal (legal §9).
  3. Revisar dos propuestas: el nuevo texto de la aportación voluntaria (Regla 03 §3) y la devolución del 100 % incluida la aportación voluntaria (legal §8, decisión 9).
  4. Decidir el subtítulo multi-vertical del logotipo y el texto del sello (skill de marca §5) y el efecto escalón de los tramos (business case §5).
  5. Elegir el proveedor de facturación Veri\*factu antes del Sprint 2.3.
- **Puertas:** P1 ✅ (escáner de invariantes en verde). P2–P5 no aplican (sin código de aplicación todavía).
- **Siguiente sprint:** 1.1 · modelo recomendado: **Claude Sonnet 5.5 · esfuerzo alto** (alternativa: Gemini Argon · alto).
