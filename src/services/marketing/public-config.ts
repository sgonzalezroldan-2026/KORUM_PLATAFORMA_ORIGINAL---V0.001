import { DEFAULT_PUBLIC_PRICING, publicPricingFromGlobalConfig, type PublicPricing } from '@/core/finance/public-pricing';
import type { Db } from '@/lib/db';
import { reportError } from '@/lib/error-reporting';
import { getPrisma } from '@/lib/prisma';
import { DEFAULT_CRAWLER_POLICY, type CrawlerPolicy } from '@/lib/seo/crawler-policy';
import { getSetting, InvalidSettingError } from '@/services/settings/settings.service';

/**
 * Configuración que necesita la web pública (tarifas, verificación de buscadores y política de rastreadores). Sale de la consola del
 * Super-Admin (`GlobalConfig` y ajustes `seo.*`). Si la base de datos no responde a tiempo, la web sigue sirviéndose con los valores de
 * lanzamiento y el fallo se registra: una caída de la base de datos no puede tumbar la portada ni `robots.txt`.
 */
export interface PublicPlatformConfig {
  pricing: PublicPricing;
  verification: { google?: string; bing?: string };
  crawlers: CrawlerPolicy;
  /** `console`: leída de la consola; `defaults`: valores de lanzamiento por falta de base de datos. */
  source: 'console' | 'defaults';
}

export const DEFAULT_PUBLIC_CONFIG: PublicPlatformConfig = {
  pricing: DEFAULT_PUBLIC_PRICING,
  verification: {},
  crawlers: DEFAULT_CRAWLER_POLICY,
  source: 'defaults'
};

/** Espera máxima a la base de datos antes de caer a los valores de lanzamiento. */
export const PUBLIC_CONFIG_TIMEOUT_MS = 2500;
const SUCCESS_TTL_MS = 60_000;
const FAILURE_TTL_MS = 15_000;

/**
 * Un ajuste de buscadores guardado que ya no pasa su validación (p. ej. de antes de endurecer el catálogo) se ignora **solo él** (se usa su valor de lanzamiento y se avisa): si no, tumbaría
 * también las tarifas públicas y la web entera caería a los valores de lanzamiento.
 */
async function readOptional<T>(read: () => Promise<T | undefined>, key: string): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof InvalidSettingError) {
      if (process.env.NEXT_PHASE !== 'phase-production-build') reportError(error, { area: 'public-config', setting: key });
      return undefined;
    }
    throw error;
  }
}

/** Lee la configuración de la consola. Lanza si la base de datos no responde. */
export async function loadPublicPlatformConfig(db: Db): Promise<PublicPlatformConfig> {
  const row = await db.globalConfig.findUnique({ where: { id: 'GLOBAL' } });
  const [google, bing, crawlers] = await Promise.all([
    readOptional(() => getSetting(db, 'seo.verification.google'), 'seo.verification.google'),
    readOptional(() => getSetting(db, 'seo.verification.bing'), 'seo.verification.bing'),
    readOptional(() => getSetting(db, 'seo.aiCrawlers'), 'seo.aiCrawlers')
  ]);
  return {
    pricing: row ? publicPricingFromGlobalConfig(row) : DEFAULT_PUBLIC_PRICING,
    verification: { ...(google ? { google } : {}), ...(bing ? { bing } : {}) },
    crawlers: crawlers ?? DEFAULT_CRAWLER_POLICY,
    source: row ? 'console' : 'defaults'
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`La base de datos no respondió en ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

let memo: { value: Promise<PublicPlatformConfig>; expiresAt: number } | null = null;

/** Para las pruebas: olvida el valor guardado. */
export function resetPublicConfigMemo(): void {
  memo = null;
}

/**
 * Configuración pública con caché de un minuto (varias páginas se renderizan a la vez) y respaldo ante cualquier fallo. Un acierto se
 * recuerda 60 s; un fallo, 15 s, para reintentar pronto sin saturar una base de datos caída.
 */
export function getPublicPlatformConfig(): Promise<PublicPlatformConfig> {
  const now = Date.now();
  if (memo && memo.expiresAt > now) return memo.value;

  const entry = { value: Promise.resolve(DEFAULT_PUBLIC_CONFIG), expiresAt: now + SUCCESS_TTL_MS };
  entry.value = withTimeout(
    (async () => loadPublicPlatformConfig(getPrisma()))(),
    PUBLIC_CONFIG_TIMEOUT_MS
  ).catch((error: unknown) => {
    // En la compilación (`next build`) no hay base de datos y no es un incidente: solo se avisa en ejecución.
    if (process.env.NEXT_PHASE !== 'phase-production-build') reportError(error, { area: 'public-config' });
    entry.expiresAt = Date.now() + FAILURE_TTL_MS;
    return DEFAULT_PUBLIC_CONFIG;
  });
  memo = entry;
  return entry.value;
}
