# Reglas permanentes de ingeniería KORUM (Gemini · Antigravity)

Además del contexto general cargado automáticamente desde `AGENTS.md`, aplica sin excepción estas 4 reglas permanentes en cada turno:

@[01 - Arquitectura y Código](.agents/rules/01-arquitectura-y-codigo.md)

@[02 - Invariantes Financieros](.agents/rules/02-invariantes-financieros.md)

@[03 - UX, Idiomas, Accesibilidad y Textos](.agents/rules/03-ux-mobile-y-copywriting.md)

@[04 - Ejecución por Sprints y QA](.agents/rules/04-ejecucion-sin-recortes.md)

## Notas específicas de Gemini

- **Skills y subagentes:** se leen directamente de `.agents/skills/` y `.agents/agents/`. Si los modificas, ejecuta `node scripts/sync-ai-context.mjs` para que Claude Code reciba la misma versión.
- **Navegador para la Puerta 4:** servidor MCP `playwright` definido en `.agents/mcp_config.json`.
- **Modelo y esfuerzo:** antes de cada sprint, indica al usuario la recomendación de la ficha (línea `🤖`) y avisa si la sesión usa otro modelo. Equivalencias con Claude: **Argon = Opus** y **Flash 3.8 = Sonnet**; Flash 3.8 siempre en esfuerzo alto, y Argon medio = Opus alto, Argon alto = Opus extra alto o máx. Cada agente de `.agents/agents/` declara su par en la cabecera (`gemini-model`, `gemini-effort`): úsalo al lanzarlo (tabla en [docs/GUIA_IA_CLAUDE_Y_GEMINI.md](docs/GUIA_IA_CLAUDE_Y_GEMINI.md) §3.1 bis).
- **Imágenes:** el modelo de imagen de Gemini es la herramienta indicada para fotografías e ilustraciones en mapa de bits; sigue las reglas de [docs/GUIA_IA_CLAUDE_Y_GEMINI.md](docs/GUIA_IA_CLAUDE_Y_GEMINI.md) §5 (sin menores identificables ni marcas reales).
