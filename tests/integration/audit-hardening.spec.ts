import { APIError } from 'better-auth/api';
import { hashPassword } from 'better-auth/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAuditQuery } from '@/core/audit/audit-query';
import type { Prisma } from '@/generated/prisma/client';
import { createKorumAuth, type KorumAuth } from '@/lib/auth/auth-config';
import type { KorumPrismaClient } from '@/lib/prisma';
import { trackSignInAttempt, type SignInHookContext } from '@/lib/auth/failed-sign-in';
import { TENANT_DENIED_AUDIT_RULE, TENANT_DENIED_ENTITY_RULE } from '@/lib/rate-limit-rules';
import { getConsoleAudit, getEntityAudit } from '@/repositories/audit.repository';
import { ACCESS_DENIED_OVER_CAP, authorizeTenant, recordAudit, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { markGoalReached } from '@/services/payments/goal-reached';
import { secretFromTotpUri, totpCode } from '../support/totp';
import { createInitiative, createOrganization, createTestClient, createUser, TEST_HMAC_SECRET, uniqueId } from './test-database';

/**
 * Sprint 5.8a · lo que encontraron los auditores de seguridad y de experiencia, cada caso con su prueba (QA-SEC11 y QA-SEC12): el registro de la entidad no
 * sirve para averiguar nada de otra entidad, de KORUM ni de una familia; «sobre qué» se dice con nombre; los fallos del segundo factor se atribuyen a su
 * cuenta; el rastro de los accesos denegados tiene tope; y el cambio de estado nunca anota una transición que no ocurrió.
 */

let db: KorumPrismaClient;
let auth: KorumAuth;
const APP = 'http://localhost:3000';

beforeAll(() => {
  db = createTestClient();
  auth = createKorumAuth({ db, secret: 'integration-better-auth-secret-0123456789', hmacSecret: TEST_HMAC_SECRET, baseURL: APP, production: false, dispatch: () => undefined });
});

afterAll(async () => {
  await db.$disconnect();
});

async function entity(name: string) {
  const organization = await createOrganization(db, { name });
  const director = await createUser(db, { name: `Dirección de ${name}`, twoFactorEnabled: true });
  await db.organizationMember.create({ data: { organizationId: organization.id, userId: director.id, role: 'DIRECTOR', roleLabel: 'Dirección del centro' } });
  const actor: SessionActor = { kind: 'user', userId: director.id, isSuperadmin: false, memberships: [{ organizationId: organization.id, role: 'DIRECTOR' }], secondFactor: true };
  return { organization, director, actor };
}

const row = (data: Partial<Prisma.AuditLogUncheckedCreateInput> & { action: string }) => db.auditLog.create({ data: { actorType: 'USER', targetType: 'Organization', targetId: 'x', ...data } });
const entityQuery = (raw: Record<string, string> = {}) => parseAuditQuery(raw, { allowUnclassified: false });
const superadmin = async (): Promise<SessionActor & { kind: 'user' }> => ({ kind: 'user', userId: (await createUser(db, { isSuperadmin: true, twoFactorEnabled: true, name: 'Equipo KORUM' })).id, isSuperadmin: true, memberships: [], secondFactor: true });

describe('QA-SEC11 · el registro de la entidad no es un oráculo', () => {
  it('pedir algo que no existe y pedir algo de otra entidad se ven exactamente igual; la consola sí los distingue', async () => {
    const a = await entity('Entidad que sondea');
    const missing = await row({ actorUserId: a.director.id, organizationId: a.organization.id, action: 'tenant.resource_not_found', targetType: 'EscrowPayout', targetId: '2000000001' });
    const foreign = await row({ actorUserId: a.director.id, organizationId: a.organization.id, action: 'tenant.resource_outside_tenant', targetType: 'EscrowPayout', targetId: '100000', metadataJson: { ownerOrganizationId: 'org-de-otra-entidad' } });

    const view = await getEntityAudit(db, a.actor, a.organization.id, entityQuery({ familia: 'security' }));
    const shape = (id: number) => {
      const entry = view.page.rows.find((candidate) => candidate.id === id)!;
      return { action: entry.action, category: entry.category, actor: entry.actor.kind, targetType: entry.target.type, hasName: entry.target.name !== null, details: entry.details };
    };
    expect(shape(missing.id)).toEqual(shape(foreign.id));
    expect(shape(foreign.id).action).toBe('tenant.resource_not_found');
    expect(JSON.stringify(view)).not.toContain('resource_outside_tenant');
    expect(JSON.stringify(view)).not.toContain('org-de-otra-entidad');
    // Filtrar por cualquiera de los dos trae los dos: el filtro tampoco los separa.
    for (const accion of ['tenant.resource_not_found', 'tenant.resource_outside_tenant']) {
      const filtered = await getEntityAudit(db, a.actor, a.organization.id, entityQuery({ accion }));
      expect(filtered.page.rows.map((entry) => entry.id).sort()).toEqual([missing.id, foreign.id].sort());
    }
    const consoleView = await getConsoleAudit(db, await superadmin(), parseAuditQuery({ entidad: a.organization.id, accion: 'tenant.resource_outside_tenant' }, { allowUnclassified: true }));
    expect(consoleView.page.rows.map((entry) => entry.id)).toEqual([foreign.id]);
  });

  it('no ve las consultas que una familia envía a KORUM, y las dirigidas a ella salen sin su autora aunque firme por la entidad', async () => {
    const a = await entity('Entidad con consultas');
    const toEntity = await row({ actorUserId: a.director.id, organizationId: a.organization.id, action: 'support.ticket_created', targetType: 'SupportTicket', targetId: '41', metadataJson: { topic: 'INITIATIVE', target: 'ORGANIZATION' }, userAgent: 'Safari/iOS' });
    await row({ actorUserId: a.director.id, organizationId: a.organization.id, action: 'support.ticket_created', targetType: 'SupportTicket', targetId: '42', metadataJson: { topic: 'RECTIFICATION', target: 'SUPERADMIN' } });
    await row({ actorUserId: a.director.id, organizationId: a.organization.id, action: 'support.ticket_created', targetType: 'SupportTicket', targetId: '43' });

    const view = await getEntityAudit(db, a.actor, a.organization.id, entityQuery({ familia: 'support' }));
    expect(view.page.rows.map((entry) => entry.id)).toEqual([toEntity.id]);
    // Quien escribe como familia no lleva su nombre ni su dispositivo.
    expect(view.page.rows[0]).toMatchObject({ actor: { kind: 'other' }, device: null });
    expect(JSON.stringify(view.page.rows)).not.toContain(a.director.name);
  });

  it('las lecturas de KORUM no se cuelan por otra puerta, ni lo que una persona hace con su cuenta o su aportación mensual, ni el Auto-Impulso', async () => {
    const a = await entity('Entidad con lecturas');
    const admin = await superadmin();
    const own = await row({ actorUserId: a.director.id, organizationId: a.organization.id, action: 'kyb.document_opened', targetType: 'KybDocument', targetId: '5', userAgent: 'Firefox/Linux' });
    for (const action of ['kyb.document_opened', 'payout.invoice_opened', 'activity_fund.receipt_downloaded', 'tax.model182_exported', 'panel.medal_kit_downloaded']) {
      await row({ actorUserId: admin.userId, organizationId: a.organization.id, action, targetType: 'Organization', targetId: a.organization.id });
    }
    for (const action of ['pledge.started', 'pledge.paused', 'pledge.access_denied', 'account.passkey_added', 'privacy.export', 'auth.sign_in_failed_repeatedly', 'selfboost.executed']) {
      await row({ actorUserId: a.director.id, organizationId: a.organization.id, action, targetType: 'WalletSubscription', targetId: '9' });
    }
    // Lo que KORUM cambia en la entidad sí se ve, como KORUM y sin su dispositivo.
    const changed = await row({ actorUserId: admin.userId, organizationId: a.organization.id, action: 'kyb.verified', targetType: 'Organization', targetId: a.organization.id, userAgent: 'Chrome/Windows' });

    const view = await getEntityAudit(db, a.actor, a.organization.id, {});
    expect(view.page.rows.map((entry) => entry.id).sort()).toEqual([own.id, changed.id].sort());
    const byId = new Map(view.page.rows.map((entry) => [entry.id, entry]));
    expect(byId.get(own.id)).toMatchObject({ actor: { kind: 'member' }, device: 'Firefox/Linux' });
    expect(byId.get(changed.id)).toMatchObject({ actor: { kind: 'korum', name: null, email: null }, device: null });
  });

  it('quien firmó antes y fue relevado sale como firmante anterior, sin nombre; «sobre qué» lleva el nombre de lo suyo y nunca el de otra entidad', async () => {
    const a = await entity('Entidad con relevo');
    const b = await entity('Entidad vecina');
    const former = await createUser(db, { name: 'Antigua Directora Con Nombre' });
    await db.signerHandover.create({
      data: { organizationId: a.organization.id, role: 'DIRECTOR', outgoingMemberId: 1, outgoingUserId: former.id, incomingUserId: a.director.id, roleLabel: 'Dirección del centro', displayName: 'Nueva', proposedByUserId: former.id, status: 'COMPLETED', expiresAt: new Date(Date.now() + 3_600_000), closedAt: new Date() }
    });
    const mine = await createInitiative(db, a.organization.id, { title: 'Toldos para el patio de infantil' });
    const theirs = await createInitiative(db, b.organization.id, { title: 'Campaña secreta de la entidad vecina' });
    const sponsor = await db.sponsor.create({ data: { organizationId: a.organization.id, name: 'Panadería La Espiga', contactPerson: 'Pruebas', phone: '600000000', email: `${uniqueId('comercio')}@pruebas.example`, sector: 'Panadería', tierLabel: 'Oro', amountCents: 25_000, feeGeneratedCents: 3_750, promo: '', code: uniqueId('SP'), status: 'APPROVED', expiresAt: new Date(Date.now() + 86_400_000) } });

    const signed = await row({ actorUserId: former.id, organizationId: a.organization.id, action: 'double_check.signed', targetType: 'ESCROW_PAYOUT', targetId: '3', userAgent: 'Chrome/Windows' });
    const published = await row({ actorUserId: a.director.id, organizationId: a.organization.id, action: 'studio.initiative_published', targetType: 'Initiative', targetId: String(mine.id) });
    const probed = await row({ actorUserId: a.director.id, organizationId: a.organization.id, action: 'tenant.resource_outside_tenant', targetType: 'Initiative', targetId: String(theirs.id) });
    const approved = await row({ actorUserId: a.director.id, organizationId: a.organization.id, action: 'sponsor.approved', targetType: 'Sponsor', targetId: String(sponsor.id) });
    const handover = await row({ actorUserId: a.director.id, organizationId: a.organization.id, action: 'signer.handover_completed', targetType: 'SignerHandover', targetId: 'cm3k2l9x00002ab12cd' });
    const denied = await row({ actorUserId: a.director.id, organizationId: a.organization.id, action: 'api.panel_medalla_denied', targetType: 'Route', targetId: 'api/panel/medalla' });

    const view = await getEntityAudit(db, a.actor, a.organization.id, {});
    const byId = new Map(view.page.rows.map((entry) => [entry.id, entry]));
    expect(byId.get(signed.id)).toMatchObject({ actor: { kind: 'formerMember' }, device: null });
    expect(byId.get(published.id)!.target).toEqual({ type: 'Initiative', id: String(mine.id), name: 'Toldos para el patio de infantil' });
    expect(byId.get(approved.id)!.target).toEqual({ type: 'Sponsor', id: String(sponsor.id), name: 'Panadería La Espiga' });
    // El número de una campaña ajena no trae su título; un código interno o una ruta técnica no se enseñan.
    expect(byId.get(probed.id)!.target).toEqual({ type: 'Initiative', id: String(theirs.id), name: null });
    expect(byId.get(handover.id)!.target).toEqual({ type: 'SignerHandover', id: null, name: null });
    expect(byId.get(denied.id)!.target).toEqual({ type: 'Route', id: null, name: null });
    const text = JSON.stringify(view);
    for (const secret of ['Antigua Directora Con Nombre', former.email, 'Campaña secreta de la entidad vecina', 'cm3k2l9x00002ab12cd', 'api/panel/medalla']) expect(text).not.toContain(secret);

    // La consola sí resuelve el título de cualquier campaña y conserva el código para investigar, pero tampoco enseña la ruta técnica.
    const consoleView = await getConsoleAudit(db, await superadmin(), parseAuditQuery({ entidad: a.organization.id }, { allowUnclassified: true }));
    const consoleById = new Map(consoleView.page.rows.map((entry) => [entry.id, entry]));
    expect(consoleById.get(probed.id)!.target.name).toBe('Campaña secreta de la entidad vecina');
    expect(consoleById.get(handover.id)!.target.id).toBe('cm3k2l9x00002ab12cd');
    expect(consoleById.get(denied.id)!.target.id).toBeNull();
  });
});

describe('QA-SEC11 · segunda pasada: ni el filtro por persona, ni los fallos de KORUM, ni sus facturas', () => {
  it('filtrar por una firmante no trae la consulta que escribió como familia: sale sin nombre y el filtro tampoco dice de quién es', async () => {
    const a = await entity('Entidad con una firmante que también es familia');
    const cosigner = await createUser(db, { name: 'Cofirmante Que Escribe Como Madre', twoFactorEnabled: true });
    await db.organizationMember.create({ data: { organizationId: a.organization.id, userId: cosigner.id, role: 'COSIGNER' } });
    const ticket = await row({ actorUserId: cosigner.id, organizationId: a.organization.id, action: 'support.ticket_created', targetType: 'SupportTicket', targetId: '71', metadataJson: { topic: 'INITIATIVE', target: 'ORGANIZATION' } });
    const vote = await row({ actorUserId: cosigner.id, organizationId: a.organization.id, action: 'resize.vote_option', targetType: 'Initiative', targetId: '1' });
    const signed = await row({ actorUserId: cosigner.id, organizationId: a.organization.id, action: 'double_check.signed', targetType: 'ESCROW_PAYOUT', targetId: '8' });

    const all = await getEntityAudit(db, a.actor, a.organization.id, {});
    expect(all.page.rows.map((entry) => entry.id).sort()).toEqual([ticket.id, vote.id, signed.id].sort());
    for (const id of [ticket.id, vote.id]) expect(all.page.rows.find((entry) => entry.id === id)!.actor).toEqual({ kind: 'other' });
    const byHer = await getEntityAudit(db, a.actor, a.organization.id, entityQuery({ persona: cosigner.id }));
    expect(byHer.applied.personUserId).toBe(cosigner.id);
    expect(byHer.page.rows.map((entry) => entry.id)).toEqual([signed.id]);
    // La consola sí busca todo lo que hizo.
    const consoleView = await getConsoleAudit(db, await superadmin(), parseAuditQuery({ persona: cosigner.id }, { allowUnclassified: true }));
    expect(consoleView.page.rows.map((entry) => entry.id).sort()).toEqual([ticket.id, vote.id, signed.id].sort());
  });

  it('lo que el equipo de KORUM deja en la familia de seguridad al consultar no se ve en el panel; lo que deja cualquier otra cuenta, sí', async () => {
    const a = await entity('Entidad consultada por KORUM');
    const admin = await superadmin();
    const outsider = await createUser(db);
    for (const action of ['tenant.resource_not_found', 'tenant.resource_outside_tenant', 'kyb.document_not_found', 'panel.medal_kit_denied', 'tenant.access_denied']) {
      await row({ actorUserId: admin.userId, organizationId: a.organization.id, action, targetType: 'KybDocument', targetId: '12', metadataJson: { reason: 'SUPERADMIN_EXCLUDED' } });
    }
    const denied = await row({ actorUserId: outsider.id, organizationId: a.organization.id, action: 'tenant.access_denied', metadataJson: { reason: 'NOT_A_MEMBER' } });
    const anonymous = await row({ actorUserId: null, organizationId: a.organization.id, action: 'tenant.access_denied', metadataJson: { reason: 'ANONYMOUS' } });
    const ownProbe = await row({ actorUserId: a.director.id, organizationId: a.organization.id, action: 'kyb.document_not_found', targetType: 'KybDocument', targetId: '13' });

    const view = await getEntityAudit(db, a.actor, a.organization.id, {});
    expect(view.page.rows.map((entry) => entry.id).sort()).toEqual([denied.id, anonymous.id, ownProbe.id].sort());
    expect(view.page.rows.some((entry) => entry.actor.kind === 'korum')).toBe(false);
    // La consola las conserva todas.
    const consoleView = await getConsoleAudit(db, await superadmin(), parseAuditQuery({ entidad: a.organization.id, familia: 'security' }, { allowUnclassified: true }));
    expect(consoleView.page.rows).toHaveLength(8);
  });

  it('retirar a alguien del equipo de KORUM no cambia el registro de la entidad: sus consultas siguen sin verse y sus cambios siguen siendo de KORUM', async () => {
    const a = await entity('Entidad que consultó un Super-Admin retirado');
    const admin = await superadmin();
    await row({ actorUserId: admin.userId, organizationId: a.organization.id, action: 'kyb.document_not_found', targetType: 'KybDocument', targetId: '4' });
    await row({ actorUserId: admin.userId, organizationId: a.organization.id, action: 'tenant.access_denied', metadataJson: { reason: 'SUPERADMIN_EXCLUDED' } });
    await row({ actorUserId: admin.userId, organizationId: a.organization.id, action: 'kyb.document_opened', targetType: 'KybDocument', targetId: '4' });
    const verified = await row({ actorUserId: admin.userId, organizationId: a.organization.id, action: 'kyb.verified', targetType: 'Organization', targetId: a.organization.id });
    const seen = async () => (await getEntityAudit(db, a.actor, a.organization.id, {})).page.rows.map((entry) => [entry.id, entry.actor.kind]);
    const before = await seen();
    expect(before).toEqual([[verified.id, 'korum']]);

    // La baja, como la deja la consola: la cuenta pierde el rol y queda `superadmin.revoked` en la auditoría.
    await db.user.update({ where: { id: admin.userId }, data: { isSuperadmin: false } });
    await row({ actorUserId: (await superadmin()).userId, organizationId: null, action: 'superadmin.revoked', targetType: 'User', targetId: admin.userId });
    expect(await seen()).toEqual(before);
  });

  it('la pertenencia a KORUM se juzga por la fecha de cada fila: quien deja KORUM y luego firma, quien firmaba y luego entra en KORUM, y quien ya no es de KORUM y sondea', async () => {
    const a = await entity('Entidad con cuentas que cambian de papel');
    const HOUR = 3_600_000;
    const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * HOUR);
    const revoke = (userId: string, when: Date) => row({ actorType: 'SYSTEM', actorUserId: null, organizationId: null, action: 'superadmin.revoked', targetType: 'User', targetId: userId, occurredAt: when });
    const join = (userId: string, when: Date) => row({ actorUserId: userId, organizationId: null, action: 'account.invitation_accepted', targetType: 'User', targetId: userId, occurredAt: when, metadataJson: { purpose: 'SUPERADMIN' } });

    // Caso A · fue de KORUM, la retiraron y ahora cofirma por la entidad.
    const exKorum = await createUser(db, { name: 'Ex KORUM Ahora Cofirmante', twoFactorEnabled: true });
    await join(exKorum.id, at(50));
    const opened = await row({ actorUserId: exKorum.id, organizationId: a.organization.id, action: 'kyb.document_opened', targetType: 'KybDocument', targetId: '6', occurredAt: at(40) });
    const verified = await row({ actorUserId: exKorum.id, organizationId: a.organization.id, action: 'kyb.verified', targetType: 'Organization', targetId: a.organization.id, occurredAt: at(39) });
    await revoke(exKorum.id, at(30));
    await db.organizationMember.create({ data: { organizationId: a.organization.id, userId: exKorum.id, role: 'COSIGNER' } });
    const wrongSigner = await row({ actorUserId: exKorum.id, organizationId: a.organization.id, action: 'double_check.wrong_signer', targetType: 'ESCROW_PAYOUT', targetId: '3', occurredAt: at(2) });
    const signedNow = await row({ actorUserId: exKorum.id, organizationId: a.organization.id, action: 'double_check.signed', targetType: 'ESCROW_PAYOUT', targetId: '3', occurredAt: at(1) });

    // Caso B · firmaba por la entidad, la relevaron y después entró en el equipo de KORUM.
    const exSigner = await createUser(db, { name: 'Firmaba Y Ahora Es De KORUM', twoFactorEnabled: true });
    await db.signerHandover.create({
      data: { organizationId: a.organization.id, role: 'COSIGNER', outgoingMemberId: 1, outgoingUserId: exSigner.id, incomingUserId: exKorum.id, roleLabel: 'Cofirma', displayName: 'Nueva', proposedByUserId: a.director.id, status: 'COMPLETED', expiresAt: at(-1), closedAt: at(31) }
    });
    const oldSignature = await row({ actorUserId: exSigner.id, organizationId: a.organization.id, action: 'double_check.signed', targetType: 'ESCROW_PAYOUT', targetId: '2', occurredAt: at(60) });
    const oldLock = await row({ actorUserId: exSigner.id, organizationId: a.organization.id, action: 'double_check.otp_locked', targetType: 'ESCROW_PAYOUT', targetId: '2', occurredAt: at(59) });
    await db.user.update({ where: { id: exSigner.id }, data: { isSuperadmin: true } });
    await join(exSigner.id, at(20));
    const asKorum = await row({ actorUserId: exSigner.id, organizationId: a.organization.id, action: 'kyb.document_not_found', targetType: 'KybDocument', targetId: '9', occurredAt: at(10) });

    // Caso C · fue de KORUM, la retiraron y, ya sin el rol, intenta entrar en el panel de la entidad.
    const retired = await createUser(db, { name: 'Retirada Que Sondea' });
    await join(retired.id, at(50));
    const whileKorum = await row({ actorUserId: retired.id, organizationId: a.organization.id, action: 'tenant.access_denied', occurredAt: at(45), metadataJson: { reason: 'SUPERADMIN_EXCLUDED' } });
    await revoke(retired.id, at(30));
    const afterKorum = await row({ actorUserId: retired.id, organizationId: a.organization.id, action: 'tenant.access_denied', occurredAt: at(5), metadataJson: { reason: 'NOT_A_MEMBER' } });

    const view = await getEntityAudit(db, a.actor, a.organization.id, {});
    const seen = new Map(view.page.rows.map((entry) => [entry.id, entry.actor]));
    // A · lo que consultó como KORUM no se ve y lo que cambió como KORUM es de KORUM; lo que hace hoy como cofirmante se ve con su nombre.
    expect(seen.has(opened.id)).toBe(false);
    expect(seen.get(verified.id)).toEqual({ kind: 'korum', name: null, email: null });
    expect(seen.get(wrongSigner.id)).toMatchObject({ kind: 'member', name: 'Ex KORUM Ahora Cofirmante', role: 'COSIGNER' });
    expect(seen.get(signedNow.id)).toMatchObject({ kind: 'member' });
    // B · su firma de entonces sigue siendo de una persona que firmaba por la entidad (KORUM nunca firma) y su bloqueo de entonces sigue viéndose; lo que
    // deja ahora como KORUM en la familia de seguridad, no.
    expect(seen.get(oldSignature.id)).toEqual({ kind: 'formerMember' });
    expect(seen.get(oldLock.id)).toEqual({ kind: 'formerMember' });
    expect(seen.has(asKorum.id)).toBe(false);
    // C · su intento de cuando era de KORUM no se ve; el de después, sí, como el de cualquier otra cuenta.
    expect(seen.has(whileKorum.id)).toBe(false);
    expect(seen.get(afterKorum.id)).toEqual({ kind: 'other' });
    const text = JSON.stringify(view);
    for (const secret of ['Firmaba Y Ahora Es De KORUM', 'Retirada Que Sondea', exSigner.email, retired.email]) expect(text).not.toContain(secret);
    // Filtrar por la cofirmante trae lo que hace como cofirmante, no lo que hizo como KORUM (que sale como «KORUM», pero el filtro diría que fue ella).
    const byHer = await getEntityAudit(db, a.actor, a.organization.id, entityQuery({ persona: exKorum.id }));
    expect(byHer.page.rows.map((entry) => entry.id).sort()).toEqual([wrongSigner.id, signedNow.id].sort());
    expect(byHer.page.rows.every((entry) => entry.actor.kind === 'member')).toBe(true);
  });

  it('la operación de KORUM con sus propias facturas no sale en el panel, y una factura emitida sale sin su número interno', async () => {
    const a = await entity('Entidad con comercios facturados');
    for (const action of ['invoice.accepted', 'invoice.rejected', 'invoice.registration_issue', 'invoice.registration_retry', 'invoice.registration_unknown', 'invoice.registration_resolved']) {
      await row({ actorType: 'SYSTEM', organizationId: a.organization.id, action, targetType: 'Invoice', targetId: '90210' });
    }
    const issued = await row({ actorType: 'SYSTEM', organizationId: a.organization.id, action: 'invoice.issued', targetType: 'Invoice', targetId: '90210', metadataJson: { invoiceNumber: 'KR-2026-000321' } });
    const view = await getEntityAudit(db, a.actor, a.organization.id, {});
    expect(view.page.rows.map((entry) => entry.id)).toEqual([issued.id]);
    expect(view.page.rows[0]!.target).toEqual({ type: 'Invoice', id: null, name: null });
    expect(JSON.stringify(view)).not.toContain('90210');
    expect(JSON.stringify(view)).not.toContain('KR-2026');
  });
});

