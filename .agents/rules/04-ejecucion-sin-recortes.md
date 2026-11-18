# Regla 04 · Protocolo de Ejecución por Sprints, Cero Recortes y Bucle QA

> Válida para cualquier asistente (Claude Code o Gemini/Antigravity). Diferencias de herramientas entre ambos: [docs/GUIA_IA_CLAUDE_Y_GEMINI.md](../../docs/GUIA_IA_CLAUDE_Y_GEMINI.md).

## 1. Prohibido el código incompleto

- Prohibido `// ... resto del código`, `// TODO`, `// FIXME`, `/* mantener igual */` o equivalentes.
- Prohibido `any` sin justificación tipada y `Float` para importes.
- Todo archivo creado o editado es funcional, completo y compila de la primera a la última línea.

## 2. Antes de empezar un sprint (obligatorio, en este orden)

1. **Leer el estado:** [docs/BITACORA_SPRINTS.md](../../docs/BITACORA_SPRINTS.md) (qué se hizo, qué quedó pendiente, decisiones tomadas) y la ficha del sprint en [docs/PLAN_IMPLEMENTACION_ATOMICO.md](../../docs/PLAN_IMPLEMENTACION_ATOMICO.md).
2. **Avisar al usuario del modelo recomendado y de la duración.** Indica el modelo de IA y el nivel de esfuerzo que la ficha del sprint recomienda (línea `🤖`), **la duración estimada de la sesión (línea `⏱️`) y cuánto tiempo del promotor hará falta** y, si el modelo de la sesión actual no coincide, dilo y pregunta si continuar o cambiar antes de escribir código. No adivines el modelo de la sesión: si no lo sabes, pregúntalo.
3. **Cargar las skills** que indica la ficha del sprint (y la anatomía del prototipo si el sprint toca interfaz).
4. **Preguntas a terceros, primero al promotor (decisión del 2026-11-18).** Toda duda que parezca para el abogado, la asesoría fiscal, Paycomet o un proveedor de Veri\*factu **se le plantea primero al promotor**, con el formato «qué pasa hoy, ejemplo, opciones, recomendación». Lo que él decide lo valida él. Solo si no puede resolverla se anota en [CONSULTAS_ABOGADO_ASESORIA_PAYCOMET.md](../../docs/CONSULTAS_ABOGADO_ASESORIA_PAYCOMET.md), con lo que se supone mientras tanto. Ningún documento vuelve a decir «pendiente del abogado» o «de la asesoría» sin esa conversación.
5. **Comprobar las dependencias externas** que indique la ficha (credenciales, decisiones legales pendientes). Si falta algo bloqueante, se para y se avisa; no se simula en silencio. Excepción: lo que figura en «Tareas externas aplazadas» del plan (respuestas de Paycomet, abogado, asesoría fiscal, proveedor Veri\*factu) **se construye contra el simulador por decisión del promotor**; en ese caso se anota en la bitácora la suposición usada y se recuerda que bloquea el paso a cobros reales.

## 3. Tamaño de cada entrega y reparto de trabajo

1. **Un único sprint por entrega**, salvo que el usuario pida encadenar varios. Cada entrega: `4–8` archivos cohesivos, `~600–1.050` líneas de producción + sus tests.
2. **Partición preventiva:** si un componente o servicio supera las **300 líneas**, se divide en submódulos de responsabilidad única.
3. **Constructor y auditor son contextos distintos:** quien escribe no se audita a sí mismo. Las auditorías las hacen los subagentes del *War Room* indicados en la ficha. Si es posible, el auditor usa **otro modelo** que el constructor (ver la guía de IA).
4. **Imágenes:** si el sprint necesita una imagen que no sea vectorial o generada por código, sigue la sección de imágenes de la guía de IA: Claude produce SVG, CSS o imágenes por código; las imágenes fotográficas o ilustradas en mapa de bits se generan con el modelo de imagen de Gemini. Si el modelo de la sesión no puede generarla, deja escrito el *prompt* exacto y el destino del archivo, y avisa al usuario.

## 4. Las 5 puertas y el bucle de corrección

Ningún sprint se entrega ni se marca `[x]` sin superar al **100 % (`0` fallos)**:

- **Puerta 1 · Estática e invariantes:** `node .agents/skills/korum-qa-harness-gatekeeper/scripts/verify-invariants.mjs` (`0` violaciones) + `npm run typecheck` (`0` errores) + `npm run lint`.
- **Puerta 2 · Tests unitarios, de integración, concurrencia y fuzzing:** `npm run test:unit` y `npm run test:integration` (PostgreSQL real: en local, `npm run db:dev`; en CI, el servicio `postgres`) al `100 %`.
- **Puerta 3 · War Room:** dictamen `APROBADO` de los auditores indicados en la ficha.
- **Puerta 4 · Navegador real** (todo sprint con interfaz): `qa-e2e-verifier` ejecuta `npm run test:e2e` (Playwright, `1440×900` y `430×932`, incluida la comprobación de accesibilidad con axe) y además navega la app como una persona usuaria real con el **servidor MCP de Playwright**, revisando clics, formularios, capturas y `0` errores de consola.
- **Puerta 5 · Bucle de corrección y no regresión (decisión del promotor, 2026-11-17: repetición por niveles + una pasada final completa):** si cualquier puerta falla, se corrige la causa raíz y se repite así:
  1. **Siempre completas, tras cada corrección** (son baratas): Puerta 1 (invariantes, `typecheck`, `lint`) y `npm run test:unit`.
  2. **Solo el área afectada y sus vecinas** (archivos cambiados y lo que depende de ellos): la integración, los E2E, el recorrido manual con MCP y el auditor que falló. El asistente anota en la bitácora qué repitió y por qué.
  3. **Pasada final completa, una sola vez**, cuando ya no quedan correcciones pendientes: **todas las puertas desde la 1** (integración completa, E2E completo en escritorio y móvil, recorrido manual y todos los auditores de la ficha). Si esa pasada final encuentra algo, se corrige, se repiten los niveles 1 y 2 y se hace **otra pasada final completa**.
  - El sprint se cierra solo con `0` errores y el `100 %` de las suites (nuevas y anteriores) en verde **en la pasada final completa**. Una corrección que toque dinero, seguridad o un componente compartido por muchas pantallas amplía el nivel 2 a lo que dependa de ella.

## 5. Al cerrar un sprint (obligatorio)

1. Marca `[x]` en el plan y añade una entrada en [docs/BITACORA_SPRINTS.md](../../docs/BITACORA_SPRINTS.md): modelo y esfuerzo usados, **duración real de la sesión**, archivos creados, decisiones, pendientes y resultado de las 5 puertas.
2. **Sin deuda nueva (decisión del promotor, 2026-11-18).** Lo que aparezca durante el sprint se corrige dentro de él. Si de verdad no cabe, se añade a [docs/REGISTRO_DEUDA_Y_PUNTOS_ABIERTOS.md](../../docs/REGISTRO_DEUDA_Y_PUNTOS_ABIERTOS.md) **con un sprint de destino concreto** y se le dice al promotor al cerrar: prohibido dejar «heredados» sin sprint. Los puntos que el sprint resuelve se marcan en el registro y en su documento de origen (CUMPLIMIENTO §9, DECISIONES §8).
3. Si has cambiado algo en `.agents/` (reglas, skills o agentes), ejecuta `node scripts/sync-ai-context.mjs` para regenerar `.claude/`.
4. Propón un commit con un mensaje claro. Commitea solo si el usuario lo aprueba.
5. Termina indicando **el siguiente sprint y su modelo, esfuerzo y duración recomendados**.
