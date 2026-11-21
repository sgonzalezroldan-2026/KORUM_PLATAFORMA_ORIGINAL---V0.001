import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPersonalDataExport } from '@/core/privacy/personal-data-export';
import { markSessionReauthenticated, verifyAccountSession } from '@/core/security/verified-actor';
import type { KorumPrismaClient } from '@/lib/prisma';
import { erasePersonalData } from '@/core/privacy/erasure.service';
import { revertEmailChange } from '@/services/account/email-change-revert.service';
import { confirmEmailChange, EMAIL_CHANGE_MAX_ATTEMPTS, pendingEmailChange, requestEmailChange } from '@/services/account/email-change.service';
import { listSupportTicketsOf, submitSupportTicket } from '@/services/support/support-requests.service';
import { createInitiative, createOrganization, createTestClient, createUser, TEST_HMAC_SECRET, TEST_KEYRING, uniqueId } from './test-database';

/** Sprint 5.10b · QA-LEG03: cambio de email verificado y autoría de cada consulta (`L-053`, decisiones 88 y 89). */

let db: KorumPrismaClient;
const MINUTE = 60_000;

beforeAll(() => {
  db = createTestClient();
});

afterAll(async () => {
  await db.$disconnect();
});

const newSession = (userId: string) => db.session.create({ data: { id: uniqueId('ses'), token: uniqueId('tok'), userId, expiresAt: new Date(Date.now() + 60 * MINUTE) } });

/** Titular reautenticado en esta sesión: con un código por email o, si `secondFactor`, con la app de verificación. */
async function verified(userId: string, secondFactor = false) {
  const session = await newSession(userId);
  await markSessionReauthenticated(db, session.id, { secondFactor });
  return { actor: await verifyAccountSession(db, { userId, sessionId: session.id, operation: 'account.email_change' }), session };
}

const dispatched: number[] = [];
const deps = { hmacSecret: TEST_HMAC_SECRET, appUrl: 'https://korum.test', dispatch: (ids: readonly number[]) => void dispatched.push(...ids) };

/** El código que salió al email nuevo (en la bandeja hasta que se envía; después se borra por ser un secreto). */
async function codeSentTo(email: string): Promise<string> {
  const message = await db.outboxMessage.findFirstOrThrow({ where: { templateKey: 'account.emailChangeCode', toAddress: email }, orderBy: { id: 'desc' } });
  return (message.payloadJson as { code: string }).code;
}

const freshEmail = (prefix: string) => `${uniqueId(prefix)}@pruebas.example`;