describe('QA-SEC12 · rastros de seguridad que no se pueden burlar ni desbordar', () => {
  const cookieOf = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(';')[0])
      .join('; ');
  const headersOf = (ip: string, cookie?: string) => new Headers({ 'x-forwarded-for': ip, 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15', origin: APP, ...(cookie ? { cookie } : {}) });
  const status = (work: Promise<Response>) => work.then((response) => response.status).catch((error: { statusCode?: number }) => error.statusCode ?? 500);

  it('quien tiene la contraseña y prueba códigos del segundo factor queda anotado contra esa cuenta, y la contraseña buena no pone el contador a cero', async () => {
    const password = 'una-contraseña-larga-de-pruebas';
    const user = await createUser(db);
    await db.account.create({ data: { id: uniqueId('acc'), userId: user.id, accountId: user.id, providerId: 'credential', password: await hashPassword(password) } });
    const first = await auth.api.signInEmail({ body: { email: user.email, password }, headers: headersOf('192.0.2.50'), asResponse: true });
    const session = cookieOf(first);
    const enabled = (await auth.api.enableTwoFactor({ body: { password }, headers: headersOf('192.0.2.50', session) })) as { totpURI?: string };
    const secret = secretFromTotpUri(enabled.totpURI!);
    expect(await status(auth.api.verifyTOTP({ body: { code: totpCode(secret) }, headers: headersOf('192.0.2.50', session), asResponse: true }))).toBe(200);
    await db.rateLimit.deleteMany({ where: { key: { contains: user.id } } });

    const failed = () => db.auditLog.findMany({ where: { action: 'auth.sign_in_failed_repeatedly', targetId: user.id }, orderBy: { id: 'asc' } });
    const wrongCode = async (ip: string) => {
      // Cada intento empieza con la contraseña buena (que pide el segundo factor) y sigue con un código que no vale.
      const challenge = await auth.api.signInEmail({ body: { email: user.email, password }, headers: headersOf(ip), asResponse: true });
      expect(await challenge.json()).toMatchObject({ twoFactorRedirect: true });
      return status(auth.api.verifyTOTP({ body: { code: '000000' }, headers: headersOf(ip, cookieOf(challenge)), asResponse: true }));
    };
    expect(await wrongCode('192.0.2.51')).toBe(401);
    expect(await wrongCode('192.0.2.52')).toBe(401);
    expect(await failed()).toHaveLength(0);
    // El tercero, desde otra red y tras otra contraseña buena: se cuenta por cuenta y la contraseña no lo borra.
    expect(await wrongCode('192.0.2.53')).toBe(401);
    const rows = await failed();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ targetType: 'User', actorUserId: null, userAgent: 'Safari/macOS', metadataJson: { method: 'second_factor', failures: 3, knownAccount: true } });
    expect(JSON.stringify(rows)).not.toContain(user.email);
    expect(await db.auditLog.count({ where: { action: 'auth.sign_in_failed_repeatedly', targetType: 'Account', ipHash: { not: null }, occurredAt: { gte: new Date(Date.now() - 60_000) }, metadataJson: { path: ['method'], equals: 'second_factor' } } })).toBe(0);
  });

  it('una misma cuenta no puede llenar de filas el registro de otra entidad: se deniega y se anota siempre, pero la entidad solo ve hasta el tope', async () => {
    const victim = await entity('Entidad a la que quieren tapar el registro');
    const intruder: SessionActor = { kind: 'user', userId: (await createUser(db)).id, isSuperadmin: false, memberships: [], secondFactor: true };
    const attempts = TENANT_DENIED_AUDIT_RULE.limit + 25;
    let denied = 0;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await authorizeTenant(db, intruder, victim.organization.id, { roles: ['DIRECTOR'], action: 'panel.view', targetType: 'Organization' }).catch((error: unknown) => {
        if (error instanceof TenantAccessError) denied += 1;
        else throw error;
      });
    }
    expect(denied).toBe(attempts);
    // Nada se pierde: la consola tiene las 325 filas, las 25 últimas con su acción propia y con el mismo detalle que las demás.
    const mine = { organizationId: victim.organization.id, actorUserId: intruder.userId };
    expect(await db.auditLog.count({ where: { ...mine, action: 'tenant.access_denied' } })).toBe(TENANT_DENIED_AUDIT_RULE.limit);
    expect(await db.auditLog.count({ where: { ...mine, action: ACCESS_DENIED_OVER_CAP } })).toBe(25);
    const consoleView = await getConsoleAudit(db, await superadmin(), parseAuditQuery({ entidad: victim.organization.id, persona: intruder.userId }, { allowUnclassified: true }));
    expect(consoleView.page.rows[0]).toMatchObject({ action: ACCESS_DENIED_OVER_CAP, category: 'security' });
    expect(consoleView.page.rows[0]!.details).toEqual(expect.arrayContaining([{ key: 'attempted', value: 'panel.view' }, { key: 'reason', value: 'NOT_A_MEMBER' }]));

    // La entidad ve las del tope y ni una más, y otra cuenta sigue dejando su rastro visible.
    const other: SessionActor = { kind: 'user', userId: (await createUser(db)).id, isSuperadmin: false, memberships: [], secondFactor: true };
    await expect(authorizeTenant(db, other, victim.organization.id, { roles: ['DIRECTOR'], action: 'panel.view', targetType: 'Organization' })).rejects.toBeInstanceOf(TenantAccessError);
    let seen = 0;
    let before: number | undefined;
    for (;;) {
      const view = await getEntityAudit(db, victim.actor, victim.organization.id, { action: 'tenant.access_denied', before });
      seen += view.page.rows.length;
      if (view.page.nextBefore === null) break;
      before = view.page.nextBefore;
    }
    expect(seen).toBe(TENANT_DENIED_AUDIT_RULE.limit + 1);
  }, 120_000);

  it('cambiar de cuenta o de red, o no tener sesión, no sirve para pasar del tope común de la entidad', async () => {
    const victim = await entity('Entidad con muchos curiosos');
    // Sin sesión y desde redes distintas: cada red tiene su tope, pero todas suman al común. Se parte de un contador común casi lleno.
    await db.rateLimit.create({ data: { id: `${TENANT_DENIED_ENTITY_RULE.prefix}${victim.organization.id}`, key: `${TENANT_DENIED_ENTITY_RULE.prefix}${victim.organization.id}`, count: TENANT_DENIED_ENTITY_RULE.limit - 2, lastRequest: BigInt(Date.now()) } });
    for (let network = 0; network < 5; network += 1) {
      await recordAudit(db, { kind: 'anonymous', requestMeta: { ipHash: `red-${network}`.padEnd(64, '0') } }, { action: 'tenant.access_denied', organizationId: victim.organization.id, targetType: 'Organization', targetId: victim.organization.id, metadata: { attempted: 'kyb.submit', reason: 'ANONYMOUS' } });
    }
    const rows = await db.auditLog.findMany({ where: { organizationId: victim.organization.id }, orderBy: { id: 'asc' } });
    expect(rows.map((entry) => entry.action)).toEqual(['tenant.access_denied', 'tenant.access_denied', ACCESS_DENIED_OVER_CAP, ACCESS_DENIED_OVER_CAP, ACCESS_DENIED_OVER_CAP]);
    expect((await getEntityAudit(db, victim.actor, victim.organization.id, { action: 'tenant.access_denied' })).page.rows).toHaveLength(2);
    // Lo que se deniega al equipo de KORUM no gasta ningún tope: la entidad no lo ve y no debe quitarle sitio a lo que sí ve.
    const korum = await superadmin();
    const counter = () => db.rateLimit.findUniqueOrThrow({ where: { key: `${TENANT_DENIED_ENTITY_RULE.prefix}${victim.organization.id}` }, select: { count: true } });
    const used = (await counter()).count;
    await recordAudit(db, korum, { action: 'tenant.access_denied', organizationId: victim.organization.id, targetType: 'Organization', targetId: victim.organization.id, metadata: { attempted: 'studio.save', reason: 'SUPERADMIN_EXCLUDED' } });
    expect((await counter()).count).toBe(used);
    expect(await db.auditLog.count({ where: { actorUserId: korum.userId, action: 'tenant.access_denied', organizationId: victim.organization.id } })).toBe(1);
    expect(await db.rateLimit.count({ where: { key: { contains: korum.userId } } })).toBe(0);
    // Lo que deniega a quien sí firma por la entidad (le falta el segundo factor, por ejemplo) no gasta el tope común ni queda oculto.
    await recordAudit(db, victim.actor, { action: 'tenant.access_denied', organizationId: victim.organization.id, targetType: 'Organization', targetId: victim.organization.id, metadata: { attempted: 'studio.save', reason: 'SECOND_FACTOR_REQUIRED' } });
    expect((await getEntityAudit(db, victim.actor, victim.organization.id, { action: 'tenant.access_denied' })).page.rows).toHaveLength(3);
  });

  it('con muchos fallos a la vez contra una cuenta, cada uno recibe su número y los avisos salen igual: ni se pierden ni se duplican', async () => {
    const user = await createUser(db);
    const attempt = (index: number): SignInHookContext =>
      ({
        path: '/sign-in/email',
        body: { email: user.email, password: 'no-importa' },
        headers: new Headers({ 'x-forwarded-for': `198.51.100.${(index % 200) + 1}`, 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0' }),
        context: { returned: new APIError('UNAUTHORIZED', { message: 'Invalid email or password' }) }
      }) as unknown as SignInHookContext;
    await Promise.all(Array.from({ length: 40 }, (_, index) => trackSignInAttempt({ db, hmacSecret: TEST_HMAC_SECRET }, attempt(index))));
    const rows = await db.auditLog.findMany({ where: { action: 'auth.sign_in_failed_repeatedly', targetId: user.id } });
    expect(rows.map((entry) => (entry.metadataJson as { failures: number }).failures).sort((a, b) => a - b)).toEqual([3, 8, 18, 38]);
  });

  it('el rastro de «meta conseguida» solo se escribe si la campaña estaba recaudando, y dice quién lo provocó', async () => {
    const organization = await createOrganization(db);
    const closed = await createInitiative(db, organization.id, { status: 'EXPIRED' });
    await db.$transaction((tx) => markGoalReached(tx, organization.id, closed.id, new Date()));
    expect((await db.initiative.findUniqueOrThrow({ where: { id: closed.id }, select: { status: true } })).status).toBe('EXPIRED');
    expect(await db.auditLog.count({ where: { action: 'initiative.status_changed', targetId: String(closed.id) } })).toBe(0);

    const boosted = await createInitiative(db, organization.id, { status: 'FUNDRAISING' });
    const admin = await superadmin();
    await db.$transaction((tx) => markGoalReached(tx, organization.id, boosted.id, new Date(), { triggeredByUserId: admin.userId }));
    const [change] = await db.auditLog.findMany({ where: { action: 'initiative.status_changed', targetId: String(boosted.id) } });
    // Para la entidad es un cambio del sistema, igual que el de un cobro; quién ejecutó el Auto-Impulso va solo en el detalle, que ve la consola.
    expect(change).toMatchObject({ actorType: 'SYSTEM', actorUserId: null, metadataJson: { from: 'FUNDRAISING', to: 'GOAL_REACHED', reason: 'GOAL_REACHED', triggeredByUserId: admin.userId } });
    const byPayment = await createInitiative(db, organization.id, { status: 'FUNDRAISING' });
    await db.$transaction((tx) => markGoalReached(tx, organization.id, byPayment.id, new Date()));
    const director: SessionActor = { kind: 'user', userId: (await createUser(db)).id, isSuperadmin: false, memberships: [{ organizationId: organization.id, role: 'DIRECTOR' }], secondFactor: true };
    const seen = (await getEntityAudit(db, director, organization.id, entityQuery({ accion: 'initiative.status_changed' }))).page.rows;
    const shape = (id: number) => {
      const entry = seen.find((candidate) => candidate.target.id === String(id))!;
      return { action: entry.action, actor: entry.actor, device: entry.device, statusChange: entry.statusChange, details: entry.details };
    };
    expect(shape(boosted.id)).toEqual(shape(byPayment.id));
    expect(JSON.stringify(seen)).not.toContain(admin.userId);
    // La campaña de otra entidad no se toca aunque se pase su número.
    const foreign = await createInitiative(db, (await createOrganization(db)).id, { status: 'FUNDRAISING' });
    await db.$transaction((tx) => markGoalReached(tx, organization.id, foreign.id, new Date()));
    expect((await db.initiative.findUniqueOrThrow({ where: { id: foreign.id }, select: { status: true } })).status).toBe('FUNDRAISING');
  });
});
