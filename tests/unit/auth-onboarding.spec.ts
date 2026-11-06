import { describe, expect, it } from 'vitest';
import { validateRegistration, RegistrationError } from '@/core/onboarding/community-registration';
import { invitationUrl } from '@/core/onboarding/invitations';
import { PROVINCES } from '@/core/onboarding/provinces';
import { participationTemplate, registrationIssues, RESERVED_SLUGS, slugIssue, suggestSlug } from '@/core/onboarding/registration-rules';
import type { Db } from '@/lib/db';
import { authErrorCode } from '@/lib/auth/auth-client';
import { buildDatabaseHooks, IDENTITY_PROOF_PATHS, localeFromContext } from '@/lib/auth/auth-hooks';
import { isProtectedPath, safeNextPath } from '@/lib/auth/protected-paths';

/** Reglas puras del acceso por rol y del alta autónoma (Sprint 3.2, QA-M02). Lo que toca la base de datos está en `tests/integration/`. */

const base = { vertical: 'SCHOOL', legalForm: 'PARENTS_ASSOCIATION', centerOwnership: 'PUBLIC', ley49: false, provinceCode: '08', postalCode: '08201', slug: 'ceip-cervantes' } as const;

describe('reglas del alta de una entidad', () => {
  it('un colegio público solo entra por su AMPA/AFA', () => {
    expect(registrationIssues(base)).toEqual([]);
    expect(registrationIssues({ ...base, legalForm: 'FOUNDATION' })).toEqual(['PUBLIC_SCHOOL_NEEDS_PARENTS_ASSOCIATION']);
    expect(registrationIssues({ ...base, legalForm: 'SCHOOL_OWNER' })).toEqual(['PUBLIC_SCHOOL_NEEDS_PARENTS_ASSOCIATION']);
    expect(registrationIssues({ ...base, legalForm: 'SCHOOL_OWNER', centerOwnership: 'CONCERTED' })).toEqual([]);
  });

  it('la titularidad de un colegio privado no puede marcar la Ley 49 y cada vertical tiene sus formas jurídicas', () => {
    expect(registrationIssues({ ...base, legalForm: 'SCHOOL_OWNER', centerOwnership: 'PRIVATE', ley49: true })).toEqual(['SCHOOL_OWNER_NO_LEY49']);
    expect(registrationIssues({ ...base, vertical: 'SPORTS_CLUB', legalForm: 'PARENTS_ASSOCIATION' })).toEqual(['LEGAL_FORM_NOT_FOR_VERTICAL']);
    expect(registrationIssues({ ...base, vertical: 'SPORTS_CLUB', legalForm: 'SPORTS_ENTITY', centerOwnership: 'NOT_APPLICABLE' })).toEqual([]);
    expect(registrationIssues({ ...base, centerOwnership: 'NOT_APPLICABLE' })).toEqual(['OWNERSHIP_REQUIRED']);
  });

  it('el código postal tiene que ser de la provincia elegida', () => {
    expect(registrationIssues({ ...base, postalCode: '28001' })).toEqual(['POSTAL_CODE_PROVINCE_MISMATCH']);
    expect(registrationIssues({ ...base, provinceCode: '99' })).toEqual(['UNKNOWN_PROVINCE']);
    expect(PROVINCES).toHaveLength(52);
    expect(new Set(PROVINCES.map((province) => province.code)).size).toBe(52);
  });

  it('la URL propia no choca con las rutas de KORUM y se propone sin acentos', () => {
    for (const slug of ['login', 'admin', 'panel', 'api', 'precios', 'para-colegios', 'registro-comunidad', 'ca', 'en']) expect(slugIssue(slug)).toBe('SLUG_RESERVED');
    for (const slug of ['ab', '-cole', 'cole-', 'Cole', 'cole--a', 'cole_a', 'a'.repeat(41)]) expect(slugIssue(slug)).toBe('SLUG_INVALID');
    expect(slugIssue('ceip-cervantes')).toBeNull();
    expect(suggestSlug('Escola Pública Sant Jordi (Sabadell)')).toBe('escola-publica-sant-jordi-sabadell');
    expect(suggestSlug('  ¡Club Bàsquet Vallès!  ')).toBe('club-basquet-valles');
    expect(RESERVED_SLUGS.has('llms.txt')).toBe(true);
  });

  it('cada vertical trae su plantilla oficial de grupos (Regla 03 §5)', () => {
    const count = (vertical: Parameters<typeof participationTemplate>[0]) => participationTemplate(vertical).flatMap((cluster) => cluster.items).length;
    expect(count('SCHOOL')).toBe(15);
    expect(count('SPORTS_CLUB')).toBe(10);
    expect(count('CULTURAL')).toBe(5);
    // Es una copia: editar la de una entidad no cambia la oficial.
    participationTemplate('SCHOOL')[0]!.items.push('Grupo inventado');
    expect(count('SCHOOL')).toBe(15);
  });

  it('el servidor rechaza un alta sin la declaración de representación o con campos mal formados', () => {
    const raw = {
      ...base,
      name: 'CEIP Cervantes',
      city: 'Sabadell',
      legalName: 'AFA CEIP Cervantes',
      contentLocale: 'ca',
      publicIndexing: true,
      director: { name: 'Ana', email: 'ana@colegio.example', phone: '600111222', roleLabel: 'Dirección', password: 'una-contraseña-larga' },
      cosigner: { name: 'Pau', email: 'pau@colegio.example', phone: '600333444', roleLabel: 'Presidencia AFA' },
      representationDeclared: true
    };
    expect(validateRegistration(raw).director.email).toBe('ana@colegio.example');
    expect(() => validateRegistration({ ...raw, representationDeclared: false })).toThrow(RegistrationError);
    try {
      validateRegistration({ ...raw, postalCode: '0820', director: { ...raw.director, password: 'corta' } });
    } catch (error) {
      expect((error as RegistrationError).failure).toMatchObject({ code: 'INVALID', fields: expect.arrayContaining(['postalCode', 'director.password']) });
    }
  });

  it('el enlace de invitación lleva el token en el fragmento, en el idioma de la persona', () => {
    expect(invitationUrl('https://korum.app/', 'es', 'abc.def')).toBe('https://korum.app/invitacion#t=abc.def');
    expect(invitationUrl('https://korum.app', 'ca', 'abc.def')).toBe('https://korum.app/ca/invitacion#t=abc.def');
  });
});

