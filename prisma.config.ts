import { defineConfig } from 'prisma/config';

// Prisma 7 ya no carga .env por su cuenta: en local se exportan las variables con `node --env-file=.env.local`
// o desde el propio shell. Para `generate` y `validate` no hace falta conexión, por eso la URL tiene valor vacío por defecto.
// `SHADOW_DATABASE_URL` solo lo necesita `prisma migrate dev` (con `npm run db:dev` es el puerto 51215).
// `.env.local` nace de `.env.example`, donde estas variables vienen con valor vacío: un valor vacío cuenta como «sin definir».
const filled = (value: string | undefined): string | undefined => (value && value.trim() !== '' ? value : undefined);

export default defineConfig({
  schema: 'schema/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // La lanzan `npm run db:seed` y, tras reiniciar, `npm run db:reset` (`prisma/reset.ts`).
    seed: 'tsx --env-file-if-exists=.env.local prisma/seed.ts'
  },
  datasource: {
    url: filled(process.env.DIRECT_URL) ?? filled(process.env.DATABASE_URL) ?? '',
    shadowDatabaseUrl: filled(process.env.SHADOW_DATABASE_URL)
  }
});
