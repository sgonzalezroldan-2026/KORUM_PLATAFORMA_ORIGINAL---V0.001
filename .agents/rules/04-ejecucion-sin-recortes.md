# Regla 04 · Protocolo de Ejecución por Sprints, Cero Recortes y Bucle QA

> Válida para cualquier asistente (Claude Code o Gemini/Antigravity). Diferencias de herramientas entre ambos: [docs/GUIA_IA_CLAUDE_Y_GEMINI.md](../../docs/GUIA_IA_CLAUDE_Y_GEMINI.md).

## 1. Prohibido el código incompleto

- Prohibido `// ... resto del código`, `// TODO`, `// FIXME`, `/* mantener igual */` o equivalentes.
- Prohibido `any` sin justificación tipada y `Float` para importes.
- Todo archivo creado o editado es funcional, completo y compila de la primera a la última línea.

## 2. Antes de empezar un sprint (obligatorio, en este orden)

1. **Leer el estado:** [docs/BITACORA_SPRINTS.md](../../docs/BITACORA_SPRINTS.md) (qué se hizo, qué quedó pendiente, decisiones tomadas) y la ficha del sprint en [docs/PLAN_IMPLEMENTACION_ATOMICO.md](../../docs/PLAN_IMPLEMENTACION_ATOMICO.md).
2. **Avisar al usuario del modelo recomendado.** Indica el modelo de IA y el nivel de esfuerzo que la ficha del sprint recomienda (línea `🤖`) y, si el modelo de la sesión actual no coincide, dilo y pregunta si continuar o cambiar antes de escribir código. No adivines el modelo de la sesión: si no lo sabes, pregúntalo.
3. **Cargar las skills** que indica la ficha del sprint (y la anatomía del prototipo si el sprint toca interfaz).
4. **Comprobar las dependencias externas** que indique la ficha (credenciales, decisiones legales pendientes). Si falta algo bloqueante, se para y se avisa; no se simula en silencio. Excepción: lo que figura en «Tareas externas aplazadas» del plan (respuestas de Paycomet, abogado, asesoría fiscal, proveedor Veri\*factu) **se construye contra el simulador por decisión del promotor**; en ese caso se anota en la bitácora la suposición usada y se recuerda que bloquea el paso a cobros reales.

## 3. Tamaño de cada entrega y reparto de trabajo

1. **Un único sprint por entrega**, salvo que el usuario pida encadenar varios. Cada entrega: `4–8` archivos cohesivos, `~600–1.050` líneas de producción + sus tests.
2. **Partición preventiva:** si un componente o servicio supera las **300 líneas**, se divide en submódulos de responsabilidad única.
3. **Constructor y auditor son contextos distintos:** quien escribe no se audita a sí mismo. Las auditorías las hacen los subagentes del *War Room* indicados en la ficha. Si es posible, el auditor usa **otro modelo** que el constructor (ver la guía de IA).
4. **Imágenes:** si el sprint necesita una imagen que no sea vectorial o generada por código, sigue la sección de imágenes de la guía de IA: Claude produce SVG, CSS o imágenes por código; las imágenes fotográficas o ilustradas en mapa de bits se generan con el modelo de imagen de Gemini. Si el modelo de la sesión no puede generarla, deja escrito el *prompt* exacto y el destino del archivo, y avisa al usuario.

## 4. Las 5 puertas y el bucle de corrección

Ningún sprint se entrega ni se marca `[x]` sin superar al **100 % (`0` fallos)**:

- **Puerta 1 · Estática e invariantes:** `node .agents/skills/korum-qa-harness-gatekeeper/scripts/verify-invariants.mjs` (`0` violaciones) + `npm run typecheck` (`0` errores) + `npm run lint`.
- **Puerta 2 · Tests unitarios, concurrencia y fuzzing:** `npm run test:unit` al `100 %`.
- **Puerta 3 · War Room:** dictamen `APROBADO` de los auditores indicados en la ficha.
- **Puerta 4 · Navegador real** (todo sprint con interfaz): `qa-e2e-verifier` ejecuta `npm run test:e2e` (Playwright, `1440×900` y `430×932`, incluida la comprobación de accesibilidad con axe) y además navega la app como una persona usuaria real con el **servidor MCP de Playwright**, revisando clics, formularios, capturas y `0` errores de consola.
- **Puerta 5 · Bucle de corrección y no regresión:** si cualquier puerta falla, se corrige la causa raíz y se **vuelven a ejecutar todas las puertas desde la 1**, también la prueba en navegador, hasta `0` errores con el `100 %` de las suites (nuevas y anteriores) en verde.

## 5. Al cerrar un sprint (obligatorio)

1. Marca `[x]` en el plan y añade una entrada en [docs/BITACORA_SPRINTS.md](../../docs/BITACORA_SPRINTS.md): modelo y esfuerzo usados, archivos creados, decisiones, pendientes y resultado de las 5 puertas.
2. Si has cambiado algo en `.agents/` (reglas, skills o agentes), ejecuta `node scripts/sync-ai-context.mjs` para regenerar `.claude/`.
3. Propón un commit con un mensaje claro. Commitea solo si el usuario lo aprueba.
4. Termina indicando **el siguiente sprint y su modelo y esfuerzo recomendados**.