describe('rutas protegidas y rutas de vuelta', () => {
  it('el panel y la consola exigen sesión; la portería entra con el PIN del evento', () => {
    for (const path of ['/admin', '/admin/ajustes', '/ca/admin', '/panel/cervantes', '/en/panel/cervantes/estudio', '/acceso/doble-factor']) expect(isProtectedPath(path), path).toBe(true);
    for (const path of ['/', '/login', '/registro-comunidad', '/panel/cervantes/porteria', '/ca/panel/cervantes/porteria/12', '/administracion', '/cervantes', '/panel']) expect(isProtectedPath(path), path).toBe(false);
  });

  it('solo se vuelve a rutas internas (sin redirección abierta)', () => {
    expect(safeNextPath('/panel/cervantes')).toBe('/panel/cervantes');
    expect(safeNextPath('/ca/admin?x=1')).toBe('/ca/admin?x=1');
    for (const unsafe of ['https://otro.example', '//otro.example', '/\\otro.example', 'javascript:alert(1)', '/api/auth/sign-out', '', null, undefined, `/${'a'.repeat(600)}`, '/ok\nSet-Cookie:x']) expect(safeNextPath(unsafe), String(unsafe)).toBeNull();
  });
});

describe('ganchos de Better Auth', () => {
  it('el idioma de una cuenta nueva sale de la cabecera del formulario o de la URL de vuelta', () => {
    expect(localeFromContext({ headers: new Headers({ 'x-korum-locale': 'en' }) })).toBe('en');
    expect(localeFromContext({ headers: new Headers({ 'x-korum-locale': 'fr' }), query: { callbackURL: '/ca/acceso/continuar' } })).toBe('ca');
    expect(localeFromContext({ body: { callbackURL: 'http://localhost:3000/en/panel/x' } })).toBe('en');
    expect(localeFromContext({ query: { callbackURL: '/cervantes' } })).toBe('es');
    expect(localeFromContext(null)).toBe('es');
  });

  it('la sesión guarda la IP solo como HMAC y del navegador solo su familia; una cuenta suprimida no entra', async () => {
    const users = new Map<string, { gdprAnonymizedAt: Date | null }>([['viva', { gdprAnonymizedAt: null }], ['borrada', { gdprAnonymizedAt: new Date() }]]);
    const fakeDb = { user: { findUnique: async ({ where }: { where: { id: string } }) => users.get(where.id) ?? null } } as unknown as Db;
    const hooks = buildDatabaseHooks({ db: fakeDb, hmacSecret: 'secreto-de-pruebas-del-hmac-0123456789' });
    const session = { userId: 'viva', ipAddress: '203.0.113.9', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1' };
    const result = await hooks.session.create.before(session);
    expect(result.data.ipAddress).toMatch(/^[0-9a-f]{64}$/);
    expect(result.data.ipAddress).not.toContain('203.0.113.9');
    expect(result.data.userAgent).toBe('Safari/iOS');
    await expect(hooks.session.create.before({ ...session, userId: 'borrada' })).rejects.toMatchObject({ body: { code: 'KORUM_ACCOUNT_CLOSED' } });
    await expect(hooks.session.create.before({ ...session, userId: 'no-existe' })).rejects.toMatchObject({ body: { code: 'KORUM_ACCOUNT_CLOSED' } });
  });

  it('solo las pruebas de identidad marcan la sesión, y solo el TOTP o el código de respaldo cuentan como segundo factor', () => {
    expect(IDENTITY_PROOF_PATHS['/sign-in/email']).toBeUndefined();
    expect(Object.entries(IDENTITY_PROOF_PATHS).filter(([, proof]) => proof === 'second-factor').map(([path]) => path).sort()).toEqual(['/two-factor/verify-backup-code', '/two-factor/verify-totp']);
  });

  it('los errores de Better Auth se traducen por su código; un 429 es «demasiados intentos»', () => {
    expect(authErrorCode({ code: 'INVALID_OTP', status: 400 })).toBe('INVALID_OTP');
    expect(authErrorCode({ status: 429 })).toBe('RATE_LIMITED');
    expect(authErrorCode(null)).toBe('UNKNOWN');
  });
});
