#!/usr/bin/env node
/**
 * Crea .env.local a partir de .env.example y rellena con valores aleatorios los secretos que estén vacíos.
 * No sobrescribe nada: si .env.local ya existe, solo completa los secretos que falten.
 * Uso: npm run setup:env
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const examplePath = path.join(root, '.env.example');
const targetPath = path.join(root, '.env.local');

/** Variable → cómo se genera (base64 de 32 bytes en todos los casos: cumple los 32 caracteres mínimos y la clave AES). */
const generated = ['BETTER_AUTH_SECRET', 'ENCRYPTION_KEY', 'DATA_HMAC_SECRET', 'QR_HMAC_SECRET', 'CRON_SECRET'];

if (!fs.existsSync(examplePath)) {
  console.error('No se encuentra .env.example en la carpeta actual.');
  process.exit(1);
}

const source = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : fs.readFileSync(examplePath, 'utf8');
const filled = [];

const output = source
  .split(/\r?\n/)
  .map((line) => {
    const match = /^([A-Z0-9_]+)=(?:""|)\s*$/.exec(line);
    if (match && generated.includes(match[1])) {
      filled.push(match[1]);
      return `${match[1]}="${randomBytes(32).toString('base64')}"`;
    }
    return line;
  })
  .join('\n');

fs.writeFileSync(targetPath, output, 'utf8');
console.log(
  filled.length > 0
    ? `✅ .env.local listo. Secretos generados: ${filled.join(', ')}.`
    : '✅ .env.local ya tenía todos los secretos; no se ha cambiado nada.'
);
console.log('   No lo subas al repositorio (ya está en .gitignore).');
