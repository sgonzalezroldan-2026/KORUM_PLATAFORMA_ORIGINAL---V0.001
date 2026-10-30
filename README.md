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

La base de datos local (PostgreSQL) se arranca con `npm run db:dev` (sin Docker: Prisma Postgres local en `localhost:51214`) o, si tienes Docker, con `docker compose up -d`. Las migraciones se aplican con `npm run db:migrate`.

Para ver la aplicación con datos: `npm run db:dev`, apunta `DATABASE_URL` y `DIRECT_URL` de `.env.local` a `postgres://postgres:postgres@localhost:51214/template1?sslmode=disable`, y ejecuta `npm run db:migrate` y `npm run db:seed`. Los datos de demostración son **4 entidades** (CEIP Cervantes, Colegio San José, Club Basket Vallès e IES Mediterráneo, cada una con su titular legal y sus 2 firmantes), **8 iniciativas** con 1.505 cobros, 5 comercios amigos, una taquilla con 112 compras y pases QR firmados, 3 ideas y 2 facturas. Todo es ficticio y el libro mayor cuadra al céntimo.

La galería de componentes está en <http://localhost:3000/dev/ui> (solo en desarrollo y en el entorno de demostración).

## Comandos

| Comando | Para qué |
| :--- | :--- |
| `npm run dev` | Servidor de desarrollo |
| `npm run build` · `npm start` | Compilación y servidor de producción |
| `npm run typecheck` | Comprobación de tipos (TypeScript estricto) |
| `npm run lint` | Reglas de código, incluida la de «ningún texto visible fuera de `messages/`» |
| `npm run test:unit` | Pruebas unitarias (Vitest) |
| `npm run test:integration` | Pruebas contra PostgreSQL real: libro mayor, triggers y concurrencia (necesita `npm run db:dev`) |
| `npm run db:dev` · `npm run db:migrate` | Base de datos local sin Docker · aplicar las migraciones |
| `npm run db:seed` · `npm run db:reset` | Cargar los datos de demostración (idempotente) · borrar la base, migrar y sembrar (ambos solo en bases locales o de demostración, nunca con cobros reales) |
| `npm run test:e2e` | Pruebas de navegador a 1440 px y 430 px con accesibilidad (Playwright + axe) |
| `npm run verify:invariants` | Escáner de invariantes del código, el esquema, la semilla y la documentación |
| `npm run sync:ai` | Regenera la configuración de Claude Code a partir de `.agents/` |
| `npm run db:validate` | Valida el esquema de datos de Prisma |

La primera vez que se lanzan las pruebas E2E hay que instalar el navegador: `npx playwright install chromium`.

## Cómo está organizado el proyecto

El contexto maestro para cualquier asistente de IA (Claude Code o Gemini) está en [AGENTS.md](AGENTS.md): qué documento manda en cada tema, las reglas permanentes, las skills y los subagentes. El estado del trabajo y el traspaso entre sesiones están en [docs/BITACORA_SPRINTS.md](docs/BITACORA_SPRINTS.md) y el plan, sprint a sprint, en [docs/PLAN_IMPLEMENTACION_ATOMICO.md](docs/PLAN_IMPLEMENTACION_ATOMICO.md).
