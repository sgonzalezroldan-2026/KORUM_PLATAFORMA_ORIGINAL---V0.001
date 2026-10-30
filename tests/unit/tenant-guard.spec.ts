import { describe, expect, it } from 'vitest';
import { coarseUserAgent, decideTenantAccess, ResourceNotFoundError, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';

const user = (memberships: Array<{ organizationId: string; role: 'DIRECTOR' | 'COSIGNER' | 'GATEKEEPER' | 'FAMILY' | 'MERCHANT' }>, isSuperadmin = false): SessionActor => ({
  kind: 'user',
  userId: 'u1',
  isSuperadmin,
  memberships
});

describe('decideTenantAccess · decisión pura de acceso', () => {
  it('un miembro con un rol permitido accede a su entidad', () => {
    expect(decideTenantAccess(user([{ organizationId: 'CERVANTES', role: 'DIRECTOR' }]), 'CERVANTES', ['DIRECTOR', 'COSIGNER'])).toEqual({ allowed: true, via: 'MEMBER' });
  });

  it('un miembro de otra entidad es denegado (QA-SEC01: director de Cervantes con organizationId de San José)', () => {
    expect(decideTenantAccess(user([{ organizationId: 'CERVANTES', role: 'DIRECTOR' }]), 'SANJOSE', ['DIRECTOR'])).toEqual({ allowed: false, reason: 'NOT_A_MEMBER' });
  });

  it('un miembro con un rol que no sirve para esa operación es denegado', () => {
    expect(decideTenantAccess(user([{ organizationId: 'CERVANTES', role: 'GATEKEEPER' }]), 'CERVANTES', ['DIRECTOR', 'COSIGNER'])).toEqual({ allowed: false, reason: 'ROLE_NOT_ALLOWED' });
    expect(decideTenantAccess(user([{ organizationId: 'CERVANTES', role: 'FAMILY' }]), 'CERVANTES', ['DIRECTOR'])).toEqual({ allowed: false, reason: 'ROLE_NOT_ALLOWED' });
  });

  it('un rol en una entidad no vale en otra: se evalúa la membresía de cada entidad por separado', () => {
    const actor = user([
      { organizationId: 'CERVANTES', role: 'DIRECTOR' },
      { organizationId: 'SANJOSE', role: 'FAMILY' }
    ]);
    expect(decideTenantAccess(actor, 'CERVANTES', ['DIRECTOR']).allowed).toBe(true);
    expect(decideTenantAccess(actor, 'SANJOSE', ['DIRECTOR'])).toEqual({ allowed: false, reason: 'ROLE_NOT_ALLOWED' });
  });

  it('el Super-Admin accede a cualquier entidad, marcado como tal para que se registre', () => {
    expect(decideTenantAccess(user([], true), 'SANJOSE', ['DIRECTOR'])).toEqual({ allowed: true, via: 'SUPERADMIN' });
  });

  it('una persona sin sesión nunca accede', () => {
    expect(decideTenantAccess({ kind: 'anonymous' }, 'CERVANTES', ['DIRECTOR', 'COSIGNER', 'GATEKEEPER'])).toEqual({ allowed: false, reason: 'ANONYMOUS' });
  });

  it('una sesión de portería solo sirve en su entidad, para operaciones de portería y sobre SU evento', () => {
    const gate: SessionActor = { kind: 'gate', gateSessionId: 'g1', organizationId: 'CERVANTES', initiativeId: 2 };
    const ownEvent = { target: { targetType: 'Initiative', targetId: 2 } };
    expect(decideTenantAccess(gate, 'CERVANTES', ['GATEKEEPER'], ownEvent)).toEqual({ allowed: true, via: 'GATE_SESSION' });
    expect(decideTenantAccess(gate, 'CERVANTES', ['GATEKEEPER'], { target: { targetType: 'Initiative', targetId: '2' } })).toEqual({ allowed: true, via: 'GATE_SESSION' });
    expect(decideTenantAccess(gate, 'SANJOSE', ['GATEKEEPER'], ownEvent)).toEqual({ allowed: false, reason: 'GATE_SESSION_OTHER_TENANT' });
    expect(decideTenantAccess(gate, 'CERVANTES', ['DIRECTOR', 'COSIGNER'], ownEvent)).toEqual({ allowed: false, reason: 'GATE_SESSION_ROLE' });
  });

  it('una sesión de portería no opera sobre otro evento de su entidad ni sin indicar sobre qué opera', () => {
    const gate: SessionActor = { kind: 'gate', gateSessionId: 'g1', organizationId: 'CERVANTES', initiativeId: 2 };
    expect(decideTenantAccess(gate, 'CERVANTES', ['GATEKEEPER'], { target: { targetType: 'Initiative', targetId: 3 } })).toEqual({ allowed: false, reason: 'GATE_SESSION_OTHER_EVENT' });
    expect(decideTenantAccess(gate, 'CERVANTES', ['GATEKEEPER'], { target: { targetType: 'Organization', targetId: 'CERVANTES' } })).toEqual({ allowed: false, reason: 'GATE_SESSION_OTHER_EVENT' });
    expect(decideTenantAccess(gate, 'CERVANTES', ['GATEKEEPER'])).toEqual({ allowed: false, reason: 'GATE_SESSION_OTHER_EVENT' });
    expect(decideTenantAccess(gate, 'CERVANTES', ['GATEKEEPER'], { target: { targetType: 'Initiative' } })).toEqual({ allowed: false, reason: 'GATE_SESSION_OTHER_EVENT' });
  });

  it('el Super-Admin queda excluido de las operaciones que lo piden (p. ej. firmar una liquidación por otra persona)', () => {
    expect(decideTenantAccess(user([], true), 'SANJOSE', ['DIRECTOR'], { allowSuperadmin: false })).toEqual({ allowed: false, reason: 'SUPERADMIN_EXCLUDED' });
    expect(decideTenantAccess(user([], true), 'SANJOSE', ['DIRECTOR'], { allowSuperadmin: true })).toEqual({ allowed: true, via: 'SUPERADMIN' });
  });

  it('sin roles permitidos nadie entra salvo el Super-Admin', () => {
    expect(decideTenantAccess(user([{ organizationId: 'CERVANTES', role: 'DIRECTOR' }]), 'CERVANTES', []).allowed).toBe(false);
  });
});

describe('errores de la guardia', () => {
  it('la denegación es un 403 con un mensaje que no revela nada de la entidad', () => {
    const error = new TenantAccessError('NOT_A_MEMBER');
    expect(error.status).toBe(403);
    expect(error.message).toBe('No tienes acceso a esta entidad.');
    expect(error.message).not.toMatch(/SANJOSE|CERVANTES|NOT_A_MEMBER/);
  });

  it('«no encontrado» es un 404 idéntico exista o no el recurso en otra entidad', () => {
    expect(new ResourceNotFoundError('Iniciativa')).toMatchObject({ status: 404, message: 'Iniciativa no encontrado.' });
  });
});

describe('coarseUserAgent · la auditoría no guarda la huella completa del navegador', () => {
  it('reduce el User-Agent a navegador y sistema', () => {
    expect(coarseUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36')).toBe('Chrome/Windows');
    expect(coarseUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0')).toBe('Edge/Windows');
    expect(coarseUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari/iOS');
    expect(coarseUserAgent('Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0')).toBe('Firefox/Android');
    expect(coarseUserAgent('curl/8.5.0')).toBe('Otro/Otro');
  });

  it('sin User-Agent no guarda nada y el resultado nunca contiene la versión ni la huella', () => {
    expect(coarseUserAgent(undefined)).toBeNull();
    expect(coarseUserAgent('')).toBeNull();
    expect(coarseUserAgent('Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0.6723.58')).not.toMatch(/130|6723|x86_64/);
  });
});