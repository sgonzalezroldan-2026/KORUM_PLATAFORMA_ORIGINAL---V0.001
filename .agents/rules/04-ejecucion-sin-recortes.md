# Regla 04 · Protocolo de Ejecución Atómica, Cero Recortes y Bucle Cerrado QA (`0` Fallos)

## 1. Prohibición Absoluta de Código Truncado o Placeholders
Está terminantemente prohibido escribir comentarios de omisión o tipos laxos en el código generado:
- Prohibido `// ... resto del código aquí`, `// TODO`, `// FIXME`, `/* mantener igual */`.
- Prohibido `any` sin justificación tipada o `Float` para importes monetarios.
Todo archivo creado o editado debe ser 100% funcional, completo y compilable de la línea 1 a la última.

## 2. Dimensionamiento Óptimo y Orquestación de Agentes
1. **Alcance Calibrado por Entrega:** Aborda **1 único Micro-Sprint** de `docs/PLAN_IMPLEMENTACION_ATOMICO.md` por entrega (salvo petición expresa del usuario de encadenar varios), manteniendo cada entrega en su ventana óptima (`4–8` archivos cohesivos, `~600–1.050` líneas de código de producción + su suite de tests automatizados).
2. **Carga Previa de Skills Especializadas:** Antes de escribir código en un sprint, activa y lee siempre las Skills indicadas en la cabecera de ese Micro-Sprint (incluyendo el índice de líneas exactas de `prototype/Korum_v8.html` en `korum-nextjs-multitenant-ui` cuando toques UI).
3. **Partición Modular Preventiva:** Si un componente o servicio supera las **300 líneas**, divídelo en submódulos cohesivos de responsabilidad única y escríbelos secuencialmente con `write_file` / `edit_file`.
4. **Separación Estricta Constructor vs. Auditor:** Quien audita nunca es el mismo contexto que escribió sin revisar; utiliza los subagentes *Builders* para tareas modulares aislando rutas de archivos, y somete siempre la entrega a los subagentes independientes del **War Room**.

## 3. Las 5 Puertas Obligatorias y Bucle Cerrado de Auto-Corrección ("Fix-and-Retest Loop")
Ningún Micro-Sprint puede entregarse al usuario ni marcarse como `[x]` sin superar al **100% (`0` fallos)** estas **5 puertas objetivas**:
- **Puerta 1 (Estática e Invariantes):** `node .agents/skills/korum-qa-harness-gatekeeper/scripts/verify-invariants.mjs` (`0` violaciones) + `npm run typecheck` (`0` errores TS).
- **Puerta 2 (Tests Unitarios / Concurrencia / Fuzzing):** `npm run test:unit` (`Vitest`) al `100%` en verde.
- **Puerta 3 (Auditoría Especializada War Room):** Dictamen `APROBADO` de los subagentes de dominio requeridos por el sprint (`fintech-escrow-auditor`, `antifraud-legal-guardian`, `ux-school-director-reviewer`).
- **Puerta 4 (Pruebas Automatizadas E2E + Agente Usuario en Navegador Real):** En todo sprint con UI (`Sprint 1.1` y `Sprints 3.1–5.4`), `qa-e2e-verifier` ejecuta tanto la suite repetible `npm run test:e2e` (`Playwright`) como navegación interactiva real mediante `playwright-browser` MCP en `1440x900` (Desktop) y `430x932` (Mobile: `scrollWidth <= 430` y `.mobile-stack`), verificando clics, formularios, capturas visuales y `0` errores de consola.
- **Puerta 5 (Iteración Automática ante Fallos y No-Regresión Global):** **Si cualquiera de las puertas 1 a 4 detecta un fallo, está prohibido dar por cerrado el sprint:** el agente corrige la causa raíz de inmediato y **re-ejecuta desde cero las pruebas automatizadas y la prueba de usuario en navegador**, iterando las veces necesarias hasta lograr **`0` errores y `100%` de suites previas y nuevas en verde** antes de responder al usuario.
