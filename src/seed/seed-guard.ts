/**
 * Guardia de la semilla y del reinicio de la base (`npm run db:seed` / `npm run db:reset`). Función pura: recibe los valores ya
 * validados del entorno y devuelve los motivos por los que NO se debe tocar esa base. La semilla contiene datos de
 * demostración (aportaciones, asientos, facturas) y el reinicio borra todo, así que nunca deben alcanzar una base real.
 *
 * Se permite cuando la base es local (desarrollo y pruebas) o cuando el entorno se declara de demostración
 * (`NEXT_PUBLIC_DEMO_MODE=true`). Aun así, jamás con cobros reales (`PAYCOMET_MODE=live`).
 *
 * Se comprueba CADA dirección que el comando puede tocar: `prisma migrate reset` borra la base de `DIRECT_URL` si está definida
 * (y la de `DATABASE_URL` si no), y la semilla posterior escribe en `DATABASE_URL`. Basta con que una sea remota para negarse.
 */

export interface DatabaseTarget {
  /** Nombre de la variable de entorno, para decir cuál es la que falla. */
  name: string;
  url: string;
}

export interface SeedGuardInput {
  nodeEnv: 'development' | 'test' | 'production';
  demoMode: boolean;
  paycometMode: 'mock' | 'sandbox' | 'live';
  databaseUrls: DatabaseTarget[];
}

export class SeedNotAllowedError extends Error {
  readonly reasons: string[];

  constructor(reasons: string[]) {
    super(`No se puede cargar la semilla ni reiniciar esta base de datos:\n${reasons.map((reason) => `  - ${reason}`).join('\n')}`);
    this.name = 'SeedNotAllowedError';
    this.reasons = reasons;
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function hostOf(databaseUrl: string): string | null {
  try {
    return new URL(databaseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** `?host=` y `?hostaddr=` mandan sobre el nombre de servidor de la dirección en `pg` y en `libpq`: una URL «local» podría conectar fuera. */
function overridesHost(databaseUrl: string): boolean {
  try {
    const { searchParams } = new URL(databaseUrl);
    return searchParams.has('host') || searchParams.has('hostaddr');
  } catch {
    return false;
  }
}

/** Direcciones que tocan los comandos de la semilla: la de la aplicación y, si existe, la directa de las migraciones. */
export function databaseTargetsOf(env: { DATABASE_URL: string; DIRECT_URL?: string | undefined }): DatabaseTarget[] {
  const targets: DatabaseTarget[] = [{ name: 'DATABASE_URL', url: env.DATABASE_URL }];
  if (env.DIRECT_URL && env.DIRECT_URL.trim() !== '') targets.push({ name: 'DIRECT_URL', url: env.DIRECT_URL });
  return targets;
}

export function seedGuardProblems(input: SeedGuardInput): string[] {
  const problems: string[] = [];
  if (input.paycometMode === 'live') {
    problems.push('PAYCOMET_MODE es «live»: los datos de demostración no pueden convivir con cobros reales.');
  }
  if (input.nodeEnv === 'production' && !input.demoMode) {
    problems.push('NODE_ENV es «production» y el entorno no es de demostración (NEXT_PUBLIC_DEMO_MODE=true).');
  }
  if (input.databaseUrls.length === 0) {
    problems.push('No hay ninguna dirección de base de datos que comprobar.');
  }
  for (const target of input.databaseUrls) {
    const host = hostOf(target.url);
    if (host === null) {
      problems.push(`${target.name} no es una dirección válida.`);
    } else if (overridesHost(target.url)) {
      problems.push(`${target.name} lleva el parámetro «host» o «hostaddr», que cambia el servidor al que se conecta: no se admite en la semilla.`);
    } else if (!LOCAL_HOSTS.has(host) && !input.demoMode) {
      problems.push(`${target.name} apunta a «${host}», que no es local, y el entorno no es de demostración (NEXT_PUBLIC_DEMO_MODE=true).`);
    }
  }
  return problems;
}

export function assertSeedAllowed(input: SeedGuardInput): void {
  const problems = seedGuardProblems(input);
  if (problems.length > 0) throw new SeedNotAllowedError(problems);
}
