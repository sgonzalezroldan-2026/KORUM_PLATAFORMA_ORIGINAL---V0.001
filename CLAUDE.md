# Contexto maestro para Claude Code · Proyecto KORUM v8.5

Aplica estrictamente este contexto y las 4 reglas permanentes (se cargan automáticamente con estas importaciones):

@AGENTS.md
@.agents/rules/01-arquitectura-y-codigo.md
@.agents/rules/02-invariantes-financieros.md
@.agents/rules/03-ux-mobile-y-copywriting.md
@.agents/rules/04-ejecucion-sin-recortes.md

## Notas específicas de Claude Code

- **Skills y subagentes:** están en `.claude/skills/` y `.claude/agents/`, generados desde `.agents/` con `node scripts/sync-ai-context.mjs`. Para cambiar una skill o un agente, edita la fuente en `.agents/` y vuelve a ejecutar el script; nunca edites `.claude/skills` ni `.claude/agents` a mano.
- **Navegador para la Puerta 4:** servidor MCP `playwright` definido en `.mcp.json`.
- **Modelo y esfuerzo:** antes de cada sprint, indica al usuario la recomendación de la ficha (línea `🤖`). En Claude Code se cambian con `/model` y con el nivel de esfuerzo de la sesión. Los subagentes ya fijan su propio modelo y esfuerzo en `.claude/agents/` (se declaran en la cabecera de `.agents/agents/*.md`).
- **Imágenes:** Claude genera SVG, CSS e imágenes por código (`next/og`), pero no fotografías ni ilustraciones en mapa de bits. Para esas, sigue [docs/GUIA_IA_CLAUDE_Y_GEMINI.md](docs/GUIA_IA_CLAUDE_Y_GEMINI.md) §5.
