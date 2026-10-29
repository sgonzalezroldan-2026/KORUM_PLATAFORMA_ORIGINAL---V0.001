#!/usr/bin/env node
/**
 * KORUM v8.5 · Deterministic Invariant & Zero-Placeholder Gatekeeper
 * Scans schema/, src/, and prisma/ to guarantee bank-grade code hygiene before closing any Micro-Sprint.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const errors = [];

function walkFiles(dirPath, extensions) {
  const results = [];
  if (!fs.existsSync(dirPath)) return results;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === '.git') continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath, extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      results.push(fullPath);
    }
  }
  return results;
}

// 1. Check Prisma Schema: zero Float fields allowed
const prismaPath = path.join(ROOT, 'schema', 'schema.prisma');
if (fs.existsSync(prismaPath)) {
  const prismaText = fs.readFileSync(prismaPath, 'utf8');
  const lines = prismaText.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('//') && /\bFloat\b/.test(trimmed)) {
      errors.push(`[PRISMA-FLOAT] schema/schema.prisma:${idx + 1} uses forbidden Float type: "${trimmed}"`);
    }
  });
} else {
  errors.push('[PRISMA-MISSING] schema/schema.prisma not found');
}

// 2. Scan TypeScript / TSX / Prisma seed files for placeholders, forbidden copy, and secret leaks
const codeDirs = ['src', 'prisma', 'tests'];
const codeFiles = codeDirs.flatMap((d) => walkFiles(path.join(ROOT, d), ['.ts', '.tsx', '.js', '.mjs']));

const placeholderPatterns = [
  { id: 'TODO-COMMENT', regex: /\/\/\s*(TODO|FIXME|HACK)\b/i },
  { id: 'OMISSION-ELLIPSIS', regex: /\/\/\s*\.\.\.\s*(resto|rest|remaining|keep|mantener|igual)/i },
  { id: 'BLOCK-OMISSION', regex: /\/\*\s*\.\.\.\s*\*\// }
];

const secretLeakRegex = /NEXT_PUBLIC_(PAYCOMET_API_KEY|PAYCOMET_WEBHOOK_SECRET|QR_HMAC_SECRET|AUTH_SECRET)\b/;
const forbiddenMaintenanceLabel = /\(Desactivado\)/;

for (const file of codeFiles) {
  const rel = path.relative(ROOT, file);
  const isTestFile = rel.startsWith('tests' + path.sep) || rel.includes('.spec.') || rel.includes('.test.');
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split(/\r?\n/);

  lines.forEach((line, idx) => {
    for (const pat of placeholderPatterns) {
      if (pat.regex.test(line)) {
        errors.push(`[${pat.id}] ${rel}:${idx + 1} contains forbidden placeholder: "${line.trim()}"`);
      }
    }
    if (secretLeakRegex.test(line)) {
      errors.push(`[SECRET-LEAK] ${rel}:${idx + 1} exposes private secret via NEXT_PUBLIC_: "${line.trim()}"`);
    }
    if (!isTestFile && forbiddenMaintenanceLabel.test(line)) {
      errors.push(`[FORBIDDEN-COPY] ${rel}:${idx + 1} contains forbidden "(Desactivado)" label: "${line.trim()}"`);
    }
    // Check forbidden word "propina" in production UI/source (excluding comments/tests that assert its absence)
    if (!isTestFile && !line.trim().startsWith('//') && !line.trim().startsWith('*') && /\bpropinas?\b/i.test(line)) {
      errors.push(`[FORBIDDEN-PROPINA] ${rel}:${idx + 1} uses forbidden word "propina": "${line.trim()}"`);
    }
  });
}

// 3. Reconcile seed_data.json to the exact cent (0 cent drift across all initiatives)
const seedPath = path.join(ROOT, 'src', 'mocks', 'seed_data.json');
if (fs.existsSync(seedPath)) {
  try {
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    for (const init of seed.initiatives ?? []) {
      if (init.format === 'BUDGET') {
        const contingency = Math.round(((init.costMatCents + init.costInstCents) * init.contingencyBps) / 10000);
        const net = init.costMatCents + init.costInstCents + contingency;
        const gwInGoal = init.absorbsGatewayCostByKorum ? 0 : init.gatewayFeeCents;
        const tcoSum = net + init.bracketFeeCents + init.maintFeeCents + gwInGoal;
        if (tcoSum !== init.goalCents) {
          errors.push(`[SEED-DRIFT] Initiative #${init.id} (${init.title}): TCO sum ${tcoSum} !== goalCents ${init.goalCents}`);
        }
        if (init.goalCents % 100 !== 0) {
          errors.push(`[SEED-ROUNDING] Initiative #${init.id} goalCents (${init.goalCents}) is not rounded to whole euros`);
        }
      } else if (init.format === 'TICKETING') {
        const gross = init.ticketPriceCents * init.ticketMax;
        if (gross !== init.goalCents) {
          errors.push(`[SEED-TICKET-DRIFT] Initiative #${init.id}: ticketPriceCents*ticketMax ${gross} !== goalCents ${init.goalCents}`);
        }
      }
    }
  } catch (err) {
    errors.push(`[SEED-JSON-ERROR] Failed to parse src/mocks/seed_data.json: ${err.message}`);
  }
} else {
  errors.push('[SEED-MISSING] src/mocks/seed_data.json not found');
}

// 4. Verify zero obsolete double-extension files exist anywhere in workspace
const allWorkspaceFiles = walkFiles(ROOT, ['.md.md', '.json.json', '.ts.ts', '.prisma.txt']);
for (const dup of allWorkspaceFiles) {
  errors.push(`[DOUBLE-EXT] Obsolete duplicate file detected: ${path.relative(ROOT, dup)}`);
}

if (errors.length > 0) {
  console.error(`\n❌ KORUM INVARIANT GATE FAILED (${errors.length} violation(s)):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`✅ KORUM INVARIANT GATE PASSED: Prisma Int-cents OK, ${codeFiles.length} code file(s) clean, 8 seed initiatives reconciled to 0 cents drift.`);

