import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import pg from 'pg';
import { E2E_SCHEMA, e2eDatabaseUrl } from './e2e-database';

/**
 * Apoyo de las pruebas de acceso: leer los emails que la bandeja de salida deja en `.email-preview/` (modo vista previa con cobros
 * simulados: es lo que recibiría la persona) y tocar la base de datos de pruebas cuando una prueba necesita preparar algo (un PIN).
 */

const PREVIEW_DIR = path.join(process.cwd(), '.email-preview');

/** Texto del último email enviado a `address` después de `since` (ms). Espera hasta 20 s a que la bandeja lo envíe. */
export async function emailTo(address: string, since: number): Promise<string> {
  let found: string | null = null;
  await expect
    .poll(
      async () => {
        const files = await readdir(PREVIEW_DIR).catch(() => [] as string[]);
        const candidates: Array<{ text: string; time: number }> = [];
        for (const file of files.filter((name) => name.endsWith('.txt'))) {
          const full = path.join(PREVIEW_DIR, file);
          const info = await stat(full);
          if (info.mtimeMs < since - 1000) continue;
          const text = await readFile(full, 'utf8');
          if (text.startsWith(`Para: ${address}\n`)) candidates.push({ text, time: info.mtimeMs });
        }
        found = candidates.sort((a, b) => b.time - a.time)[0]?.text ?? null;
        return found !== null;
      },
      { timeout: 20_000, message: `email a ${address}` }
    )
    .toBe(true);
  return found!;
}

export const codeIn = (text: string) => /\b(\d{6})\b/.exec(text.split('\n\n').slice(1).join('\n'))?.[1] ?? '';

/**
 * La base local sin Docker (PGlite) es un solo proceso: si esta conexión y la del servidor hablan a la vez, a veces mezcla sus mensajes
 * («bind message supplies N parameters…», código 08P01). Con PostgreSQL real (CI) no pasa. Se reintenta solo ese error; las consultas de
 * estas pruebas son idempotentes (un recuento y un PIN que solo se pone si no hay uno vigente).
 */
export async function withE2eDb<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await runWithE2eDb(fn);
    } catch (error) {
      const message = (error as Error).message ?? '';
      const mixedProtocol = (error as { code?: string }).code === '08P01' || /bind message supplies|prepared statement/.test(message);
      if (!mixedProtocol || attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
}

async function runWithE2eDb<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const url = new URL(e2eDatabaseUrl());
  url.searchParams.delete('schema');
  url.searchParams.delete('connection_limit');
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    await client.query(`SET search_path TO "${E2E_SCHEMA}"`);
    return await fn(client);
  } finally {
    await client.end();
  }
}

export const uniqueEmail = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}@familias.example`;
