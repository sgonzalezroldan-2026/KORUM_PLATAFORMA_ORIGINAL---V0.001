import { toNextJsHandler } from 'better-auth/next-js';
import { getAuth } from '@/lib/auth/server';

/** Rutas de Better Auth (`/api/auth/*`): enlace mágico, código por email, contraseña, TOTP y sesión. La instancia se crea al primer uso. */
const handler = () => toNextJsHandler(getAuth());

export const GET = (request: Request) => handler().GET(request);
export const POST = (request: Request) => handler().POST(request);
