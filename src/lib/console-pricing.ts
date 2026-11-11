import { cache } from 'react';
import { getSessionActor } from '@/lib/auth/session';
import { getPrisma } from '@/lib/prisma';
import { getConsolePricingHealth } from '@/repositories/console.repository';

/**
 * Avisos de las reglas de precio para la petición actual: el `layout` (insignia de la cabecera) y la portada (banner y lista) comparten una
 * sola lectura, y una consulta por petición. Solo se llama desde la consola, ya detrás de `requireSuperadminAccess`.
 */
export const getPricingHealthForRequest = cache(async () => getConsolePricingHealth(getPrisma(), await getSessionActor()));
