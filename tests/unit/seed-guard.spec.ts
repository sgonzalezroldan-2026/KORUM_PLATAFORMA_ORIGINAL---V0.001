import { describe, expect, it } from 'vitest';
import { assertSeedAllowed, databaseTargetsOf, SeedNotAllowedError, seedGuardProblems, type SeedGuardInput } from '@/seed/seed-guard';

const LOCAL_URL = 'postgresql://korum:korum@localhost:5432/korum';
const REMOTE_URL = 'postgresql://u:p@db.ejemplo-supabase.co:5432/postgres';
const LOCAL: SeedGuardInput = { nodeEnv: 'development', demoMode: false, paycometMode: 'mock', databaseUrls: [{ name: 'DATABASE_URL', url: LOCAL_URL }] };
const withUrls = (input: SeedGuardInput, ...urls: Array<[string, string]>): SeedGuardInput => ({ ...input, databaseUrls: urls.map(([name, url]) => ({ name, url })) });

describe('seed-guard · la semilla y el reinicio solo tocan bases locales o de demostración', () => {
  it.each([
    ['localhost', 'postgresql://u:p@localhost:5432/korum'],
    ['127.0.0.1', 'postgres://u:p@127.0.0.1:51214/template1?sslmode=disable'],
    ['IPv6 local', 'postgresql://u:p@[::1]:5432/korum']
  ])('permite el desarrollo con una base local (%s)', (_name, url) => {
    const input = withUrls(LOCAL, ['DATABASE_URL', url]);
    expect(seedGuardProblems(input)).toEqual([]);
    expect(() => assertSeedAllowed(input)).not.toThrow();
  });

  it('permite las pruebas (NODE_ENV=test) con base local', () => {
    expect(seedGuardProblems({ ...LOCAL, nodeEnv: 'test' })).toEqual([]);
  });

  it('rechaza una base remota si el entorno no es de demostración', () => {
    const problems = seedGuardProblems(withUrls(LOCAL, ['DATABASE_URL', REMOTE_URL]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/DATABASE_URL apunta a «db\.ejemplo-supabase\.co»/);
  });

  it('rechaza el reinicio si DIRECT_URL es remota aunque DATABASE_URL sea local (prisma migrate reset actúa sobre DIRECT_URL)', () => {
    const input = withUrls(LOCAL, ['DATABASE_URL', LOCAL_URL], ['DIRECT_URL', REMOTE_URL]);
    const problems = seedGuardProblems(input);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/DIRECT_URL apunta a «db\.ejemplo-supabase\.co»/);
    expect(() => assertSeedAllowed(input)).toThrow(SeedNotAllowedError);
  });

  it('con las dos direcciones remotas dice cuáles son, y con las dos locales permite', () => {
    expect(seedGuardProblems(withUrls(LOCAL, ['DATABASE_URL', REMOTE_URL], ['DIRECT_URL', REMOTE_URL]))).toHaveLength(2);
    expect(seedGuardProblems(withUrls(LOCAL, ['DATABASE_URL', LOCAL_URL], ['DIRECT_URL', 'postgres://postgres:postgres@127.0.0.1:51214/template1']))).toEqual([]);
  });

  it('rechaza producción sin entorno de demostración y lo dice con todos sus motivos a la vez', () => {
    const input: SeedGuardInput = { ...withUrls(LOCAL, ['DATABASE_URL', REMOTE_URL]), nodeEnv: 'production', paycometMode: 'live' };
    const problems = seedGuardProblems(input);
    expect(problems).toHaveLength(3);
    try {
      assertSeedAllowed(input);
      expect.unreachable('debía lanzar SeedNotAllowedError');
    } catch (error) {
      expect(error).toBeInstanceOf(SeedNotAllowedError);
      expect((error as SeedNotAllowedError).reasons).toEqual(problems);
    }
  });

  it('el entorno de demostración puede usar una base remota, pero nunca con cobros reales', () => {
    const demo: SeedGuardInput = { ...withUrls(LOCAL, ['DATABASE_URL', REMOTE_URL], ['DIRECT_URL', REMOTE_URL]), nodeEnv: 'production', demoMode: true };
    expect(seedGuardProblems(demo)).toEqual([]);
    expect(seedGuardProblems({ ...demo, paycometMode: 'sandbox' })).toEqual([]);
    expect(seedGuardProblems({ ...demo, paycometMode: 'live' })).toHaveLength(1);
    expect(seedGuardProblems({ ...LOCAL, paycometMode: 'live' })).toHaveLength(1);
  });

  it('rechaza una URL que cambia el servidor con ?host= o ?hostaddr=, aunque su nombre parezca local', () => {
    for (const query of ['host=db.ejemplo-supabase.co', 'hostaddr=203.0.113.7', 'sslmode=disable&host=/var/run/postgresql']) {
      const problems = seedGuardProblems(withUrls(LOCAL, ['DATABASE_URL', `postgresql://u:p@localhost:5432/korum?${query}`]));
      expect(problems, query).toHaveLength(1);
      expect(problems[0]).toMatch(/parámetro «host» o «hostaddr»/);
    }
    expect(seedGuardProblems(withUrls(LOCAL, ['DATABASE_URL', 'postgresql://u:p@localhost:5432/korum?sslmode=disable&schema=public']))).toEqual([]);
  });

  it('una dirección ilegible o la ausencia de direcciones se rechazan en vez de darse por locales', () => {
    expect(seedGuardProblems(withUrls(LOCAL, ['DATABASE_URL', 'esto no es una url']))).toEqual(['DATABASE_URL no es una dirección válida.']);
    expect(seedGuardProblems({ ...LOCAL, databaseUrls: [] })).toEqual(['No hay ninguna dirección de base de datos que comprobar.']);
  });

  it('databaseTargetsOf incluye DIRECT_URL solo cuando tiene valor', () => {
    expect(databaseTargetsOf({ DATABASE_URL: LOCAL_URL })).toEqual([{ name: 'DATABASE_URL', url: LOCAL_URL }]);
    expect(databaseTargetsOf({ DATABASE_URL: LOCAL_URL, DIRECT_URL: '' })).toHaveLength(1);
    expect(databaseTargetsOf({ DATABASE_URL: LOCAL_URL, DIRECT_URL: '   ' })).toHaveLength(1);
    expect(databaseTargetsOf({ DATABASE_URL: LOCAL_URL, DIRECT_URL: REMOTE_URL })).toEqual([
      { name: 'DATABASE_URL', url: LOCAL_URL },
      { name: 'DIRECT_URL', url: REMOTE_URL }
    ]);
  });
});
