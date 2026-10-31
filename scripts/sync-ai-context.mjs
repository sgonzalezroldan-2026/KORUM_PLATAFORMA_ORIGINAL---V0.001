#!/usr/bin/env node
/**
 * KORUM · Sincroniza la configuración de Claude Code (.claude/skills y .claude/agents)
 * a partir de la fuente canónica en .agents/ (la que usa también Gemini/Antigravity).
 *
 *   node scripts/sync-ai-context.mjs          → regenera .claude/skills y .claude/agents
 *   node scripts/sync-ai-context.mjs --check  → solo comprueba; sale con código 1 si hay diferencias
 *
 * Los archivos generados llevan un aviso para no editarlos a mano.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const GENERATED_DIRS = ['.claude/skills', '.claude/agents'];

/** Herramientas de Antigravity → herramientas equivalentes de Claude Code. */
const TOOL_MAP = {
  read_file: ['Read', 'Grep', 'Glob'],
  write_file: ['Write'],
  edit_file: ['Edit'],
  run_command: ['Bash', 'PowerShell'],
  send_message: [],
  manage_task: []
};

/** Herramientas MCP: si un agente las usa, hereda todas las herramientas de la sesión (incluido el MCP de Playwright). */
const MCP_TOOLS = new Set(['call_mcp_tool', 'list_resources', 'read_resource']);

/**
 * Modelo y esfuerzo de cada subagente. La fuente es el frontmatter de .agents/agents/*.md
 * (claude-model, claude-effort, gemini-model, gemini-effort); criterio en docs/GUIA_IA_CLAUDE_Y_GEMINI.md §3.
 * Equivalencias fijadas por el promotor:
 *   Opus = Argon · Sonnet = Flash 3.8
 *   Flash 3.8 siempre en esfuerzo alto, sea cual sea el esfuerzo de Sonnet.
 *   Argon medio = Opus alto · Argon alto = Opus extra alto o máx. (Opus medio → Argon medio).
 */
const GEMINI_MODEL_FOR_CLAUDE = { opus: 'argon', sonnet: 'flash-3.8' };
const CLAUDE_EFFORTS = ['medium', 'high', 'xhigh', 'max'];
const GEMINI_EFFORTS = ['low', 'medium', 'high'];
const GEMINI_EFFORT_FOR_OPUS = { medium: 'medium', high: 'medium', xhigh: 'high', max: 'high' };

/** Comprueba que el par Claude/Gemini de un agente respeta las equivalencias. */
function validateModelPair(meta, sourceLabel) {
  const { claudeModel, claudeEffort, geminiModel, geminiEffort } = meta;
  if (!GEMINI_MODEL_FOR_CLAUDE[claudeModel]) {
    throw new Error(`${sourceLabel}: claude-model debe ser opus o sonnet (recibido "${claudeModel}")`);
  }
  if (!CLAUDE_EFFORTS.includes(claudeEffort)) {
    throw new Error(`${sourceLabel}: claude-effort debe ser uno de ${CLAUDE_EFFORTS.join(', ')} (recibido "${claudeEffort}")`);
  }
  if (geminiModel !== GEMINI_MODEL_FOR_CLAUDE[claudeModel]) {
    throw new Error(`${sourceLabel}: gemini-model debe ser "${GEMINI_MODEL_FOR_CLAUDE[claudeModel]}" para claude-model "${claudeModel}"`);
  }
  if (!GEMINI_EFFORTS.includes(geminiEffort)) {
    throw new Error(`${sourceLabel}: gemini-effort debe ser uno de ${GEMINI_EFFORTS.join(', ')} (recibido "${geminiEffort}")`);
  }
  const expectedEffort = claudeModel === 'sonnet' ? 'high' : GEMINI_EFFORT_FOR_OPUS[claudeEffort];
  if (geminiEffort !== expectedEffort) {
    throw new Error(`${sourceLabel}: gemini-effort debe ser "${expectedEffort}" para ${claudeModel} · ${claudeEffort}`);
  }
}

function listFilesRecursive(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function splitFrontmatter(text, sourceLabel) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) throw new Error(`${sourceLabel}: falta el bloque de frontmatter (---)`);
  return { frontmatter: match[1], body: text.slice(match[0].length) };
}

function generatedNotice(sourcePath, eol) {
  return `<!-- GENERADO AUTOMÁTICAMENTE desde ${sourcePath} por scripts/sync-ai-context.mjs. No editar aquí: edita la fuente y vuelve a ejecutar el script. -->${eol}${eol}`;
}

