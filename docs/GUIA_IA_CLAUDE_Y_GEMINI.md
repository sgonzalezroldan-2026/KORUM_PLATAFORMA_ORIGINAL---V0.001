# Guía para construir KORUM con Claude o con Gemini

> Para el promotor y para cualquier asistente de IA. Explica dónde está la configuración de cada herramienta, qué modelo y esfuerzo usar en cada tipo de trabajo, cómo generar imágenes y cómo cambiar de una IA a otra sin perder el hilo.

---

## 1. La idea en una frase

**Toda la documentación vive una sola vez en `AGENTS.md`, `docs/` y `.agents/`.** Claude Code y Gemini (Antigravity) leen esa misma fuente; para Claude se genera una copia en `.claude/` con un script. Así, da igual con qué IA ejecutes cada sprint: las reglas, el plan y el estado son los mismos.

---

## 2. Dónde está cada cosa

| Elemento | Fuente (se edita aquí) | Claude Code | Gemini · Antigravity |
| :--- | :--- | :--- | :--- |
| Contexto maestro | `AGENTS.md` | `CLAUDE.md` lo importa con `@AGENTS.md` | Se carga automáticamente |
| Reglas permanentes | `.agents/rules/*.md` | `CLAUDE.md` las importa | `GEMINI.md` las referencia |
| Skills | `.agents/skills/*/` | `.claude/skills/*/` (generado) | Se leen de `.agents/skills/` |
| Subagentes | `.agents/agents/*.md` | `.claude/agents/*.md` (generado, con modelo fijado) | Se leen de `.agents/agents/` |
| Servidores MCP | — | `.mcp.json` | `.agents/mcp_config.json` |
| Estado del proyecto | `docs/BITACORA_SPRINTS.md` | igual | igual |

**Después de cambiar cualquier archivo de `.agents/`**, ejecuta:

```bash
node scripts/sync-ai-context.mjs
```

El escáner de la Puerta 1 avisa si `.claude/` se ha quedado desactualizado.

---

## 3. Qué modelo y qué esfuerzo usar

### 3.1 Modelos disponibles

| Modelo | Esfuerzos | Para qué es mejor en KORUM |
| :--- | :--- | :--- |
| **Claude Opus 5.5** | medio · alto · extra alto · máx. | Dinero, libro mayor, pagos, seguridad, fiscalidad, esquema de datos, auditorías críticas, decisiones difíciles de deshacer. |
| **Claude Sonnet 5.5** | medio · alto · extra alto · máx. | Interfaz y funcionalidades bien especificadas, tests E2E, emails, SEO, ajustes. Mejor relación calidad/coste para construir. |
| **Gemini Argon** | bajo · medio · alto | Alternativa a Claude en cualquier sprint; **revisión cruzada** (un modelo distinto encuentra fallos distintos); textos nativos en catalán e inglés; lectura de mucho contexto a la vez. |
| **Gemini Flash 3.8** | bajo · medio · alto | Tareas mecánicas y repetitivas: metadatos, catálogos de traducción, datos de prueba, ajustes menores. |
| **Modelo de imagen de Gemini** | — | Fotografías e ilustraciones en mapa de bits (§5). |

> Gemini Argon es el modelo potente de Gemini y Gemini Flash 3.8 el rápido y económico.

### 3.1 bis Equivalencias entre Claude y Gemini

Para ejecutar un sprint con Gemini en lugar de Claude (o un subagente en Antigravity) se aplica siempre esta tabla:

| Claude | Gemini equivalente |
| :--- | :--- |
| **Opus 5.5** | **Argon** |
| **Sonnet 5.5** (cualquier esfuerzo) | **Flash 3.8 · alto** (siempre alto) |
| Opus · medio | Argon · medio |
| Opus · alto | Argon · medio |
| Opus · extra alto o máx. | Argon · alto |

Cada subagente lleva su par fijado en la cabecera de `.agents/agents/*.md` (`claude-model`, `claude-effort`, `gemini-model`, `gemini-effort`). `node scripts/sync-ai-context.mjs` genera con ellos el `model` y el `effort` de `.claude/agents/` y **rechaza** cualquier par que rompa esta tabla. Antigravity lee los agentes directamente de `.agents/agents/`: si su selector de modelo no aplica estos campos solos, elige a mano el modelo y el esfuerzo que figuran en la cabecera del agente.

### 3.2 Niveles de esfuerzo (Claude)

- **Medio:** cambios acotados y mecánicos, o cuando la ficha del sprint es muy detallada.
- **Alto:** el estándar para construir un sprint completo.
- **Extra alto:** sprints donde un error cuesta dinero o seguridad (libro mayor, Paycomet, certificación final).
- **Máx.:** solo para desatascar un fallo que ha resistido **dos vueltas** del bucle de corrección. No como opción por defecto.

### 3.3 Resumen por sprint

La recomendación exacta de cada sprint está en su línea `🤖` del [plan](PLAN_IMPLEMENTACION_ATOMICO.md). En resumen:

| Tipo de sprint | Constructor | Auditoría |
| :--- | :--- | :--- |
| Libro mayor (1.2), Paycomet (2.1), certificación final (5.6) | Opus 5.5 · extra alto | Opus 5.5 · alto (+ Gemini Argon · alto como revisión cruzada) |
| TCO/BI, seguridad, fiscalidad, privacidad, autenticación, checkout, Mi Hucha, doble firma, liquidaciones | Opus 5.5 · alto | Opus 5.5 · alto |
| Interfaz, portal público, comercios, ideas, panel, portería, BI, ajustes, emails, operación | Sonnet 5.5 · alto | Opus 5.5 · alto para dinero y seguridad; Sonnet 5.5 · alto para experiencia |
| Reglas globales y tareas repetitivas | Sonnet 5.5 · medio o Gemini Flash 3.8 · alto | Opus 5.5 · alto si toca dinero |
| Textos de marketing y traducciones | Gemini Argon · alto | Persona nativa para los textos legales |

