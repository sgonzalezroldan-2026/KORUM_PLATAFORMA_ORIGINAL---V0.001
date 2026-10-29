# KORUM

Plataforma SaaS multi-entidad para colegios (a través de su AMPA/AFA o de su titular), clubes deportivos base y entidades culturales: buzón de ideas con quórum, campañas de mecenazgo «todo o nada», taquilla y rifas con QR, comercios amigos y Mi Hucha.

> *Donde las buenas ideas suman y se logran.*

## Arrancar en tu ordenador

Necesitas **Node.js 24 o superior**. Todo lo demás se instala con estos pasos:

```bash
npm install            # instala las dependencias
npm run setup:env      # crea .env.local con los secretos generados
npm run dev            # abre http://localhost:3000
```

La base de datos local (PostgreSQL) se arranca con Docker cuando haga falta: `docker compose up -d`. Hasta el Sprint 1.3 la aplicación no la usa.

La galería de componentes está en <http://localhost:3000/dev/ui> (solo en desarrollo y en el entorno de demostración).

## Comandos

| Comando | Para qué |
| :--- | :--- |
| `npm run dev` | Servidor de desarrollo |
| `npm run build` · `npm start` | Compilación y servidor de producción |
| `npm run typecheck` | Comprobación de tipos (TypeScript estricto) |
| `npm run lint` | Reglas de código, incluida la de «ningún texto visible fuera de `messages/`» |
| `npm run test:unit` | Pruebas unitarias (Vitest) |
| `npm run test:e2e` | Pruebas de navegador a 1440 px y 430 px con accesibilidad (Playwright + axe) |
| `npm run verify:invariants` | Escáner de invariantes del código, el esquema, la semilla y la documentación |
| `npm run sync:ai` | Regenera la configuración de Claude Code a partir de `.agents/` |
| `npm run db:validate` | Valida el esquema de datos de Prisma |

La primera vez que se lanzan las pruebas E2E hay que instalar el navegador: `npx playwright install chromium`.

## Cómo está organizado el proyecto

El contexto maestro para cualquier asistente de IA (Claude Code o Gemini) está en [AGENTS.md](AGENTS.md): qué documento manda en cada tema, las reglas permanentes, las skills y los subagentes. El estado del trabajo y el traspaso entre sesiones están en [docs/BITACORA_SPRINTS.md](docs/BITACORA_SPRINTS.md) y el plan, sprint a sprint, en [docs/PLAN_IMPLEMENTACION_ATOMICO.md](docs/PLAN_IMPLEMENTACION_ATOMICO.md).