function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Lee el frontmatter simple de los agentes (claves de una línea + lista "tools"). */
function parseAgentFrontmatter(frontmatter, sourceLabel) {
  const result = { name: '', description: '', tools: [], claudeModel: '', claudeEffort: '', geminiModel: '', geminiEffort: '' };
  let inTools = false;
  for (const rawLine of frontmatter.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (inTools) {
      const item = /^\s*-\s*(\S+)\s*$/.exec(line);
      if (item) {
        result.tools.push(item[1]);
        continue;
      }
      inTools = false;
    }
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === 'tools') {
      inTools = value.trim() === '';
      if (!inTools) result.tools.push(...value.split(',').map((t) => t.trim()).filter(Boolean));
    } else if (key === 'name') {
      result.name = value.trim();
    } else if (key === 'description') {
      result.description = value.trim();
    } else if (key === 'claude-model') {
      result.claudeModel = value.trim();
    } else if (key === 'claude-effort') {
      result.claudeEffort = value.trim();
    } else if (key === 'gemini-model') {
      result.geminiModel = value.trim();
    } else if (key === 'gemini-effort') {
      result.geminiEffort = value.trim();
    }
  }
  if (!result.name || !result.description) {
    throw new Error(`${sourceLabel}: el frontmatter necesita "name" y "description" en una sola línea`);
  }
  return result;
}

function mapTools(antigravityTools, sourceLabel) {
  if (antigravityTools.some((t) => MCP_TOOLS.has(t))) return null;
  const mapped = [];
  for (const tool of antigravityTools) {
    const equivalents = TOOL_MAP[tool];
    if (!equivalents) throw new Error(`${sourceLabel}: herramienta sin equivalencia en Claude Code: "${tool}"`);
    for (const eq of equivalents) if (!mapped.includes(eq)) mapped.push(eq);
  }
  return mapped;
}

/** Devuelve un Map<rutaRelativaPosix, Buffer> con el contenido esperado de .claude/skills y .claude/agents. */
export function buildExpectedFiles(root) {
  const expected = new Map();

  const skillsRoot = path.join(root, '.agents', 'skills');
  for (const file of listFilesRecursive(skillsRoot)) {
    const relInSkills = toPosix(path.relative(skillsRoot, file));
    const target = `.claude/skills/${relInSkills}`;
    const buffer = fs.readFileSync(file);
    if (path.basename(file) === 'SKILL.md') {
      const text = buffer.toString('utf8');
      const eol = detectEol(text);
      const sourceLabel = `.agents/skills/${relInSkills}`;
      const { frontmatter, body } = splitFrontmatter(text, sourceLabel);
      const content = `---${eol}${frontmatter}${eol}---${eol}${eol}${generatedNotice(sourceLabel, eol)}${body.replace(/^(\r?\n)+/, '')}`;
      expected.set(target, Buffer.from(content, 'utf8'));
    } else {
      expected.set(target, buffer);
    }
  }

  const agentsRoot = path.join(root, '.agents', 'agents');
  for (const file of listFilesRecursive(agentsRoot).filter((f) => f.endsWith('.md'))) {
    const sourceLabel = `.agents/agents/${path.basename(file)}`;
    const text = fs.readFileSync(file, 'utf8');
    const eol = detectEol(text);
    const { frontmatter, body } = splitFrontmatter(text, sourceLabel);
    const meta = parseAgentFrontmatter(frontmatter, sourceLabel);
    const tools = mapTools(meta.tools, sourceLabel);
    validateModelPair(meta, sourceLabel);
    const header = [
      '---',
      `name: ${meta.name}`,
      `description: ${meta.description}`,
      ...(tools ? [`tools: ${tools.join(', ')}`] : []),
      `model: ${meta.claudeModel}`,
      `effort: ${meta.claudeEffort}`,
      '---'
    ].join(eol);
    // Los enlaces relativos a las reglas apuntan a .agents/rules desde la nueva ubicación.
    const adjustedBody = body.replace(/^(\r?\n)+/, '').split('](../rules/').join('](../../.agents/rules/');
    const content = `${header}${eol}${eol}${generatedNotice(sourceLabel, eol)}${adjustedBody}`;
    expected.set(`.claude/agents/${path.basename(file)}`, Buffer.from(content, 'utf8'));
  }

  return expected;
}

/** Compara lo generado con lo que hay en disco. Devuelve la lista de diferencias (vacía si está sincronizado). */
export function checkSync(root) {
  const expected = buildExpectedFiles(root);
  const problems = [];
  const existing = new Set(
    GENERATED_DIRS.flatMap((dir) => listFilesRecursive(path.join(root, dir)).map((f) => toPosix(path.relative(root, f))))
  );
  for (const [rel, content] of expected) {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) problems.push(`falta ${rel}`);
    else if (!fs.readFileSync(full).equals(content)) problems.push(`desactualizado ${rel}`);
    existing.delete(rel);
  }
  for (const rel of existing) problems.push(`sobra ${rel}`);
  return problems;
}

function writeAll(root) {
  const expected = buildExpectedFiles(root);
  for (const dir of GENERATED_DIRS) fs.rmSync(path.join(root, dir), { recursive: true, force: true });
  for (const [rel, content] of expected) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return expected.size;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (process.argv.includes('--check')) {
    const problems = checkSync(root);
    if (problems.length > 0) {
      console.error(`❌ .claude/ no está sincronizado con .agents/ (${problems.length}):`);
      for (const p of problems) console.error(`  - ${p}`);
      console.error('   Ejecuta: node scripts/sync-ai-context.mjs');
      process.exit(1);
    }
    console.log('✅ .claude/ sincronizado con .agents/');
  } else {
    const count = writeAll(root);
    console.log(`✅ Generados ${count} archivos en .claude/skills y .claude/agents a partir de .agents/`);
  }
}