describe('QA-LEG03 · cambio de email verificado', () => {
  it('con el código del email nuevo, la cuenta cambia de email y todo lo que colgaba del antiguo pasa al nuevo', async () => {
    const organization = await createOrganization(db);
    const initiative = await createInitiative(db, organization.id);
    const person = await createUser(db);
    const oldEmail = person.email;
    await db.organizationMember.create({ data: { organizationId: organization.id, userId: person.id, role: 'DIRECTOR' } });
    await db.organization.update({ where: { id: organization.id }, data: { contactEmail: oldEmail } });
    // Una compra como invitada con el email (y su entrada), una idea propuesta, una consulta anterior al 5.10b sin autora guardada y un email recibido.
    const guest = await db.contribution.create({ data: { organizationId: organization.id, initiativeId: initiative.id, fiscalYear: 2026, amountCents: 1_500, totalChargedCents: 1_500, paymentMethod: 'CARD', status: 'COMPLETED', type: 'TICKET', guestEmail: oldEmail, canonicalEmail: person.canonicalEmail } });
    const pass = await db.ticketPass.create({ data: { contributionId: guest.id, initiativeId: initiative.id, serialCode: uniqueId('TCK'), holderEmail: oldEmail, qrHmacSignature: 'firma' } });
    const idea = await db.idea.create({ data: { organizationId: organization.id, alias: uniqueId('FAM'), authorCanonicalEmail: person.canonicalEmail, title: 'Más sombra', category: 'Patio', description: 'Toldos en infantil', expiresAt: new Date(Date.now() + 30 * 86_400_000) } });
    const oldTicket = await db.supportTicket.create({ data: { ticketCode: uniqueId('TCK'), organizationId: organization.id, originLabel: organization.name, senderEmail: oldEmail, topic: 'PAYMENT', subject: 'Mi pago', message: 'Una pregunta sobre mi pago' } });
    const received = await db.outboxMessage.create({ data: { idempotencyKey: uniqueId('recibo'), templateKey: 'contribution.receipt', toAddress: oldEmail, payloadJson: {}, status: 'SENT' } });
    const otherSession = await newSession(person.id);

    const { actor, session } = await verified(person.id);
    const newEmail = freshEmail('nueva');
    expect(await requestEmailChange(db, deps, { actor, newEmail: ` ${newEmail.toUpperCase()} ` })).toEqual({ status: 'CODE_SENT', email: newEmail, minutes: 10 });
    expect(await pendingEmailChange(db, person.id)).toMatchObject({ email: newEmail });
    const code = await codeSentTo(newEmail);
    // Un código equivocado no cambia nada y gasta un intento.
    const wrong = code === '000000' ? '111111' : '000000';
    expect(await confirmEmailChange(db, deps, { actor, code: wrong })).toEqual({ status: 'REJECTED', reason: 'INVALID_CODE' });
    expect((await db.user.findUniqueOrThrow({ where: { id: person.id } })).email).toBe(oldEmail);

    expect(await confirmEmailChange(db, deps, { actor, code })).toEqual({ status: 'CHANGED', email: newEmail });
    const user = await db.user.findUniqueOrThrow({ where: { id: person.id } });
    expect(user).toMatchObject({ email: newEmail, canonicalEmail: newEmail, emailVerified: true });
    expect(await db.contribution.findUniqueOrThrow({ where: { id: guest.id } })).toMatchObject({ guestEmail: newEmail, canonicalEmail: newEmail, amountCents: 1_500 });
    expect((await db.ticketPass.findUniqueOrThrow({ where: { id: pass.id } })).holderEmail).toBe(newEmail);
    expect((await db.idea.findUniqueOrThrow({ where: { id: idea.id } })).authorCanonicalEmail).toBe(newEmail);
    expect(await db.supportTicket.findUniqueOrThrow({ where: { id: oldTicket.id } })).toMatchObject({ senderEmail: newEmail, senderUserId: person.id });
    expect(await db.outboxMessage.findUniqueOrThrow({ where: { id: received.id } })).toMatchObject({ toAddress: oldEmail, userId: person.id });
    expect((await db.organization.findUniqueOrThrow({ where: { id: organization.id } })).contactEmail).toBe(newEmail);
    // Las demás sesiones se cierran; la de quien hizo el cambio sigue.
    expect(await db.session.findUnique({ where: { id: otherSession.id } })).toBeNull();
    expect(await db.session.findUnique({ where: { id: session.id } })).not.toBeNull();
    expect(await pendingEmailChange(db, person.id)).toBeNull();
    // Aviso al email antiguo, auditoría sin ningún email y la rectificación en «Mis solicitudes».
    const notice = await db.outboxMessage.findFirstOrThrow({ where: { templateKey: 'account.emailChanged', userId: person.id } });
    expect(notice.toAddress).toBe(oldEmail);
    expect(dispatched).toContain(notice.id);
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'account.email_changed', targetId: person.id } });
    expect(audit.actorUserId).toBe(person.id);
    expect(JSON.stringify(audit.metadataJson)).not.toMatch(/@/);
    expect(audit.metadataJson).toMatchObject({ tickets: 1, purchases: 1, passes: 1, ideas: 1 });
    expect(await db.privacyRequest.findFirst({ where: { userId: person.id, type: 'RECTIFICATION', status: 'COMPLETED' } })).not.toBeNull();

    // Quien abra después una cuenta con el email antiguo no ve nada de la persona anterior.
    const newcomer = await createUser(db, { email: oldEmail, canonicalEmail: oldEmail });
    expect(await listSupportTicketsOf(db, newcomer)).toEqual([]);
    const { actor: newcomerActor } = await verified(newcomer.id);
    const copy = await buildPersonalDataExport(db, TEST_KEYRING, { kind: 'self', actor: newcomerActor });
    expect(copy.contributions).toEqual([]);
    expect(copy.tickets).toEqual([]);
    expect(copy.supportTickets).toEqual([]);
    expect(copy.ideaProposals).toEqual([]);
    expect(copy.notifications.map((row) => row.template)).not.toContain('contribution.receipt');
    // Y la persona sigue viendo lo suyo con el email nuevo.
    expect((await listSupportTicketsOf(db, user)).map((row) => row.ticketCode)).toEqual([oldTicket.ticketCode]);
  });

  it('quien no controla el email nuevo no puede quedárselo: sin código no cambia, se agotan los intentos y un email con cuenta se rechaza solo tras demostrar que es suyo', async () => {
    const owner = await createUser(db);
    const intruder = await createUser(db);
    const { actor } = await verified(intruder.id);
    // No se revela al pedir el código que ese email tiene cuenta: el código sale igual (y solo lo recibe su dueña).
    expect(await requestEmailChange(db, deps, { actor, newEmail: owner.email })).toMatchObject({ status: 'CODE_SENT' });
    const real = await codeSentTo(owner.email);
    const wrong = real === '999999' ? '888888' : '999999';
    for (let attempt = 1; attempt < EMAIL_CHANGE_MAX_ATTEMPTS; attempt += 1) expect(await confirmEmailChange(db, deps, { actor, code: wrong })).toEqual({ status: 'REJECTED', reason: 'INVALID_CODE' });
    expect(await confirmEmailChange(db, deps, { actor, code: wrong })).toEqual({ status: 'REJECTED', reason: 'TOO_MANY_ATTEMPTS' });
    // Agotados los intentos, ni el código bueno vale: hay que pedir otro.
    expect(await confirmEmailChange(db, deps, { actor, code: real })).toEqual({ status: 'REJECTED', reason: 'NO_PENDING' });
    // Aunque tuviera el código, ese email es de otra cuenta.
    await requestEmailChange(db, deps, { actor, newEmail: owner.email });
    expect(await confirmEmailChange(db, deps, { actor, code: await codeSentTo(owner.email) })).toEqual({ status: 'REJECTED', reason: 'EMAIL_TAKEN' });
    expect((await db.user.findUniqueOrThrow({ where: { id: intruder.id } })).email).toBe(intruder.email);
    expect((await db.user.findUniqueOrThrow({ where: { id: owner.id } })).email).toBe(owner.email);
  });

  it('rechaza un email mal escrito, desechable o el mismo; un código caducado no vale; quien firma con 2FA confirma con su app', async () => {
    const person = await createUser(db);
    const { actor } = await verified(person.id);
    expect(await requestEmailChange(db, deps, { actor, newEmail: 'sin-arroba' })).toEqual({ status: 'REJECTED', reason: 'INVALID_EMAIL' });
    expect(await requestEmailChange(db, deps, { actor, newEmail: `${uniqueId('x')}@mailinator.com` })).toEqual({ status: 'REJECTED', reason: 'DISPOSABLE_EMAIL' });
    expect(await requestEmailChange(db, deps, { actor, newEmail: person.email.toUpperCase() })).toEqual({ status: 'REJECTED', reason: 'SAME_EMAIL' });
    expect(await confirmEmailChange(db, deps, { actor, code: '123456' })).toEqual({ status: 'REJECTED', reason: 'NO_PENDING' });

    const later = freshEmail('tarde');
    await requestEmailChange(db, deps, { actor, newEmail: later });
    const code = await codeSentTo(later);
    await db.verification.updateMany({ where: { identifier: `korum-email-change:${person.id}` }, data: { expiresAt: new Date(Date.now() - 1) } });
    expect(await confirmEmailChange(db, deps, { actor, code })).toEqual({ status: 'REJECTED', reason: 'EXPIRED' });

    const signer = await createUser(db, { twoFactorEnabled: true });
    const byEmail = await verified(signer.id, false);
    expect(await requestEmailChange(db, deps, { actor: byEmail.actor, newEmail: freshEmail('firma') })).toEqual({ status: 'REJECTED', reason: 'SECOND_FACTOR_REQUIRED' });
    const byApp = await verified(signer.id, true);
    expect(await requestEmailChange(db, deps, { actor: byApp.actor, newEmail: freshEmail('firma') })).toMatchObject({ status: 'CODE_SENT' });
  });

  it('«No he sido yo»: el enlace del aviso al email antiguo lo devuelve todo, cierra todas las sesiones y sirve una sola vez', async () => {
    const organization = await createOrganization(db);
    const initiative = await createInitiative(db, organization.id);
    const person = await createUser(db);
    const oldEmail = person.email;
    const purchase = await db.contribution.create({ data: { organizationId: organization.id, initiativeId: initiative.id, fiscalYear: 2026, amountCents: 900, totalChargedCents: 900, paymentMethod: 'CARD', status: 'COMPLETED', guestEmail: oldEmail, canonicalEmail: person.canonicalEmail } });
    const { actor } = await verified(person.id);
    const stolenTo = freshEmail('ladron');
    await requestEmailChange(db, deps, { actor, newEmail: stolenTo });
    expect(await confirmEmailChange(db, deps, { actor, code: await codeSentTo(stolenTo) })).toMatchObject({ status: 'CHANGED' });
    const notice = await db.outboxMessage.findFirstOrThrow({ where: { templateKey: 'account.emailChanged', userId: person.id } });
    const payload = notice.payloadJson as { revertUrl: string; days: number };
    expect(payload.days).toBe(14);
    expect(payload.revertUrl.startsWith('https://korum.test/cuenta/recuperar-email#t=')).toBe(true);
    const token = payload.revertUrl.split('#t=')[1]!;
    // Un token manipulado no vale.
    expect(await revertEmailChange(db, { hmacSecret: TEST_HMAC_SECRET }, { token: token.slice(0, -2) + 'xx' })).toEqual({ status: 'INVALID' });
    expect(await revertEmailChange(db, { hmacSecret: TEST_HMAC_SECRET }, { token })).toEqual({ status: 'REVERTED', email: oldEmail, removed: { passkeys: 0, password: false, twoFactor: false } });
    expect(await db.user.findUniqueOrThrow({ where: { id: person.id } })).toMatchObject({ email: oldEmail, canonicalEmail: person.canonicalEmail });
    expect(await db.contribution.findUniqueOrThrow({ where: { id: purchase.id } })).toMatchObject({ guestEmail: oldEmail, canonicalEmail: person.canonicalEmail });
    expect(await db.session.count({ where: { userId: person.id } })).toBe(0);
    expect(await db.auditLog.count({ where: { action: 'account.email_change_reverted', targetId: person.id } })).toBe(1);
    expect(await revertEmailChange(db, { hmacSecret: TEST_HMAC_SECRET }, { token })).toEqual({ status: 'INVALID' });
  });

  it('mientras vale el «No he sido yo» no se puede volver a cambiar el email; una cuenta verificada con el email anterior lo impide', async () => {
    const person = await createUser(db);
    const oldEmail = person.email;
    const { actor } = await verified(person.id);
    const first = freshEmail('primero');
    await requestEmailChange(db, deps, { actor, newEmail: first });
    await confirmEmailChange(db, deps, { actor, code: await codeSentTo(first) });
    const firstNotice = await db.outboxMessage.findFirstOrThrow({ where: { templateKey: 'account.emailChanged', userId: person.id }, orderBy: { id: 'desc' } });
    const token = (firstNotice.payloadJson as { revertUrl: string }).revertUrl.split('#t=')[1]!;
    // Una sesión robada no puede inutilizar el enlace con un segundo cambio.
    const { actor: again } = await verified(person.id);
    expect(await requestEmailChange(db, deps, { actor: again, newEmail: freshEmail('segundo') })).toMatchObject({ status: 'REJECTED', reason: 'RECENTLY_CHANGED', until: expect.any(String) });
    // Una cuenta verificada con el email anterior: no se le quita.
    const squatter = await createUser(db, { email: oldEmail, canonicalEmail: oldEmail });
    expect(await revertEmailChange(db, { hmacSecret: TEST_HMAC_SECRET }, { token })).toEqual({ status: 'EMAIL_TAKEN' });
    await db.user.update({ where: { id: squatter.id }, data: { email: freshEmail('libre'), canonicalEmail: freshEmail('librec') } });
    expect(await revertEmailChange(db, { hmacSecret: TEST_HMAC_SECRET }, { token })).toMatchObject({ status: 'REVERTED', email: oldEmail });
  });

  it('«No he sido yo» libera el email anterior de un alta sin verificar, quita las credenciales añadidas tras el cambio y aguanta dos clics a la vez', async () => {
    const person = await createUser(db);
    const oldEmail = person.email;
    const keptKey = await db.passkey.create({ data: { id: uniqueId('llave'), userId: person.id, publicKey: 'clave', credentialID: uniqueId('cred'), counter: 0, deviceType: 'singleDevice', backedUp: false, createdAt: new Date(Date.now() - 86_400_000) } });
    const { actor } = await verified(person.id);
    const stolenTo = freshEmail('robado');
    await requestEmailChange(db, deps, { actor, newEmail: stolenTo });
    await confirmEmailChange(db, deps, { actor, code: await codeSentTo(stolenTo) });
    const token = ((await db.outboxMessage.findFirstOrThrow({ where: { templateKey: 'account.emailChanged', userId: person.id }, orderBy: { id: 'desc' } })).payloadJson as { revertUrl: string }).revertUrl.split('#t=')[1]!;
    // Lo que añade quien robó la sesión: una llave y una contraseña (restableciéndola con un código al email nuevo).
    await db.passkey.create({ data: { id: uniqueId('llave'), userId: person.id, publicKey: 'clave', credentialID: uniqueId('cred'), counter: 0, deviceType: 'singleDevice', backedUp: false } });
    await db.account.create({ data: { id: uniqueId('acc'), userId: person.id, accountId: person.id, providerId: 'credential', password: 'hash-del-atacante' } });
    // Y ocupa el email anterior con un alta sin verificar (una entidad con ese email para quien dirige).
    const squatter = await createUser(db, { email: oldEmail, canonicalEmail: oldEmail, emailVerified: false });
    await db.account.create({ data: { id: uniqueId('acc'), userId: squatter.id, accountId: squatter.id, providerId: 'credential', password: 'otro-hash' } });
    const fake = await createOrganization(db);
    await db.organizationMember.create({ data: { organizationId: fake.id, userId: squatter.id, role: 'DIRECTOR' } });

    const [one, two] = await Promise.all([revertEmailChange(db, { hmacSecret: TEST_HMAC_SECRET }, { token }), revertEmailChange(db, { hmacSecret: TEST_HMAC_SECRET }, { token })]);
    expect([one.status, two.status].sort()).toEqual(['INVALID', 'REVERTED']);
    const done = one.status === 'REVERTED' ? one : two;
    // Todas las llaves (también la anterior al cambio: pudo añadirla la sesión robada), la contraseña puesta después y el alta que ocupaba el email.
    expect(done).toMatchObject({ email: oldEmail, removed: { passkeys: 2, password: true, twoFactor: false } });
    expect(await db.user.findUnique({ where: { id: squatter.id } })).toBeNull();
    expect(await db.organization.findUnique({ where: { id: fake.id } })).toBeNull();
    expect((await db.user.findUniqueOrThrow({ where: { id: person.id } })).email).toBe(oldEmail);
    expect(await db.passkey.count({ where: { userId: person.id } })).toBe(0);
    expect(keptKey.userId).toBe(person.id);
    expect(await db.account.count({ where: { userId: person.id, providerId: 'credential' } })).toBe(0);
    expect(await db.auditLog.count({ where: { action: 'account.email_change_reverted', targetId: person.id } })).toBe(1);
    // Y el email sigue sin poder cambiarse 14 días: el mismo ataque no empieza otra vez al momento.
    const { actor: afterwards } = await verified(person.id);
    expect(await requestEmailChange(db, deps, { actor: afterwards, newEmail: freshEmail('otra-vez') })).toMatchObject({ status: 'REJECTED', reason: 'RECENTLY_REVERTED' });
  });

  it('«No he sido yo» cancela un relevo abierto que alguien propuso hacia el email anterior y recupera la cuenta', async () => {
    const person = await createUser(db);
    const oldEmail = person.email;
    const { actor } = await verified(person.id);
    const stolenTo = freshEmail('relevo');
    await requestEmailChange(db, deps, { actor, newEmail: stolenTo });
    await confirmEmailChange(db, deps, { actor, code: await codeSentTo(stolenTo) });
    const token = ((await db.outboxMessage.findFirstOrThrow({ where: { templateKey: 'account.emailChanged', userId: person.id }, orderBy: { id: 'desc' } })).payloadJson as { revertUrl: string }).revertUrl.split('#t=')[1]!;
    // Un tercero propone un relevo de su puesto hacia el email anterior: eso crea una cuenta sin verificar con ese email y un relevo abierto.
    const organization = await createOrganization(db);
    const outgoing = await createUser(db);
    const member = await db.organizationMember.create({ data: { organizationId: organization.id, userId: outgoing.id, role: 'DIRECTOR' } });
    const invitee = await createUser(db, { email: oldEmail, canonicalEmail: oldEmail, emailVerified: false });
    const handover = await db.signerHandover.create({ data: { organizationId: organization.id, role: 'DIRECTOR', outgoingMemberId: member.id, outgoingUserId: outgoing.id, incomingUserId: invitee.id, proposedByUserId: outgoing.id, roleLabel: 'Dirección', displayName: 'Laura', status: 'INVITED', consentedAt: new Date(), expiresAt: new Date(Date.now() + 72 * 3_600_000) } });
    await db.verification.create({ data: { id: uniqueId('inv'), identifier: `korum-invite:${invitee.id}:${organization.id}`, value: '{}', expiresAt: new Date(Date.now() + 72 * 3_600_000) } });
    expect(await revertEmailChange(db, { hmacSecret: TEST_HMAC_SECRET }, { token })).toMatchObject({ status: 'REVERTED', email: oldEmail });
    expect(await db.user.findUnique({ where: { id: invitee.id } })).toBeNull();
    expect(await db.signerHandover.findUniqueOrThrow({ where: { id: handover.id } })).toMatchObject({ status: 'CANCELLED' });
    expect(await db.verification.count({ where: { identifier: { startsWith: `korum-invite:${invitee.id}:` } } })).toBe(0);
  });

  it('tras cambiar el email y suprimir la cuenta, su voto en una votación de proyecto también queda sin el email antiguo', async () => {
    const organization = await createOrganization(db);
    const initiative = await createInitiative(db, organization.id, { status: 'EXPIRED', format: 'BUDGET' });
    const person = await createUser(db);
    const donation = await db.contribution.create({ data: { organizationId: organization.id, initiativeId: initiative.id, userId: person.id, fiscalYear: 2026, type: 'DONATION', amountCents: 2_000, totalChargedCents: 2_000, paymentMethod: 'CARD', status: 'COMPLETED', guestEmail: person.email, canonicalEmail: person.canonicalEmail } });
    const poll = await db.resizePoll.create({ data: { initiativeId: initiative.id, optionsJson: ['Un toldo', 'Un banco'], closesAt: new Date(Date.now() + 5 * 86_400_000), createdById: person.id, originalGoalCents: 10_000, raisedAtLaunchCents: 2_000 } });
    const vote = await db.resizeVote.create({ data: { pollId: poll.id, canonicalEmail: person.canonicalEmail, contributionId: donation.id, optionIndex: 0, wantsRefund: false } });
    const { actor } = await verified(person.id);
    const renamed = freshEmail('cambiada');
    await requestEmailChange(db, deps, { actor, newEmail: renamed });
    await confirmEmailChange(db, deps, { actor, code: await codeSentTo(renamed) });
    expect((await db.resizeVote.findUniqueOrThrow({ where: { id: vote.id } })).canonicalEmail).toBe(person.canonicalEmail);
    const { actor: erasing } = await verified(person.id);
    await erasePersonalData(db, { paymentProvider: () => Promise.reject(new Error('sin tarjetas')), keyring: TEST_KEYRING, hmacSecret: TEST_HMAC_SECRET }, { userId: person.id, requestedBy: { kind: 'self', actor: erasing } });
    const erased = await db.resizeVote.findUniqueOrThrow({ where: { id: vote.id } });
    expect(erased).toMatchObject({ contributionId: null, optionIndex: 0 });
    expect(erased.canonicalEmail.startsWith('anonimizado:')).toBe(true);
  });

  it('el mismo email de destino tiene sus propios topes entre todas las cuentas: tras diez códigos equivocados, el primer fallo de otra cuenta agota su código', async () => {
    const victim = freshEmail('victima');
    const [user, domain] = victim.split('@') as [string, string];
    const alias = user + '+otra@' + domain;
    const attackers = await Promise.all(Array.from({ length: 3 }, () => createUser(db)));
    const sessions = [];
    for (const attacker of attackers) sessions.push(await verified(attacker.id));
    for (const { actor } of sessions.slice(0, 2)) {
      expect(await requestEmailChange(db, deps, { actor, newEmail: victim })).toMatchObject({ status: 'CODE_SENT' });
      const wrong = (await codeSentTo(victim)) === '999999' ? '888888' : '999999';
      for (let attempt = 1; attempt < EMAIL_CHANGE_MAX_ATTEMPTS; attempt += 1) expect(await confirmEmailChange(db, deps, { actor, code: wrong })).toMatchObject({ reason: 'INVALID_CODE' });
      expect(await confirmEmailChange(db, deps, { actor, code: wrong })).toMatchObject({ reason: 'TOO_MANY_ATTEMPTS' });
    }
    // Un alias del mismo buzón cuenta como el mismo destino.
    expect(await requestEmailChange(db, deps, { actor: sessions[2]!.actor, newEmail: alias })).toMatchObject({ status: 'CODE_SENT' });
    const wrong = (await codeSentTo(alias)) === '999999' ? '888888' : '999999';
    expect(await confirmEmailChange(db, deps, { actor: sessions[2]!.actor, code: wrong })).toMatchObject({ reason: 'TOO_MANY_ATTEMPTS' });
    expect(await db.auditLog.count({ where: { action: 'account.email_change_locked', actorUserId: { in: attackers.map((attacker) => attacker.id) } } })).toBe(3);
  });

  it('cada consulta guarda quién la escribió', async () => {
    const organization = await createOrganization(db, { slug: uniqueId('autoria') });
    const person = await createUser(db);
    const outcome = await submitSupportTicket({ db, hmacSecret: TEST_HMAC_SECRET }, { userId: person.id, payload: { orgSlug: organization.slug, topic: 'OTHER', subject: 'Una sugerencia', message: 'Me gustaría proponer una mejora para la web.' }, actor: null, locale: 'es' });
    expect(outcome.status).toBe('SENT');
    const ticket = await db.supportTicket.findFirstOrThrow({ where: { organizationId: organization.id } });
    expect(ticket).toMatchObject({ senderUserId: person.id, senderEmail: person.email });
  });
});
