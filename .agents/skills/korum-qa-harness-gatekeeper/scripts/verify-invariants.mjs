#!/usr/bin/env node
/**
 * KORUM v8.5 · Deterministic Invariant & Zero-Placeholder Gatekeeper
 * Scans code, schema, seed data and project documentation to guarantee code hygiene and
 * documentation coherence before closing any Micro-Sprint.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const errors = [];
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'generated', 'coverage', 'playwright-report', 'test-results']);

function walkFiles(dirPath, extensions) {
  const results = [];
  if (!fs.existsSync(dirPath)) return results;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
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

// 2. Scan TypeScript / TSX / scripts for placeholders, forbidden copy, and secret leaks
const codeDirs = ['src', 'prisma', 'tests', 'scripts'];
const codeFiles = codeDirs.flatMap((d) => walkFiles(path.join(ROOT, d), ['.ts', '.tsx', '.js', '.mjs']));

const placeholderPatterns = [
  // Sensible a mayúsculas a propósito: «Todo menos la API…» es castellano normal en un comentario, «TODO:» no.
  { id: 'TODO-COMMENT', regex: /\/\/\s*(TODO|FIXME|HACK)\b/ },
  { id: 'OMISSION-ELLIPSIS', regex: /\/\/\s*\.\.\.\s*(resto|rest|remaining|keep|mantener|igual)/i },
  { id: 'BLOCK-OMISSION', regex: /\/\*\s*\.\.\.\s*\*\// }
];

const secretLeakRegex =
  /NEXT_PUBLIC_(PAYCOMET_API_KEY|PAYCOMET_WEBHOOK_SECRET|QR_HMAC_SECRET|AUTH_SECRET|BETTER_AUTH_SECRET|ENCRYPTION_KEY|DATA_HMAC_SECRET|CRON_SECRET|SUPABASE_SERVICE_ROLE_KEY|EMAIL_API_KEY|SENTRY_AUTH_TOKEN|DATABASE_URL|DIRECT_URL)\b/;
const forbiddenMaintenanceLabel = /\(Desactivado\)/;
// Un sorteo, un PIN o una numeración fiscal con un generador predecible no serían certificables (QA-REG01).
const predictableRandomDirs = [path.join('src', 'core', 'ticketing') + path.sep, path.join('src', 'core', 'tax') + path.sep, path.join('src', 'services', 'invoicing') + path.sep];

// La prueba de reautenticación (`markSessionReauthenticated`) solo la escribe la capa de sesión, al comprobar el código, el enlace, el
// TOTP o la llave de acceso (Sprint 2.5, QA-SEC07). Cualquier otro sitio que la llame podría fabricar un actor verificado.
const reauthWriterAllowed = [path.join('src', 'core', 'security', 'verified-actor.ts'), path.join('src', 'lib', 'auth') + path.sep, path.join('src', 'app', 'api', 'auth') + path.sep];

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
    if (predictableRandomDirs.some((dir) => rel.startsWith(dir)) && /Math\.random/.test(line)) {
      errors.push(`[PREDICTABLE-RANDOM] ${rel}:${idx + 1} usa Math.random: en taquilla y fiscalidad solo vale node:crypto`);
    }
    if (!isTestFile && /(markSessionReauthenticated|reauthenticatedAt|secondFactorVerifiedAt)/.test(line) && !reauthWriterAllowed.some((allowed) => rel === allowed || rel.startsWith(allowed))) {
      errors.push(`[REAUTH-WRITER] ${rel}:${idx + 1} toca la prueba de reautenticación: solo la capa de sesión (src/lib/auth, src/app/api/auth) puede escribirla o leerla fuera de verified-actor.ts`);
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

// 3. Reconcile seed_data.json to the exact cent (0 cent drift) and validate domain coherence
const INITIATIVE_STATUSES = new Set([
  'BUDGETING', 'FUNDRAISING', 'GOAL_REACHED', 'CLOSED', 'EXPIRED', 'RESIZE_VOTING', 'REFUNDING', 'REFUNDED', 'CANCELLED'
]);
let seedInitiativesCount = 0;
const seedPath = path.join(ROOT, 'src', 'mocks', 'seed_data.json');
if (fs.existsSync(seedPath)) {
  try {
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    for (const init of seed.initiatives ?? []) {
      seedInitiativesCount += 1;
      if (!INITIATIVE_STATUSES.has(init.status)) {
        errors.push(`[SEED-STATUS] Initiative #${init.id} has unknown status "${init.status}" (use InitiativeStatus codes)`);
      }
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
        // La pasarela de una entrada la cubren los gastos de gestión digital: la taquilla no la descuenta de la hucha (Sprint 4.3, alineado en el 4.4a).
        if (init.gatewayFeeCents !== 0) {
          errors.push(`[SEED-TICKET-GATEWAY] Initiative #${init.id}: gatewayFeeCents must be 0 for TICKETING (got ${init.gatewayFeeCents})`);
        }
      }
    }
    const rules = seed.globalRules ?? {};
    if (!['FLAT', 'MARGINAL'].includes(rules.bracketMode)) {
      errors.push(`[SEED-BRACKET-MODE] globalRules.bracketMode must be FLAT or MARGINAL, got "${rules.bracketMode}"`);
    }
    if (!(Number.isSafeInteger(rules.t1MaxCents) && Number.isSafeInteger(rules.t2MaxCents) && rules.t1MaxCents > 0 && rules.t1MaxCents < rules.t2MaxCents)) {
      errors.push('[SEED-BRACKET-LIMITS] globalRules.t1MaxCents and t2MaxCents must be integers with 0 < t1MaxCents < t2MaxCents');
    }
    if (!Number.isSafeInteger(rules.topupFeeCents) || !Number.isSafeInteger(rules.topupFeeBps)) {
      errors.push('[SEED-TOPUP-FEE] globalRules.topupFeeCents and topupFeeBps must be integers');
    }
    for (const org of seed.schools ?? []) {
      if (org.vertical === 'SCHOOL' && org.centerOwnership === 'PUBLIC' && org.legalForm !== 'PARENTS_ASSOCIATION') {
        errors.push(`[SEED-FUND-HOLDER] ${org.id}: a public school can only collect funds through its AMPA/AFA (legalForm PARENTS_ASSOCIATION)`);
      }
      if (org.ley49 === true && org.legalForm === 'SCHOOL_OWNER') {
        errors.push(`[SEED-LEY49] ${org.id}: a school owner entity cannot declare the Ley 49/2002 regime`);
      }
      const signers = org.signers ?? [];
      const director = signers.find((s) => s.role === 'DIRECTOR');
      const cosigner = signers.find((s) => s.role === 'COSIGNER');
      if (!director || !cosigner || director.email === cosigner.email) {
        errors.push(`[SEED-SIGNERS] ${org.id}: needs one DIRECTOR and one COSIGNER with different emails`);
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

// 5. Documentation coherence: discarded brand, legacy role names
const docFiles = [
  ...['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'].map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f)),
  ...walkFiles(path.join(ROOT, 'docs'), ['.md']),
  ...walkFiles(path.join(ROOT, '.agents'), ['.md']),
  prismaPath,
  ...walkFiles(path.join(ROOT, 'src'), ['.ts', '.tsx', '.json'])
].filter((f) => fs.existsSync(f));
const docDriftPatterns = [
  { id: 'BRAND-DRIFT', regex: /Ágora-K|#0B1526|seriedad bancaria|solvencia bancaria|Stripe, Qonto/i, hint: 'discarded banking brand (use Escudo Varsity Heritage)' },
  { id: 'ROLE-DRIFT', regex: /AFA_PRESIDENT/, hint: 'legacy role name (use COSIGNER)' }
];
for (const file of docFiles) {
  const rel = path.relative(ROOT, file);
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, idx) => {
    for (const pat of docDriftPatterns) {
      if (pat.regex.test(line)) errors.push(`[${pat.id}] ${rel}:${idx + 1} ${pat.hint}: "${line.trim().slice(0, 120)}"`);
    }
  });
}

// 4b. Ledger immutability must survive every migration: the guards exist and no later migration drops or disables them
const migrationsDir = path.join(ROOT, 'prisma', 'migrations');
let migrationsChecked = 0;
if (fs.existsSync(migrationsDir)) {
  const migrationFiles = walkFiles(migrationsDir, ['.sql']).sort();
  migrationsChecked = migrationFiles.length;
  const allSql = migrationFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  const requiredGuards = [
    'LedgerJournal_immutable',
    'EscrowLedgerEntry_immutable',
    'AuditLog_immutable',
    'LedgerJournal_no_truncate',
    'EscrowLedgerEntry_no_truncate',
    'AuditLog_no_truncate',
    // El trigger de cuadre por apunte SÍ hace falta (SET CONSTRAINTS IMMEDIATE lo demostró en la auditoría 1.3).
    'LedgerJournal_balanced',
    'EscrowLedgerEntry_balanced',
    'EscrowLedgerEntry_amountCents_positive',
    'LedgerJournal_stamp_tx',
    'EscrowLedgerEntry_same_transaction',
    // El acta de un sorteo no se puede repetir ni retocar, y el aforo no se puede superar (Sprint 2.3).
    'RaffleDraw_immutable',
    'RaffleDraw_no_truncate',
    'Initiative_tickets_within_capacity',
    'Initiative_prize_count_locked',
    // La votación de redimensionamiento decide sobre el dinero de quienes donaron: ni ella ni sus votos se retocan ni se borran (Sprint 4.4b).
    'ResizePoll_keep_history',
    'ResizeVote_keep_history'
  ];
  // Lo que cuenta es el estado FINAL de cada guarda: se recorren las migraciones en orden y gana el último evento (crear/eliminar).
  // Una migración puede eliminar una guarda y otra posterior restaurarla (ocurrió en 1.3); lo que no puede quedar es eliminada.
  const guardEvents = (guard) => {
    const events = [];
    migrationFiles.forEach((file, order) => {
      const sql = fs.readFileSync(file, 'utf8');
      const create = new RegExp(`(?:CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:CONSTRAINT\\s+)?TRIGGER|ADD\\s+CONSTRAINT)\\s+"${guard}"`, 'gi');
      const drop = new RegExp(`DROP\\s+(?:TRIGGER|CONSTRAINT)\\s+(?:IF\\s+EXISTS\\s+)?"${guard}"`, 'gi');
      for (const match of sql.matchAll(create)) events.push({ order, index: match.index, kind: 'create' });
      for (const match of sql.matchAll(drop)) events.push({ order, index: match.index, kind: 'drop' });
    });
    return events.sort((a, b) => a.order - b.order || a.index - b.index);
  };
  for (const guard of requiredGuards) {
    const events = guardEvents(guard);
    if (!events.some((event) => event.kind === 'create')) errors.push(`[LEDGER-GUARD-MISSING] no migration creates "${guard}"`);
    else if (events[events.length - 1].kind === 'drop') errors.push(`[LEDGER-GUARD-DROPPED] the last migration touching "${guard}" drops it (the ledger must stay append-only and balanced)`);
  }
  if (/DISABLE\s+TRIGGER/i.test(allSql)) errors.push('[LEDGER-GUARD-DISABLED] a migration disables triggers');
  // Las funciones `korum_*` de los triggers deben terminar con su search_path fijado y pg_temp al final (si no, una tabla temporal
  // las engaña). Igual que con las guardas, cuenta el ESTADO FINAL: un `CREATE OR REPLACE FUNCTION` posterior sin `SET search_path`
  // borra el endurecimiento anterior, así que tras la última definición de cada función debe haber otro endurecimiento.
  const functionEvents = new Map();
  const pushFunctionEvent = (name, event) => functionEvents.set(name, [...(functionEvents.get(name) ?? []), event]);
  migrationFiles.forEach((file, order) => {
    const sql = fs.readFileSync(file, 'utf8');
    for (const definition of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:\w+\.)?"?(korum_\w+)"?\s*\(([\s\S]*?)\bAS\s+\$/gi)) {
      const setting = /SET\s+search_path\s*(?:=|TO)\s*([^\n]*)/i.exec(definition[2]);
      pushFunctionEvent(definition[1], { order, index: definition.index, hardened: Boolean(setting) && /pg_temp\s*$/i.test(setting[1].trim()) });
    }
    for (const alter of sql.matchAll(/ALTER\s+FUNCTION[^;]*?SET\s+search_path\s*=\s*%I,\s*pg_catalog,\s*pg_temp/gi)) {
      for (const name of sql.matchAll(/'(korum_\w+)\(/g)) pushFunctionEvent(name[1], { order, index: alter.index, hardened: true });
    }
  });
  if (functionEvents.size === 0) errors.push('[LEDGER-SEARCH-PATH] ninguna migración define las funciones korum_* de los triggers');
  for (const [name, events] of functionEvents) {
    events.sort((a, b) => a.order - b.order || a.index - b.index);
    if (!events[events.length - 1].hardened) errors.push(`[LEDGER-SEARCH-PATH] la última definición de ${name}() no deja su search_path fijado con pg_temp al final`);
  }
} else {
  errors.push('[MIGRATIONS-MISSING] prisma/migrations not found');
}

// 5b. Brand files cited in the documentation must exist (discarded assets live in public/brand/_old and are not cited as current)
const brandRef = /public\/brand\/([\w./-]+\.(?:svg|jpg|jpeg|png|webp|avif))/g;
for (const file of docFiles) {
  const rel = path.relative(ROOT, file);
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, idx) => {
    for (const match of line.matchAll(brandRef)) {
      const cited = match[1];
      if (cited.startsWith('_old/') || cited.startsWith('generated/')) continue;
      if (!fs.existsSync(path.join(ROOT, 'public', 'brand', ...cited.split('/')))) {
        errors.push(`[BRAND-ASSET-MISSING] ${rel}:${idx + 1} cites public/brand/${cited}, which does not exist`);
      }
    }
  });
}

// 6. Prototype anatomy anchors must still point to the right line of prototype/Korum_v8.html
const anatomyPath = path.join(ROOT, '.agents', 'skills', 'korum-nextjs-multitenant-ui', 'references', 'korum-v8-anatomy.md');
const prototypePath = path.join(ROOT, 'prototype', 'Korum_v8.html');
let anchorsChecked = 0;
if (fs.existsSync(anatomyPath) && fs.existsSync(prototypePath)) {
  const protoLines = fs.readFileSync(prototypePath, 'utf8').split(/\r?\n/);
  for (const line of fs.readFileSync(anatomyPath, 'utf8').split(/\r?\n/)) {
    const row = /\|\s*`([^`]+)`\s*\|\s*L(\d+)\s*\|\s*$/.exec(line);
    if (!row) continue;
    anchorsChecked += 1;
    const [, anchor, lineNo] = row;
    const target = protoLines[Number(lineNo) - 1] ?? '';
    if (!target.includes(anchor)) {
      errors.push(`[ANATOMY-DRIFT] korum-v8-anatomy.md: anchor "${anchor}" is not at prototype line ${lineNo}`);
    }
  }
  if (anchorsChecked === 0) errors.push('[ANATOMY-EMPTY] korum-v8-anatomy.md has no verifiable anchor rows');
} else {
  errors.push('[ANATOMY-MISSING] anatomy index or prototype not found');
}

// 7. Every sprint in the plan must carry its recommended AI model line (🤖)
const planPath = path.join(ROOT, 'docs', 'PLAN_IMPLEMENTACION_ATOMICO.md');
let sprintsChecked = 0;
if (fs.existsSync(planPath)) {
  const blocks = fs.readFileSync(planPath, 'utf8').split(/\r?\n(?=- \[[ x]\] \*\*SPRINT )/);
  for (const block of blocks.slice(1)) {
    const title = /\*\*SPRINT ([0-9.]+)/.exec(block)?.[1] ?? '?';
    const isOpen = block.startsWith('- [ ]');
    if (!isOpen) continue;
    sprintsChecked += 1;
    if (!block.includes('🤖')) errors.push(`[PLAN-MODEL] Sprint ${title} has no recommended AI model line (🤖)`);
  }
}

// 8. Claude Code configuration (.claude/) must be in sync with the canonical .agents/ sources
const syncScript = path.join(ROOT, 'scripts', 'sync-ai-context.mjs');
if (fs.existsSync(syncScript)) {
  try {
    const { checkSync } = await import(pathToFileURL(syncScript).href);
    for (const problem of checkSync(ROOT)) errors.push(`[AI-SYNC] .claude/ ${problem} (run: node scripts/sync-ai-context.mjs)`);
  } catch (err) {
    errors.push(`[AI-SYNC-ERROR] ${err.message}`);
  }
} else {
  errors.push('[AI-SYNC-MISSING] scripts/sync-ai-context.mjs not found');
}

if (errors.length > 0) {
  console.error(`\n❌ KORUM INVARIANT GATE FAILED (${errors.length} violation(s)):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(
  `✅ KORUM INVARIANT GATE PASSED: Prisma Int-cents OK, ${codeFiles.length} code file(s) clean, ` +
    `${seedInitiativesCount} seed initiatives reconciled to 0 cents drift, ${docFiles.length} doc file(s) coherent, ` +
    `${anchorsChecked} prototype anchors verified, ${sprintsChecked} open sprints with AI model, ${migrationsChecked} migration(s) keep ledger guards, .claude/ in sync.`
);
