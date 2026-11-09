import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptInvitation, acceptInvitationWithSession, createInvitation, inspectInvitation, InvitationError } from '@/core/onboarding/invitations';
import type { MemberRole } from '@/generated/prisma/enums';
import type { KorumPrismaClient } from '@/lib/prisma';
import { purgeUnactivatedInvitees } from '@/core/privacy/retention-purge';
import { TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { cancelHandover, consentHandover, declineHandover, proposeHandover, resendHandoverInvitation } from '@/services/panel/signer-handover.service';
import { correctCosignerInvitation, loadSignerTeam, updateOwnRoleLabel } from '@/services/panel/signer-team.service';
import { TeamRejectedError, type TeamContext } from '@/services/panel/team-common';
import { createOrganization, createTestClient, createUser, table, TEST_HMAC_SECRET, uniqueId } from './test-database';

/**
 * Sprint 4.2e · Relevo de firmantes contra PostgreSQL real (QA-S02, «relevo de firmantes sin vaciar la doble firma»). Decisión del promotor del
 * 2026-11-09: cada persona cede su puesto, y cualquiera de las dos puede proponer el relevo de la otra, que lo confirma con su código. La persona nueva
 * no firma hasta aceptar; entonces, en una transacción, sale la fila del cargo anterior (sus enlaces de firma se anulan) y entra la suya. Nunca una
 * misma bandeja en los dos puestos, nunca dos relevos a la vez, nada desde otra entidad ni desde la consola del Super-Admin.
 */

const HOUR = 3_600_000;
let db: KorumPrismaClient;
const organizations: string[] = [];

beforeAll(() => {
  db = createTestClient();
});

afterAll(async () => {
  await db.outboxMessage.deleteMany({ where: { organizationId: { in: organizations }, status: 'PENDING' } });
  await db.$disconnect();
});

const actorFor = (userId: string, organizationId: string, role: MemberRole, overrides: Partial<Extract<SessionActor, { kind: 'user' }>> = {}): SessionActor => ({
  kind: 'user',
  userId,
  isSuperadmin: false,
  memberships: [{ organizationId, role }],
  secondFactor: true,
  ...overrides
});

const context = (overrides: Partial<TeamContext> = {}): TeamContext & { sent: number[] } => {
  const sent: number[] = [];
  return { appUrl: 'https://korum.test', hmacSecret: TEST_HMAC_SECRET, secondFactorFresh: true, dispatch: (ids) => sent.push(...ids), sent, ...overrides };
};

const newEmail = (label: string) => `${uniqueId(label)}@correo-familias.es`.toLowerCase();

async function team() {
  const organization = await createOrganization(db, { contactEmail: 'direccion-original@correo-familias.es', contactPhone: '+34600111222' });
  organizations.push(organization.id);
  const [directorEmail, cosignerEmail] = [newEmail('dir'), newEmail('cof')];
  const director = await createUser(db, { twoFactorEnabled: true, email: directorEmail, canonicalEmail: directorEmail });
  const cosigner = await createUser(db, { twoFactorEnabled: true, email: cosignerEmail, canonicalEmail: cosignerEmail });
  const [directorMember, cosignerMember] = await Promise.all([
    db.organizationMember.create({ data: { organizationId: organization.id, userId: director.id, role: 'DIRECTOR', roleLabel: 'Dirección del centro' } }),
    db.organizationMember.create({ data: { organizationId: organization.id, userId: cosigner.id, role: 'COSIGNER', roleLabel: 'Presidencia del AMPA' } })
  ]);
  return {
    organization,
    director: { user: director, member: directorMember, actor: actorFor(director.id, organization.id, 'DIRECTOR') },
    cosigner: { user: cosigner, member: cosignerMember, actor: actorFor(cosigner.id, organization.id, 'COSIGNER') }
  };
}

/** Token de la invitación que acaba de salir para esa persona: el email lo lleva en el enlace; aquí se recrea con el mismo relevo (como un reenvío). */
async function invitationToken(userId: string, organizationId: string, handoverId: string) {
  const { token } = await createInvitation(db, { userId, organizationId, purpose: 'HANDOVER', roleLabel: 'Cargo', displayName: 'Nombre', handoverId });
  return token;
}

const reason = async (promise: Promise<unknown>) => ((await promise.catch((error: unknown) => error)) as TeamRejectedError).reason;

describe('ceder el propio puesto', () => {
  it('quien dirige invita a quien le sustituye; sigue firmando hasta que acepta, y entonces sale su fila, entra la nueva y los avisos llegan a las dos personas', async () => {
    const { organization, director, cosigner } = await team();
    const ctx = context();
    const email = newEmail('nueva-dir');
    const { handoverId, status } = await proposeHandover(db, director.actor, organization.id, { role: 'DIRECTOR', name: 'Lucía Pérez', email, roleLabel: 'Dirección del centro' }, ctx);
    expect(status).toBe('INVITED');
    const invitation = await db.outboxMessage.findFirstOrThrow({ where: { organizationId: organization.id, templateKey: 'auth.invitation', toAddress: email } });
    expect(ctx.sent).toContain(invitation.id);
    expect(await db.organizationMember.count({ where: { id: director.member.id } })).toBe(1);

    // Un enlace de firma abierto de quien sale se anula al completar el relevo.
    const idea = await db.idea.create({ data: { organizationId: organization.id, alias: '#FAM-0001', authorCanonicalEmail: 'autor@correo-familias.es', title: 'Toldos', category: 'Patios', description: 'd', expiresAt: new Date(Date.now() + 86_400_000) } });
    const challenge = await db.doubleCheckChallenge.create({
      data: { organizationId: organization.id, targetType: 'IDEA_APPROVAL', ideaId: idea.id, signerUserId: director.user.id, signerRole: 'DIRECTOR', tokenHash: randomUUID(), otpHmac: 'x', targetDigest: 'y', expiresAt: new Date(Date.now() + HOUR) }
    });

    const incoming = await db.user.findUniqueOrThrow({ where: { canonicalEmail: email } });
    const token = await invitationToken(incoming.id, organization.id, handoverId);
    expect(await inspectInvitation(db, token)).toMatchObject({ purpose: 'HANDOVER', organizationSlug: organization.slug, email });
    expect((await acceptInvitation(db, token, 'una-clave-larga-y-segura')).handoverId).toBe(handoverId);

    const members = await db.organizationMember.findMany({ where: { organizationId: organization.id }, orderBy: { role: 'asc' } });
    expect(members.map((member) => [member.role, member.userId, member.roleLabel])).toEqual([
      ['DIRECTOR', incoming.id, 'Dirección del centro'],
      ['COSIGNER', cosigner.user.id, 'Presidencia del AMPA']
    ]);
    expect(await db.signerHandover.findUniqueOrThrow({ where: { id: handoverId } })).toMatchObject({ status: 'COMPLETED' });
    expect((await db.doubleCheckChallenge.findUniqueOrThrow({ where: { id: challenge.id } })).revokedAt).not.toBeNull();
    // El contacto del alta era de quien dirigía: pasa al email de la persona nueva y el móvil se vacía.
    expect(await db.organization.findUniqueOrThrow({ where: { id: organization.id }, select: { contactEmail: true, contactPhone: true } })).toEqual({ contactEmail: email, contactPhone: null });
    const notices = await db.outboxMessage.findMany({ where: { organizationId: organization.id, templateKey: 'signer.handover' }, select: { userId: true, payloadJson: true } });
    expect(notices.map((notice) => [notice.userId, (notice.payloadJson as { leaving: boolean }).leaving]).sort()).toEqual([[cosigner.user.id, false], [director.user.id, true]].sort());
    expect(await db.auditLog.count({ where: { organizationId: organization.id, action: { in: ['signer.handover_proposed', 'signer.handover_completed'] } } })).toBe(2);
    // El enlace ya no sirve otra vez.
    await expect(acceptInvitation(db, token, 'una-clave-larga-y-segura')).rejects.toBeInstanceOf(InvitationError);
  });
});

describe('proponer el relevo de la otra persona', () => {
  it('queda pendiente de su visto bueno; nadie más puede darlo, se confirma con el código y entonces sale la invitación', async () => {
    const { organization, director, cosigner } = await team();
    const ctx = context();
    const existingEmail = newEmail('tesoreria');
    const existing = await createUser(db, { email: existingEmail, canonicalEmail: existingEmail, twoFactorEnabled: true });
    const { handoverId, status } = await proposeHandover(db, director.actor, organization.id, { role: 'COSIGNER', name: 'Jordi Puig', email: existing.email, roleLabel: 'Tesorería del AMPA' }, ctx);
    expect(status).toBe('AWAITING_CONSENT');
    const requested = await db.outboxMessage.findFirstOrThrow({ where: { organizationId: organization.id, templateKey: 'signer.handover', userId: cosigner.user.id } });
    expect(requested.payloadJson).toMatchObject({ stage: 'REQUESTED', role: 'COSIGNER' });
    expect(await db.verification.count({ where: { identifier: { contains: existing.id } } })).toBe(0);

    // Quien propone no puede dar el visto bueno por la otra persona; ella sí, pero con el código reciente.
    expect(await reason(consentHandover(db, director.actor, organization.id, handoverId, context()))).toBe('NOT_FOUND');
    expect(await reason(consentHandover(db, cosigner.actor, organization.id, handoverId, context({ secondFactorFresh: false })))).toBe('REAUTH_REQUIRED');
    await consentHandover(db, cosigner.actor, organization.id, handoverId, ctx);
    expect(await db.signerHandover.findUniqueOrThrow({ where: { id: handoverId } })).toMatchObject({ status: 'INVITED' });
    expect(await db.outboxMessage.count({ where: { organizationId: organization.id, templateKey: 'auth.invitation', toAddress: existing.email } })).toBe(1);

    // Una cuenta que ya tenía contraseña acepta con su propia sesión; con la de otra persona, no.
    const token = await invitationToken(existing.id, organization.id, handoverId);
    await expect(acceptInvitationWithSession(db, token, director.user.id)).rejects.toMatchObject({ reason: 'WRONG_ACCOUNT' });
    expect(await acceptInvitationWithSession(db, token, existing.id)).toEqual({ organizationSlug: organization.slug, handoverId });
    expect(await db.organizationMember.findFirstOrThrow({ where: { organizationId: organization.id, role: 'COSIGNER' } })).toMatchObject({ userId: existing.id, roleLabel: 'Tesorería del AMPA' });
    expect(await db.organizationMember.count({ where: { id: cosigner.member.id } })).toBe(0);
  });

  it('quien sale puede rechazarlo: se cierra y se avisa a quien lo propuso', async () => {
    const { organization, director, cosigner } = await team();
    const { handoverId } = await proposeHandover(db, cosigner.actor, organization.id, { role: 'DIRECTOR', name: 'Otra Persona', email: newEmail('otra'), roleLabel: 'Dirección' }, context());
    await declineHandover(db, director.actor, organization.id, handoverId, context());
    expect(await db.signerHandover.findUniqueOrThrow({ where: { id: handoverId } })).toMatchObject({ status: 'DECLINED' });
    expect((await db.outboxMessage.findFirstOrThrow({ where: { organizationId: organization.id, templateKey: 'signer.handover', userId: cosigner.user.id } })).payloadJson).toMatchObject({ stage: 'DECLINED' });
    expect(await db.organizationMember.count({ where: { organizationId: organization.id } })).toBe(2);
  });

  it('caduca a los 7 días sin respuesta: ya no se puede dar el visto bueno y se puede proponer otro', async () => {
    const { organization, director, cosigner } = await team();
    const t0 = new Date('2026-11-10T09:00:00Z');
    const { handoverId } = await proposeHandover(db, director.actor, organization.id, { role: 'COSIGNER', name: 'Ana Ruiz', email: newEmail('ana'), roleLabel: 'Tesorería' }, context({ now: t0 }));
    const late = new Date(t0.getTime() + 7 * 24 * HOUR + 1);
    expect(await reason(consentHandover(db, cosigner.actor, organization.id, handoverId, context({ now: late })))).toBe('NOT_FOUND');
    const second = await proposeHandover(db, director.actor, organization.id, { role: 'COSIGNER', name: 'Ana Ruiz', email: newEmail('ana2'), roleLabel: 'Tesorería' }, context({ now: late }));
    expect(await db.signerHandover.findUniqueOrThrow({ where: { id: handoverId } })).toMatchObject({ status: 'EXPIRED' });
    expect(second.status).toBe('AWAITING_CONSENT');
  });
});

describe('la doble firma nunca se vacía ni se duplica', () => {
  it('no se propone la bandeja de quien ya firma (ni con un alias), sin código reciente, sin segundo factor ni con un relevo abierto', async () => {
    const { organization, director, cosigner } = await team();
    const [local, domain] = cosigner.user.email.split('@');
    const alias = `${local}+tesoreria@${domain}`;
    const base = { role: 'DIRECTOR' as const, name: 'Alguien', roleLabel: 'Dirección' };
    // El «+alias» y las mayúsculas no hacen otra bandeja: sería la misma persona en los dos puestos.
    expect(await reason(proposeHandover(db, director.actor, organization.id, { ...base, email: alias.toUpperCase() }, context()))).toBe('SAME_INBOX');
    expect(await reason(proposeHandover(db, director.actor, organization.id, { ...base, email: newEmail('x') }, context({ secondFactorFresh: false })))).toBe('REAUTH_REQUIRED');
    await expect(proposeHandover(db, { ...director.actor, secondFactor: false } as SessionActor, organization.id, { ...base, email: newEmail('x') }, context())).rejects.toBeInstanceOf(TenantAccessError);
    expect(await reason(proposeHandover(db, director.actor, organization.id, { ...base, email: 'temporal@mailinator.com' }, context()))).toBe('DISPOSABLE_EMAIL');
    await proposeHandover(db, director.actor, organization.id, { ...base, email: newEmail('y') }, context());
    expect(await reason(proposeHandover(db, cosigner.actor, organization.id, { ...base, role: 'COSIGNER', email: newEmail('w') }, context()))).toBe('ALREADY_OPEN');
    expect(await db.signerHandover.count({ where: { organizationId: organization.id } })).toBe(1);
  });

  it('dos propuestas a la vez (una para cada puesto): solo una queda abierta', async () => {
    const { organization, director, cosigner } = await team();
    const results = await Promise.allSettled([
      proposeHandover(db, director.actor, organization.id, { role: 'COSIGNER', name: 'Uno', email: newEmail('uno'), roleLabel: 'Tesorería' }, context()),
      proposeHandover(db, cosigner.actor, organization.id, { role: 'DIRECTOR', name: 'Dos', email: newEmail('dos'), roleLabel: 'Dirección' }, context())
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await db.signerHandover.count({ where: { organizationId: organization.id, status: { in: ['AWAITING_CONSENT', 'INVITED'] } } })).toBe(1);
  });

  it('si el puesto cambia antes de aceptar, el enlace ya no vale y la siguiente propuesta lo cierra', async () => {
    const { organization, director } = await team();
    const email = newEmail('tarde');
    const { handoverId } = await proposeHandover(db, director.actor, organization.id, { role: 'DIRECTOR', name: 'Tarde', email, roleLabel: 'Dirección' }, context());
    const incoming = await db.user.findUniqueOrThrow({ where: { canonicalEmail: email } });
    const token = await invitationToken(incoming.id, organization.id, handoverId);
    await db.organizationMember.delete({ where: { id: director.member.id } });
    expect(await inspectInvitation(db, token)).toBeNull();
    await expect(acceptInvitation(db, token, 'una-clave-larga-y-segura')).rejects.toBeInstanceOf(InvitationError);
    expect(await db.organizationMember.count({ where: { organizationId: organization.id, userId: incoming.id } })).toBe(0);
    expect(await db.signerHandover.findUniqueOrThrow({ where: { id: handoverId } })).toMatchObject({ status: 'INVITED' });
  });

  it('dos aceptaciones del mismo enlace a la vez: una sola fila nueva', async () => {
    const { organization, director } = await team();
    const existingEmail = newEmail('doble');
    const existing = await createUser(db, { email: existingEmail, canonicalEmail: existingEmail });
    const { handoverId } = await proposeHandover(db, director.actor, organization.id, { role: 'DIRECTOR', name: 'Doble', email: existing.email, roleLabel: 'Dirección' }, context());
    const token = await invitationToken(existing.id, organization.id, handoverId);
    const results = await Promise.allSettled([acceptInvitationWithSession(db, token, existing.id), acceptInvitationWithSession(db, token, existing.id)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await db.organizationMember.count({ where: { organizationId: organization.id, role: 'DIRECTOR' } })).toBe(1);
  });

  it('retirar un relevo invitado anula su enlace; reenviarlo da un plazo nuevo', async () => {
    const { organization, director, cosigner } = await team();
    const email = newEmail('retirar');
    const t0 = new Date();
    const { handoverId } = await proposeHandover(db, director.actor, organization.id, { role: 'DIRECTOR', name: 'Retirar', email, roleLabel: 'Dirección' }, context({ now: t0 }));
    const later = new Date(t0.getTime() + 2 * HOUR);
    await resendHandoverInvitation(db, cosigner.actor, organization.id, handoverId, { ...context(), now: later });
    expect((await db.signerHandover.findUniqueOrThrow({ where: { id: handoverId } })).expiresAt.getTime()).toBe(later.getTime() + 72 * HOUR);
    await cancelHandover(db, cosigner.actor, organization.id, handoverId);
    const incoming = await db.user.findUniqueOrThrow({ where: { canonicalEmail: email } });
    expect(await db.verification.count({ where: { identifier: `korum-invite:${incoming.id}:${organization.id}` } })).toBe(0);
    expect(await db.signerHandover.findUniqueOrThrow({ where: { id: handoverId } })).toMatchObject({ status: 'CANCELLED' });
  });

  it('nadie de otra entidad, de portería ni el Super-Admin toca el equipo; lo intentado queda en la auditoría', async () => {
    const { organization } = await team();
    const other = await team();
    const gatekeeper = await createUser(db);
    await db.organizationMember.create({ data: { organizationId: organization.id, userId: gatekeeper.id, role: 'GATEKEEPER' } });
    const superadmin = await createUser(db, { isSuperadmin: true });
    const input = { role: 'COSIGNER', name: 'Intrusa', email: newEmail('intrusa'), roleLabel: 'Tesorería' };
    for (const actor of [other.director.actor, actorFor(gatekeeper.id, organization.id, 'GATEKEEPER'), { kind: 'user', userId: superadmin.id, isSuperadmin: true, memberships: [], secondFactor: true } as SessionActor]) {
      await expect(proposeHandover(db, actor, organization.id, input, context())).rejects.toBeInstanceOf(TenantAccessError);
    }
    expect(await db.signerHandover.count({ where: { organizationId: organization.id } })).toBe(0);
    expect(await db.auditLog.count({ where: { organizationId: organization.id, action: 'tenant.access_denied' } })).toBeGreaterThanOrEqual(3);
    // El Super-Admin sí ve el equipo (en solo lectura), con su registro.
    const view = await loadSignerTeam(db, { kind: 'user', userId: superadmin.id, isSuperadmin: true, memberships: [] }, organization.id);
    expect(view.seats).toHaveLength(2);
    expect(view.myRole).toBeNull();
  });

  it('la base no deja borrar un relevo ni cambiar uno cerrado, salvo anonimizar el nombre escrito', async () => {
    const { organization, director, cosigner } = await team();
    const { handoverId } = await proposeHandover(db, cosigner.actor, organization.id, { role: 'DIRECTOR', name: 'Cerrado', email: newEmail('cerrado'), roleLabel: 'Dirección' }, context());
    await declineHandover(db, director.actor, organization.id, handoverId, context());
    await expect(db.$executeRawUnsafe(`DELETE FROM ${table('SignerHandover')} WHERE "id" = $1`, handoverId)).rejects.toThrow(/no se borra/);
    await expect(db.$executeRawUnsafe(`UPDATE ${table('SignerHandover')} SET "status" = 'INVITED', "closedAt" = NULL, "consentedAt" = now() WHERE "id" = $1`, handoverId)).rejects.toThrow(/cerrado no se modifica/);
    await expect(db.$executeRawUnsafe(`UPDATE ${table('SignerHandover')} SET "incomingUserId" = 'otra' WHERE "id" = $1`, handoverId)).rejects.toThrow(/no se cambian/);
    await db.$executeRawUnsafe(`UPDATE ${table('SignerHandover')} SET "displayName" = 'anonimizado' WHERE "id" = $1`, handoverId);
    expect((await db.signerHandover.findUniqueOrThrow({ where: { id: handoverId } })).displayName).toBe('anonimizado');
  });
});

describe('cofirma aún sin aceptar y cargos', () => {
  it('quien dirige corrige la invitación pendiente; la cofirma activa no se corrige (es un relevo) y nadie más puede hacerlo', async () => {
    const organization = await createOrganization(db);
    organizations.push(organization.id);
    const director = await createUser(db, { twoFactorEnabled: true });
    await db.organizationMember.create({ data: { organizationId: organization.id, userId: director.id, role: 'DIRECTOR' } });
    const typo = await createUser(db, { email: newEmail('errata') });
    await createInvitation(db, { userId: typo.id, organizationId: organization.id, purpose: 'COSIGNER', roleLabel: 'Tesorería', displayName: 'Errata' });
    const directorActor = actorFor(director.id, organization.id, 'DIRECTOR');

    const before = await loadSignerTeam(db, directorActor, organization.id);
    expect(before.pendingCosigner).toMatchObject({ displayName: 'Errata', roleLabel: 'Tesorería' });
    expect(before.pendingCosigner?.maskedEmail).toMatch(/^er•••@correo-familias\.es$/);

    const fixed = newEmail('correcta');
    await correctCosignerInvitation(db, directorActor, organization.id, { name: 'Correcta', email: fixed, roleLabel: 'Tesorería del AMPA' }, context());
    expect(await db.verification.count({ where: { identifier: `korum-invite:${typo.id}:${organization.id}` } })).toBe(0);
    const after = await loadSignerTeam(db, directorActor, organization.id);
    expect(after.pendingCosigner).toMatchObject({ displayName: 'Correcta', roleLabel: 'Tesorería del AMPA' });
    expect(await db.outboxMessage.count({ where: { organizationId: organization.id, templateKey: 'auth.invitation', toAddress: fixed } })).toBe(1);
    expect(await reason(correctCosignerInvitation(db, directorActor, organization.id, { name: 'Yo', email: (await db.user.findUniqueOrThrow({ where: { id: director.id } })).email, roleLabel: 'Tesorería' }, context()))).toBe('SAME_INBOX');

    const cosigner = await createUser(db, { twoFactorEnabled: true });
    await db.organizationMember.create({ data: { organizationId: organization.id, userId: cosigner.id, role: 'COSIGNER' } });
    await expect(correctCosignerInvitation(db, actorFor(cosigner.id, organization.id, 'COSIGNER'), organization.id, { name: 'X', email: newEmail('x'), roleLabel: 'Tesorería' }, context())).rejects.toBeInstanceOf(TenantAccessError);
    expect(await reason(correctCosignerInvitation(db, directorActor, organization.id, { name: 'Otra', email: newEmail('otra'), roleLabel: 'Tesorería' }, context()))).toBe('SEAT_TAKEN');
  });

  it('cada persona cambia su propio cargo visible, con el antes y el después en la auditoría', async () => {
    const { organization, cosigner } = await team();
    expect(await updateOwnRoleLabel(db, cosigner.actor, organization.id, { roleLabel: 'Tesorería del AMPA' })).toBe('Tesorería del AMPA');
    expect((await db.organizationMember.findUniqueOrThrow({ where: { id: cosigner.member.id } })).roleLabel).toBe('Tesorería del AMPA');
    const audit = await db.auditLog.findFirstOrThrow({ where: { organizationId: organization.id, action: 'signer.role_label_updated' } });
    expect(audit.metadataJson).toMatchObject({ role: 'COSIGNER', before: 'Presidencia del AMPA', after: 'Tesorería del AMPA' });
    await expect(updateOwnRoleLabel(db, cosigner.actor, organization.id, { roleLabel: 'www.falso.es' })).rejects.toBeInstanceOf(TeamRejectedError);
  });
});

describe('auditoría de seguridad del 4.2e', () => {
  it('I1 · si la persona nueva pasa a ocupar el otro puesto antes de aceptar, la aceptación se deshace entera', async () => {
    const { organization, director, cosigner } = await team();
    const email = newEmail('doble-puesto');
    const { handoverId } = await proposeHandover(db, director.actor, organization.id, { role: 'DIRECTOR', name: 'Doble', email, roleLabel: 'Dirección' }, context());
    const incoming = await db.user.findUniqueOrThrow({ where: { canonicalEmail: email } });
    const token = await invitationToken(incoming.id, organization.id, handoverId);
    await db.organizationMember.delete({ where: { id: cosigner.member.id } });
    await db.organizationMember.create({ data: { organizationId: organization.id, userId: incoming.id, role: 'COSIGNER' } });
    await expect(acceptInvitation(db, token, 'una-clave-larga-y-segura')).rejects.toBeInstanceOf(InvitationError);
    expect(await db.organizationMember.count({ where: { id: director.member.id } })).toBe(1);
    expect(await db.signerHandover.findUniqueOrThrow({ where: { id: handoverId } })).toMatchObject({ status: 'INVITED' });
  });

  it('I2 · un relevo caducado no se reenvía: se cierra y hay que proponerlo (y darle el visto bueno) de nuevo', async () => {
    const { organization, director, cosigner } = await team();
    const t0 = new Date('2026-11-12T09:00:00Z');
    const { handoverId } = await proposeHandover(db, cosigner.actor, organization.id, { role: 'DIRECTOR', name: 'Tarde', email: newEmail('tarde2'), roleLabel: 'Dirección' }, context({ now: t0 }));
    await consentHandover(db, director.actor, organization.id, handoverId, context({ now: t0 }));
    const weeksLater = new Date(t0.getTime() + 21 * 24 * HOUR);
    expect(await reason(resendHandoverInvitation(db, cosigner.actor, organization.id, handoverId, { ...context(), now: weeksLater }))).toBe('NOT_FOUND');
    expect(await db.signerHandover.findUniqueOrThrow({ where: { id: handoverId } })).toMatchObject({ status: 'EXPIRED' });
  });

  it('I3 · invitar o corregir a la cofirma exige el código reciente; I4 · sin invitación pendiente también se puede invitar', async () => {
    const organization = await createOrganization(db);
    organizations.push(organization.id);
    const director = await createUser(db, { twoFactorEnabled: true });
    await db.organizationMember.create({ data: { organizationId: organization.id, userId: director.id, role: 'DIRECTOR' } });
    const actor = actorFor(director.id, organization.id, 'DIRECTOR');
    expect(await reason(correctCosignerInvitation(db, actor, organization.id, { name: 'Sin código', email: newEmail('sin'), roleLabel: 'Tesorería' }, context({ secondFactorFresh: false })))).toBe('REAUTH_REQUIRED');
    await correctCosignerInvitation(db, actor, organization.id, { name: 'Nueva', email: newEmail('nueva-cof'), roleLabel: 'Tesorería' }, context());
    expect((await loadSignerTeam(db, actor, organization.id)).pendingCosigner).toMatchObject({ displayName: 'Nueva' });
  });

  it('I4 · quien ya tiene la invitación de cofirma no entra en un relevo (una sustituiría a la otra), y retirar un relevo no anula invitaciones ajenas', async () => {
    const organization = await createOrganization(db);
    organizations.push(organization.id);
    const director = await createUser(db, { twoFactorEnabled: true });
    await db.organizationMember.create({ data: { organizationId: organization.id, userId: director.id, role: 'DIRECTOR' } });
    const actor = actorFor(director.id, organization.id, 'DIRECTOR');
    const cosignerEmail = newEmail('cof-pend');
    await correctCosignerInvitation(db, actor, organization.id, { name: 'Pendiente', email: cosignerEmail, roleLabel: 'Tesorería' }, context());
    expect(await reason(proposeHandover(db, actor, organization.id, { role: 'DIRECTOR', name: 'Pendiente', email: cosignerEmail, roleLabel: 'Dirección' }, context()))).toBe('INVITEE_BUSY');
    const other = newEmail('otra-dir');
    const { handoverId } = await proposeHandover(db, actor, organization.id, { role: 'DIRECTOR', name: 'Otra', email: other, roleLabel: 'Dirección' }, context());
    expect(await reason(correctCosignerInvitation(db, actor, organization.id, { name: 'Otra', email: other, roleLabel: 'Tesorería' }, context()))).toBe('INVITEE_BUSY');
    await cancelHandover(db, actor, organization.id, handoverId);
    const pending = await db.user.findUniqueOrThrow({ where: { canonicalEmail: cosignerEmail } });
    expect(await db.verification.count({ where: { identifier: `korum-invite:${pending.id}:${organization.id}` } })).toBe(1);
  });

  it('I5 · quien da el visto bueno ve el email completo mientras decide; los demás, a medias', async () => {
    const { organization, director, cosigner } = await team();
    const email = newEmail('marta.gil');
    await proposeHandover(db, cosigner.actor, organization.id, { role: 'DIRECTOR', name: 'Marta Gil', email, roleLabel: 'Dirección' }, context());
    expect((await loadSignerTeam(db, director.actor, organization.id)).handover?.email).toBe(email);
    expect((await loadSignerTeam(db, cosigner.actor, organization.id)).handover?.email).toMatch(/^ma•••@correo-familias\.es$/);
  });

  it('M3 · dar o negar el visto bueno por la otra persona queda en la auditoría y no cambia nada', async () => {
    const { organization, director, cosigner } = await team();
    const { handoverId } = await proposeHandover(db, director.actor, organization.id, { role: 'COSIGNER', name: 'Alguien', email: newEmail('m3'), roleLabel: 'Tesorería' }, context());
    expect(await reason(consentHandover(db, director.actor, organization.id, handoverId, context()))).toBe('NOT_FOUND');
    expect(await reason(declineHandover(db, director.actor, organization.id, handoverId, context()))).toBe('NOT_FOUND');
    const denied = await db.auditLog.findMany({ where: { organizationId: organization.id, action: 'tenant.access_denied', targetId: handoverId } });
    expect(denied.map((row) => (row.metadataJson as { attempted: string }).attempted).sort()).toEqual(['signer.handover_consent', 'signer.handover_decline']);
    expect(await db.signerHandover.findUniqueOrThrow({ where: { id: handoverId } })).toMatchObject({ status: 'AWAITING_CONSENT' });
    await declineHandover(db, cosigner.actor, organization.id, handoverId, context());
  });

  it('I6 · la cuenta de alguien invitado que nunca aceptó se borra a los 30 días si no queda nada abierto hacia ella', async () => {
    const { organization, director, cosigner } = await team();
    const t0 = new Date();
    const declinedEmail = newEmail('rechazada');
    const { handoverId } = await proposeHandover(db, cosigner.actor, organization.id, { role: 'DIRECTOR', name: 'Rechazada', email: declinedEmail, roleLabel: 'Dirección' }, context());
    await declineHandover(db, director.actor, organization.id, handoverId, context());
    const declined = await db.user.findUniqueOrThrow({ where: { canonicalEmail: declinedEmail } });
    const openEmail = newEmail('abierta');
    await proposeHandover(db, director.actor, organization.id, { role: 'DIRECTOR', name: 'Abierta', email: openEmail, roleLabel: 'Dirección' }, context());
    const open = await db.user.findUniqueOrThrow({ where: { canonicalEmail: openEmail } });
    await db.user.updateMany({ where: { id: { in: [declined.id, open.id] } }, data: { createdAt: new Date(t0.getTime() - 40 * 24 * HOUR) } });
    await purgeUnactivatedInvitees(db, t0, 5_000);
    expect(await db.user.count({ where: { id: declined.id } })).toBe(0);
    expect(await db.user.count({ where: { id: open.id } })).toBe(1);
    // Las personas firmantes (con cargo) nunca entran en la purga.
    expect(await db.user.count({ where: { id: { in: [director.user.id, cosigner.user.id] } } })).toBe(2);
  });
});
