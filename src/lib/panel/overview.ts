import { cache } from 'react';
import { getPrisma } from '@/lib/prisma';
import { getPanelOverview } from '@/repositories/panel.repository';
import type { SessionActor } from '@/repositories/tenant-guard';

/**
 * Cabecera de gestión de la entidad, una sola vez por petición: el `layout` del panel y la página la piden y comparten la lectura (`cache` de
 * React compara por identidad, y `requirePanelAccess` devuelve el mismo actor en toda la petición).
 */
export const loadPanelOverview = cache(async (actor: SessionActor, organizationId: string) => getPanelOverview(getPrisma(), actor, organizationId));
