import { z } from 'zod';

/**
 * Variables de entorno de KORUM, validadas con Zod y con fallo inmediato (Regla 01 §5).
 * Solo viven aquí las claves que protegen la consola o los datos cifrados y la infraestructura;
 * lo operativo (Paycomet, email, Veri*factu, Hucha...) se edita en /admin/ajustes.
 */

/** Una cadena vacía en .env equivale a «sin valor»: así `FOO=""` de la plantilla no pasa por válido. */
const blankToUndefined = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);

const required = (schema: z.ZodType<string>) => z.preprocess(blankToUndefined, schema);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema.optional());

const secret = (name: string) =>
  required(z.string({ error: `${name} es obligatoria` }).min(32, `${name} debe tener al menos 32 caracteres (genérala con «npm run setup:env»)`));

const base64Key32 = required(
  z
    .string({ error: 'ENCRYPTION_KEY es obligatoria' })
    .refine((value) => /^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.from(value, 'base64').length === 32, {
      message: 'ENCRYPTION_KEY debe ser una clave de 32 bytes codificada en base64 (genérala con «npm run setup:env»)'
    })
);

const postgresUrl = (name: string) =>
  required(
    z
      .string({ error: `${name} es obligatoria` })
      .refine((value) => /^postgres(ql)?:\/\//.test(value), { message: `${name} debe empezar por postgresql://` })
  );

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    // Base de datos
    DATABASE_URL: postgresUrl('DATABASE_URL'),
    DIRECT_URL: optional(z.string().refine((value) => /^postgres(ql)?:\/\//.test(value), 'DIRECT_URL debe empezar por postgresql://')),

    // Seguridad
    BETTER_AUTH_SECRET: secret('BETTER_AUTH_SECRET'),
    ENCRYPTION_KEY: base64Key32,
    ENCRYPTION_KEY_VERSION: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).default(1)),
    DATA_HMAC_SECRET: secret('DATA_HMAC_SECRET'),
    QR_HMAC_SECRET: secret('QR_HMAC_SECRET'),
    CRON_SECRET: secret('CRON_SECRET'),

    // Pagos: «mock» es el simulador local; los datos de acceso se editan en /admin/ajustes
    PAYCOMET_MODE: z.preprocess(blankToUndefined, z.enum(['mock', 'sandbox', 'live']).default('mock')),
    PAYCOMET_API_KEY: optional(z.string()),
    PAYCOMET_MERCHANT_CODE: optional(z.string()),
    PAYCOMET_TERMINAL_ID: optional(z.string()),
    PAYCOMET_WEBHOOK_SECRET: optional(z.string()),

    // Ficheros, email y facturación (respaldo de /admin/ajustes)
    SUPABASE_URL: optional(z.url()),
    SUPABASE_SERVICE_ROLE_KEY: optional(z.string()),
    EMAIL_API_KEY: optional(z.string()),
    VERIFACTU_ISSUER_NIF: optional(z.string()),

    // URL pública, errores y analítica
    NEXT_PUBLIC_APP_URL: z.preprocess(blankToUndefined, z.url().default('http://localhost:3000')),
    NEXT_PUBLIC_SENTRY_DSN: optional(z.url()),
    SENTRY_AUTH_TOKEN: optional(z.string()),
    NEXT_PUBLIC_PLAUSIBLE_DOMAIN: optional(z.string()),

    // Arranque y demostración
    SUPERADMIN_BOOTSTRAP_EMAIL: optional(z.email()),
    NEXT_PUBLIC_DEMO_MODE: z.preprocess(blankToUndefined, z.enum(['true', 'false']).default('false'))
  })
  .superRefine((value, ctx) => {
    // El simulador de pagos solo puede estar en producción si es el entorno de demostración declarado.
    if (value.NODE_ENV === 'production' && value.PAYCOMET_MODE === 'mock' && value.NEXT_PUBLIC_DEMO_MODE !== 'true') {
      ctx.addIssue({
        code: 'custom',
        path: ['PAYCOMET_MODE'],
        message: 'En producción PAYCOMET_MODE no puede ser «mock» salvo en el entorno de demostración (NEXT_PUBLIC_DEMO_MODE=true)'
      });
    }
    // Dinero real con perfiles simulados: nunca.
    if (value.PAYCOMET_MODE === 'live' && value.NEXT_PUBLIC_DEMO_MODE === 'true') {
      ctx.addIssue({ code: 'custom', path: ['PAYCOMET_MODE'], message: 'PAYCOMET_MODE=live no se puede combinar con el entorno de demostración (NEXT_PUBLIC_DEMO_MODE=true)' });
    }
  });

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(
      `Configuración de entorno no válida. Corrige estas variables y vuelve a arrancar:\n${issues.map((issue) => `  - ${issue}`).join('\n')}\n` +
        'Consejo: «npm run setup:env» crea .env.local con los secretos generados.'
    );
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

/** Valida un origen de variables (por defecto `process.env`) o lanza `EnvValidationError` con todos los problemas a la vez. */
export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => {
        const name = issue.path.join('.');
        return name && !issue.message.includes(name) ? `${name}: ${issue.message}` : issue.message;
      })
    );
  }
  return result.data;
}

let cached: Env | undefined;

/** Entorno validado y memorizado. Se llama al arrancar el servidor (instrumentation.ts) para fallar pronto. */
export function getEnv(): Env {
  cached ??= parseEnv();
  return cached;
}
