/**
 * Paso del CI «Dependencias de producción sin vulnerabilidades altas» (`npm run audit:prod`).
 * La lógica y el porqué están en `audit-production-core.ts`; las excepciones, en `audit-exceptions.json`.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { auditPasses, collectAdvisories, evaluateAudit, exceptionsSchema } from './audit-production-core.ts';

const exceptionsPath = fileURLToPath(new URL('./audit-exceptions.json', import.meta.url));
const exceptions = exceptionsSchema.parse(JSON.parse(readFileSync(exceptionsPath, 'utf8')));

// `npm audit` termina con código distinto de 0 cuando hay avisos: lo que cuenta es su informe en JSON.
const run = spawnSync('npm audit --omit=dev --json', { shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

let report: unknown;
try {
  report = JSON.parse(run.stdout);
} catch {
  console.error('❌ `npm audit` no ha devuelto un informe válido. No se da por buena la comprobación.');
  console.error(run.stderr || run.stdout);
  process.exit(1);
}
if (typeof report === 'object' && report !== null && 'error' in report) {
  console.error('❌ `npm audit` ha devuelto un error. No se da por buena la comprobación.');
  console.error(JSON.stringify((report as { error: unknown }).error));
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const verdict = evaluateAudit(collectAdvisories(report), exceptions, today);

for (const { advisory, exception } of verdict.excepted) {
  console.log(`⚠️  Excepción vigente hasta el ${exception.reviewBy}: ${advisory.packageName} · ${advisory.id} (${advisory.severity})`);
  console.log(`    ${exception.reason}`);
}
for (const exception of verdict.unused) {
  console.log(`ℹ️  La excepción ${exception.id} (${exception.package}) ya no hace falta: bórrala de scripts/audit-exceptions.json.`);
}
for (const { advisory, exception } of verdict.expired) {
  console.error(`❌ Excepción caducada el ${exception.reviewBy}: ${advisory.packageName} · ${advisory.id}. Revisa si ya hay versión corregida (${advisory.url}).`);
}
for (const advisory of verdict.blocking) {
  console.error(`❌ ${advisory.packageName} · ${advisory.id} (${advisory.severity}): ${advisory.title} · ${advisory.url}`);
}

if (!auditPasses(verdict)) process.exit(1);
console.log(
  `✅ Dependencias de producción: ningún aviso alto o crítico sin excepción vigente (${verdict.excepted.length} con excepción).`
);