En Claude Code, los subagentes ya tienen su modelo **y su esfuerzo** fijados en `.claude/agents/`:

| Subagente | Claude | Gemini (Antigravity) |
| :--- | :--- | :--- |
| `korum-core-fintech-architect`, `korum-security-gov-engineer`, `fintech-escrow-auditor`, `antifraud-legal-guardian` | Opus 5.5 · alto | Argon · medio |
| `korum-family-viral-builder`, `korum-backoffice-bi-builder`, `ux-school-director-reviewer` | Sonnet 5.5 · alto | Flash 3.8 · alto |
| `qa-e2e-verifier`, `korum-seo-discoverability-specialist`, `korum-brand-visual-director`, `korum-community-target-psychologist` | Sonnet 5.5 · medio | Flash 3.8 · alto |

Esos son los valores por defecto. Cuando la ficha de un sprint pide otro modelo para un agente (línea **Agente constructor:**), el orquestador lo indica al lanzarlo: por ejemplo, `korum-family-viral-builder` con `opus` en los sprints 3.4, 3.7 y 3.8, y `korum-backoffice-bi-builder` con `opus` en el 4.2 y el 4.4. Para el resto basta con elegir el modelo de la sesión principal.

### 3.4 Cómo ahorrar tokens sin perder calidad

1. **Un sprint por sesión.** Al terminar y actualizar la bitácora, empieza una conversación nueva (en Claude Code, `/clear`).
2. **No leer el prototipo entero:** el índice de anclas indica exactamente qué trozo leer.
3. **Construir con Sonnet y auditar con Opus** en los sprints de interfaz.
4. **La bitácora sustituye las explicaciones:** el asistente la lee en lugar de que tú le cuentes qué se hizo.
5. **Esfuerzo máx. solo para atascos.**

---

## 4. Cómo empezar un sprint (mensaje para copiar)

Funciona igual en Claude Code y en Gemini:

```text
Vamos con el Sprint X.Y del plan. Antes de empezar, dime qué modelo y esfuerzo recomienda su ficha
y si coinciden con los de esta sesión. Después sigue la Regla 04: lee la bitácora, carga las skills
del sprint, construye, pasa las 5 puertas y actualiza la bitácora.
```

---

## 5. Imágenes: qué puede hacer cada IA

| Necesidad | Claude | Gemini |
| :--- | :--- | :--- |
| Logotipos, iconos, sellos, pegatinas, ilustraciones planas (SVG) | ✅ | ✅ |
| Tarjetas para WhatsApp y redes, carteles A4, pases QR (generados por código) | ✅ | ✅ |
| Gráficos y diagramas | ✅ | ✅ |
| **Fotografías** de ambiente (patio, pabellón, aula) | ❌ | ✅ con su modelo de imagen |
| **Ilustraciones ricas** en mapa de bits, texturas (papel, tela bordada) | ❌ | ✅ con su modelo de imagen |
| Retocar o hacer variaciones de una imagen existente | ❌ | ✅ con su modelo de imagen |

**Flujo cuando hace falta una imagen en mapa de bits:**

1. El asistente del sprint escribe el *prompt* completo y el destino del archivo (`public/brand/generated/...`).
2. La imagen se genera con el modelo de imagen de Gemini (si el sprint se está haciendo en Claude, la generas tú en Gemini o en Antigravity con ese *prompt*).
3. Se guarda el original en `public/brand/generated/originals/`, se exporta a WebP/AVIF (máx. 200 KB en móvil) y se crea al lado un `.md` con el *prompt*, el modelo y la fecha.
4. El asistente la integra con su texto alternativo en los 3 idiomas.

**Reglas que toda imagen cumple** (detalle en la skill de marca, §4): sin menores identificables, sin escudos, marcas ni lugares reales reconocibles, familias diversas en contexto español y coherencia con la paleta de marca.

**Plantilla de *prompt*:**

```text
[Tipo de imagen: fotografía / ilustración], [escena], en un [patio de colegio / pabellón de club] español
de barrio, luz mediterránea de mañana. Paleta: azul marino #101F38, oro #F59E0B, crema #FFFDF8, coral #FF5A43.
Estilo: [cálido, documental, natural]. Personas: adultos diversos; si aparecen niños, de espaldas, a contraluz
o desenfocados, nunca caras reconocibles. Sin texto, sin logotipos, sin uniformes ni escudos reales.
Formato 16:9, alta resolución, espacio libre a la izquierda para titular.
```

---

## 6. Cambiar de IA a mitad del proyecto

1. Termina el sprint en curso (o déjalo anotado como *en curso* en la bitácora, con lo que falta).
2. Haz commit de lo hecho.
3. Abre la otra herramienta y usa el mensaje del §4. La bitácora le da todo el contexto.
4. **Nunca trabajes con dos asistentes a la vez sobre los mismos archivos.**

---

## 7. Servidores MCP

- **Playwright** (navegador para la Puerta 4): definido en `.mcp.json` (Claude Code) y en `.agents/mcp_config.json` (Antigravity). En Windows, `.mcp.json` lo lanza con `cmd /c npx`; en macOS o Linux, cambia `"command": "cmd"` por `"command": "npx"` y quita `"/c", "npx"` de los argumentos.
- **Prisma** (consultar la base de datos y el estado de las migraciones): se añade en el Sprint 1.1, cuando Prisma esté instalado.
- Claude Code y Antigravity ya incluyen lectura, edición, terminal y git: no hacen falta servidores MCP para eso.
