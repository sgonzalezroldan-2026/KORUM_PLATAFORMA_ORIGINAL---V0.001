---
name: korum-qa-harness-gatekeeper
description: >-
  Arnés determinista de Aseguramiento de Calidad (5-Gate Definition of Done + Bucle Cerrado de
  Auto-Corrección) de KORUM: escáner verify-invariants.mjs, suites Vitest de fuzzing y concurrencia,
  suites Playwright E2E y simulación interactiva de usuario en navegador real (playwright-browser MCP)
  en Desktop (1440px) y Mobile (430px) iterando hasta alcanzar 0 errores antes de entregar.
---

# Skill · Arnés Determinista QA, Simulación de Usuario en Navegador y Bucle `0 Fallos`

Ningún Micro-Sprint de `docs/PLAN_IMPLEMENTACION_ATOMICO.md` puede presentarse como terminado al usuario sin superar al **100% (`0` fallos)** las **5 Puertas Objetivas** y todos sus criterios en `docs/QA_ACCEPTANCE_CRITERIA.md`.

## 1. Puerta 1 — Escáner Determinista de Invariantes
Ejecuta siempre antes y después de los tests:
```powershell
node .agents/skills/korum-qa-harness-gatekeeper/scripts/verify-invariants.mjs
```
Falla con código `1` si detecta: `Float` en Prisma, placeholders (`TODO`, `FIXME`, `// ...`), copy prohibido (`"propina"`, `"(Desactivado)"`), fugas `NEXT_PUBLIC_*` de secretos o `>= 1` céntimo de descuadre en `seed_data.json`.

## 2. Puerta 2 — Suites Automatizadas Unitarias, Fuzzing y Concurrencia (`Vitest`)
1. **Fuzzing Paramétrico TCO (`1.000` iteraciones deterministas):** verifica `finalGoalCents % 100 === 0` y `netGuaranteedCents + bracketFeeCents + maintFeeCents + gatewayFeeCents === finalGoalCents` (`0` céntimos de desviación en `1.000/1.000` casos).
2. **Concurrencia Atómica (`Promise.all`):** verifica ausencia total de sobreventa en las últimas entradas de taquilla y absorción idempotente de webhooks Paycomet duplicados.
3. **Regresión Semántica y Fiscal:** verifica `0` falsos positivos en `"sin cobrar"` / `"obra de teatro"` / `"sobras"` y exclusión total de `TOPUP` y `TICKET` en certificados IRPF y fichero `.BOE` del Modelo 182.

## 3. Puerta 4 — Doble Verificación en Navegador Real (Suite Playwright + Agente Interactuando en Vivo)
En todo Micro-Sprint con interfaz (`Sprint 1.1` y `Sprints 3.1–5.4`), la verificación en navegador consta de **dos capas complementarias**:
1. **Tests E2E Automatizados y Persistentes (`tests/e2e/*.spec.ts` vía `npm run test:e2e`):**
   - Quedan grabados en el repositorio para garantizar no-regresión perpetua en todos los sprints siguientes.
   - Ejecutan en `1440x900` (Desktop) y `430x932` (Mobile) verificando flujos completos, `0` errores `pageerror` / `console.error`, `document.documentElement.scrollWidth <= 430` y apilado vertical estricto en `.mobile-stack`.
2. **Prueba Exploratoria de Usuario Real por el Agente `qa-e2e-verifier` (`playwright-browser` MCP):**
   - El subagente abre la aplicación en vivo con `playwright_navigate`, redimensiona con `playwright_resize` (`1440x900` y `430x932`), hace clic, rellena formularios y abre modales como un usuario real (`playwright_click`, `playwright_fill`, `playwright_select`), lee `playwright_console_logs` y captura pantallas con `playwright_screenshot` (inspeccionándolas visualmente con `read_file`).

## 4. Puerta 5 — Bucle Cerrado de Auto-Corrección (`Fix ➔ Re-Test ➔ 0 Fallos`)
```text
[Construcción] ──► [G1 Invariantes + TS] ──► [G2 Vitest] ──► [G3 War Room] ──► [G4 Playwright + MCP Browser Vivo]
       ▲                                                                                     │
       └────────────── SI HAY >= 1 FALLO: Corregir causa raíz y RE-EJECUTAR TODO ◄───────────┘
```
Está prohibido entregar un sprint con fallos pendientes o pedir al usuario que depure manualmente un error reproducible: si cualquier puerta falla, se corrige el código y se **vuelve a ejecutar el ciclo completo (incluyendo re-probar en navegador)** hasta que el resultado sea `100% PASS / 0 Errores`.
