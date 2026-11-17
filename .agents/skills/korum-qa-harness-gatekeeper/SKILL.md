---
name: korum-qa-harness-gatekeeper
description: >-
  Arnés de calidad de KORUM (definición de terminado en 5 puertas + bucle de corrección): escáner
  verify-invariants.mjs (código, esquema, semilla y coherencia de la documentación), suites Vitest de
  fuzzing y concurrencia, suites Playwright E2E con accesibilidad (axe) y prueba de usuario real en
  navegador mediante el servidor MCP de Playwright, en escritorio (1440px) y móvil (430px), iterando
  hasta 0 errores antes de entregar.
---

# Skill · Arnés de calidad, prueba de usuario en navegador y bucle `0 fallos`

Ningún sprint de [docs/PLAN_IMPLEMENTACION_ATOMICO.md](../../../docs/PLAN_IMPLEMENTACION_ATOMICO.md) se presenta como terminado sin superar al **100 % (`0` fallos)** las 5 puertas y todos sus criterios de [docs/QA_ACCEPTANCE_CRITERIA.md](../../../docs/QA_ACCEPTANCE_CRITERIA.md).

## 1. Puerta 1 · Escáner determinista de invariantes

Se ejecuta antes y después de los tests:

```bash
node .agents/skills/korum-qa-harness-gatekeeper/scripts/verify-invariants.mjs
```

Falla con código `1` si detecta:

- **Código y esquema:** `Float` en Prisma; placeholders (`TODO`, `FIXME`, `// ...`); textos prohibidos (`"propina"`, `"(Desactivado)"`); secretos expuestos con `NEXT_PUBLIC_`; descuadres de `>= 1` céntimo en `seed_data.json`; archivos con doble extensión.
- **Libro mayor:** que las migraciones de `prisma/migrations/` siguen creando los triggers de inmutabilidad y de cuadre y el `CHECK (amountCents > 0)`, y que ninguna los borra ni los desactiva.
- **Coherencia de la documentación:** restos de la marca descartada; activos de `docs/brand/` citados que no existen; el nombre antiguo del rol de cofirmante (hoy `COSIGNER`); anclas de [korum-v8-anatomy.md](../korum-nextjs-multitenant-ui/references/korum-v8-anatomy.md) que ya no coinciden con su línea del prototipo; y `.claude/` desincronizado respecto a `.agents/` (se corrige con `node scripts/sync-ai-context.mjs`).

## 2. Puerta 2 · Tests unitarios, fuzzing y concurrencia (Vitest)

Dos suites: `npm run test:unit` (`tests/unit/`, jsdom, sin base de datos) y `npm run test:integration` (`tests/integration/`, Node, **PostgreSQL real**). La de integración recrea el esquema `korum_test` y aplica las migraciones en cada ejecución; nunca toca `public` y, fuera de la CI, solo acepta bases en `localhost`. En local la base la da `npm run db:dev` (Prisma Postgres local, sin Docker); en CI, el servicio `postgres:16`. Todo lo que dependa de triggers, restricciones o concurrencia real (libro mayor, cupos, aforo, webhooks) se prueba en integración.

1. **Fuzzing TCO (`1.000` iteraciones deterministas con semilla fija):** `finalGoalCents % 100 === 0` y `netGuaranteedCents + bracketFeeCents + maintFeeCents + gatewayFeeCents === finalGoalCents` en `1.000/1.000` casos.
2. **Libro mayor:** cada asiento cumple `Σ DEBIT === Σ CREDIT`; repetir la misma `idempotencyKey` devuelve el asiento existente; `update`/`delete` sobre asientos falla.
3. **Concurrencia (`Promise.all`):** sin sobreventa en las últimas entradas y sin doble abono ante webhooks duplicados.
4. **Regresión semántica y fiscal:** `0` falsos positivos en `"sin cobrar"`, `"obra de teatro"`, `"sobras"` (y sus equivalentes en catalán e inglés) y exclusión total de `TOPUP` y `TICKET` en certificados y en el Modelo 182.

## 3. Puerta 4 · Doble verificación en navegador real

En todo sprint con interfaz:

1. **Tests E2E persistentes** (`tests/e2e/*.spec.ts`, `npm run test:e2e`):
   - Proyectos `desktop` (`1440×900`) y `mobile` (`430×932`).
   - `0` errores `pageerror` / `console.error`, `document.documentElement.scrollWidth <= 430` y apilado vertical real en `.mobile-stack`.
   - **Accesibilidad:** `@axe-core/playwright` sin incidencias `serious` ni `critical` en cada página visitada.
   - **Idiomas:** las páginas tocadas se recorren al menos en `es` y en otro idioma (`ca` o `en`), sin claves de traducción sin resolver.
   - **Certificación (Sprint 5.6):** `full-lifecycle-journey.spec.ts` (`QA-X03`) hace el ciclo entero de una entidad en castellano y catalán con los textos del catálogo, y `tenant-intrusion.spec.ts` (`QA-SEC10`) ataca a otra entidad con todas las acciones de servidor del manifiesto de la compilación. Una pantalla o una acción nueva del ciclo se añade a estas dos pruebas; el censo de acciones solo corre contra la compilación de producción (`CI=1`). Los encabezados no se saltan niveles (`expectHeadingsInOrder`).
2. **Prueba exploratoria de `qa-e2e-verifier` con el servidor MCP de Playwright** (en Claude Code, servidor `playwright` de `.mcp.json`; en Antigravity, el de `.agents/mcp_config.json`):
   - Navega como una persona real (madre o padre invitado, familia registrada, comercio, gestor/a de la entidad, voluntario/a de portería, Super-Admin), redimensiona a `1440×900` y `430×932`, pulsa, rellena formularios y abre modales.
   - Revisa los mensajes de consola, mide `scrollWidth` con una evaluación en página y toma capturas para inspeccionarlas visualmente.

## 4. Puerta 5 · Bucle de corrección (`corregir ➔ repetir ➔ 0 fallos`)

```text
[Construcción] ──► [P1 invariantes + tipos + lint] ──► [P2 Vitest] ──► [P3 War Room] ──► [P4 Playwright + MCP]
       ▲                                                                                          │
       └─ SI HAY ≥ 1 FALLO: corregir la causa raíz ─► repetir P1+unitarias (siempre) + área afectada ◄──┘

[Sin correcciones pendientes] ──► PASADA FINAL COMPLETA (todas las puertas desde la 1, todos los auditores) ──► 0 fallos
```

Repetición por niveles (decisión del promotor, 2026-11-17, detalle en la Regla 04 §4): P1 y unitarias **siempre completas**; integración, E2E, recorrido manual y el auditor que falló, **solo el área afectada y sus vecinas**; y **una pasada final completa** antes de cerrar. Si esa pasada encuentra algo, se corrige y se hace otra completa.

Prohibido entregar un sprint con fallos pendientes o pedir al usuario que depure un error reproducible.
