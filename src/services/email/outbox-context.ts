import type { Db } from '@/lib/db';
import type { TemplateContext } from './templates/email-content';

/**
 * Datos de la entidad y de la iniciativa que necesita una plantilla, leídos al enviar (no al escribir el mensaje): así el recibo o el
 * aviso muestran el título actual y los mensajes que escriben las tareas (que solo guardan identificadores) siguen sirviendo.
 */

export class EmailContextError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'EmailContextError';
  }
}

const INITIATIVE_SELECT = {
  id: true,
  title: true,
  closesAt: true,
  goalCents: true,
  raisedCents: true,
  totalContributions: true,
  ticketSubtype: true,
  ticketVenue: true,
  status: true,
  organizationId: true,
  organization: { select: { name: true, legalName: true, slug: true } }
} as const;

const initiativeIdOf = (payload: unknown): number | undefined => {
  const value = typeof payload === 'object' && payload !== null ? (payload as { initiativeId?: unknown }).initiativeId : undefined;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
};

export async function loadEmailContext(db: Db, message: { organizationId: string | null; payloadJson: unknown }, needs: 'initiative' | 'organization' | undefined): Promise<Pick<TemplateContext, 'organization' | 'initiative'>> {
  const initiativeId = initiativeIdOf(message.payloadJson);
  if (initiativeId !== undefined) {
    const initiative = await db.initiative.findUnique({ where: { id: initiativeId }, select: INITIATIVE_SELECT });
    if (!initiative) throw new EmailContextError('La iniciativa del mensaje ya no existe.');
    // Un mensaje de una entidad nunca debe mostrar datos de otra: sin entidad en el mensaje no hay con qué comprobarlo, y si no coinciden, no se envía.
    if (!message.organizationId) throw new EmailContextError('El mensaje cita una iniciativa pero no indica su entidad.');
    if (message.organizationId !== initiative.organizationId) throw new EmailContextError('La iniciativa del mensaje es de otra entidad.');
    return { organization: initiative.organization, initiative };
  }
  if (message.organizationId) {
    const organization = await db.organization.findUnique({ where: { id: message.organizationId }, select: { name: true, legalName: true, slug: true } });
    if (!organization) throw new EmailContextError('La entidad del mensaje ya no existe.');
    return { organization };
  }
  if (needs) throw new EmailContextError(`La plantilla necesita ${needs === 'initiative' ? 'una iniciativa' : 'una entidad'} y el mensaje no la indica.`);
  return {};
}
