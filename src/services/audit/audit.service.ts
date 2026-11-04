import { dataHmac, HMAC_PURPOSE } from '@/core/security/crypto';
import type { AuditActorType } from '@/generated/prisma/enums';
import type { Prisma } from '@/generated/prisma/client';
import type { Db } from '@/lib/db';
import { redactText } from '@/lib/redact';

/**
 * Escritura del registro de auditoría (`AuditLog`, append-only por trigger) **sin datos sensibles** (CUMPLIMIENTO §5.2, QA-SEC07). Las
 * claves de `metadata` que suenan a dato personal o secreto (email, NIF, IBAN, tarjeta, token, contraseña, teléfono, nombre, valor…) se
 * sustituyen por `[redactado]`, y los textos pasan por `redactText`. La IP nunca se guarda: solo su HMAC. Es la vía para todo rastro
 * nuevo; las escrituras anteriores a este sprint ya registran solo identificadores y cifras.
 */

export const REDACTED = '[redactado]';
const MAX_DEPTH = 4;
const MAX_STRING = 300;
const MAX_ENTRIES = 40;

/** Palabras que, en el nombre de un campo, delatan un dato personal o un secreto. Se comparan por trozos del nombre (`donorTaxId` → donor, tax, id). */
const SENSITIVE_WORDS = new Set([
  'email', 'mail', 'correo', 'nif', 'nie', 'cif', 'dni', 'iban', 'card', 'tarjeta', 'pan', 'cvv', 'token', 'password', 'contrasena',
  'secret', 'secreto', 'otp', 'pin', 'phone', 'telefono', 'address', 'domicilio', 'direccion', 'name', 'nombre', 'holder', 'value', 'valor',
  'plaintext', 'fingerprint', 'huella', 'ip', 'agent', 'birth', 'nacimiento', 'fullname', 'surname', 'apellido', 'apikey', 'credential', 'credencial'
]);

/** Singular de una palabra (`names` → `name`, `addresses` → `address`), para que el plural no se cuele. */
const singular = (word: string) => (word.endsWith('es') && SENSITIVE_WORDS.has(word.slice(0, -2)) ? word.slice(0, -2) : word.endsWith('s') ? word.slice(0, -1) : word);
const SENSITIVE_PAIRS = new Set(['tax:id', 'user:agent', 'api:key', 'access:key', 'private:key']);

function wordsOf(key: string): string[] {
  return key
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function isSensitiveKey(key: string): boolean {
  const words = wordsOf(key);
  return words.some((word, index) => SENSITIVE_WORDS.has(word) || SENSITIVE_WORDS.has(singular(word)) || (index > 0 && SENSITIVE_PAIRS.has(`${singular(words[index - 1]!)}:${singular(word)}`)));
}

/** Copia limpia de `metadata`, apta para `AuditLog.metadataJson`. Profundidad y tamaño acotados: un objeto enorme no llena la auditoría. */
export function sanitizeAuditMetadata(value: unknown, depth = 0): Prisma.InputJsonValue | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') {
    // Primero se limpia y después se recorta: un email cortado por la mitad ya no lo reconocería el limpiador.
    const clean = redactText(value);
    return clean.length > MAX_STRING ? `${clean.slice(0, MAX_STRING)}…` : clean;
  }
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.slice(0, MAX_ENTRIES).map((item) => sanitizeAuditMetadata(item, depth + 1));
  if (typeof value === 'object') {
    const clean: Record<string, Prisma.InputJsonValue | null> = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_ENTRIES)) clean[key] = isSensitiveKey(key) ? REDACTED : sanitizeAuditMetadata(item, depth + 1);
    return clean as Prisma.InputJsonObject;
  }
  return null;
}

/** HMAC de la IP de quien actúa: permite ver que dos accesos vienen de la misma red sin guardar la IP. */
export const hashAuditIp = (hmacSecret: string, ip: string) => dataHmac(hmacSecret, HMAC_PURPOSE.auditIp, ip.trim());

export interface AuditEntry {
  actorType: AuditActorType;
  actorUserId?: string | null;
  organizationId?: string | null;
  action: string;
  targetType: string;
  targetId: string;
  /** Ya convertida con `hashAuditIp`: este servicio nunca recibe la IP en claro. */
  ipHash?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

const AGENT_MAX = 200;

export async function writeAudit(db: Db, entry: AuditEntry): Promise<void> {
  const metadata = entry.metadata ? sanitizeAuditMetadata(entry.metadata) : null;
  await db.auditLog.create({
    data: {
      actorType: entry.actorType,
      actorUserId: entry.actorUserId ?? null,
      organizationId: entry.organizationId ?? null,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      ipHash: entry.ipHash ?? null,
      userAgent: entry.userAgent ? entry.userAgent.slice(0, AGENT_MAX) : null,
      ...(metadata === null ? {} : { metadataJson: metadata })
    }
  });
}
