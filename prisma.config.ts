import { defineConfig } from 'prisma/config';

// Prisma 7 ya no carga .env por su cuenta: en local se exportan las variables con `node --env-file=.env.local`
// o desde el propio shell. Para `generate` y `validate` no hace falta conexión, por eso la URL tiene valor vacío por defecto.
// `SHADOW_DATABASE_URL` solo lo necesita `prisma migrate dev` (con `npm run db:dev` es el puerto 51215).
export default defineConfig({
  schema: 'schema/schema.prisma',
  migrations: {
    path: 'prisma/migrations'
  },
  datasource: {
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '',
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL
  }
});
