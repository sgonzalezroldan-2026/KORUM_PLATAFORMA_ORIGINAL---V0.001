import { EnvValidationError, getEnv } from '@/config/env';

/**
 * Falla pronto (QA-C01): si falta o es inválida una variable crítica, el servidor muestra qué hay que corregir y se detiene.
 * Next.js captura las excepciones de `register()` y seguiría escuchando respondiendo 500, que en un contenedor parecería
 * un servidor sano; por eso se termina el proceso explícitamente.
 * No se valida durante `next build`, para que la integración continua compile sin los secretos de producción.
 */
if (process.env.NEXT_PHASE !== 'phase-production-build') {
  try {
    getEnv();
  } catch (error) {
    if (!(error instanceof EnvValidationError)) throw error;
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }
}
