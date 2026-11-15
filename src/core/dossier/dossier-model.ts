/**
 * Expediente exportable (Sprint 5.8b, trazabilidad): lo que se sabe de una aportación, de una campaña o de una liquidación, reunido en un PDF para una
 * reclamación, un contracargo o una inspección. Aquí solo están la forma de los datos y lo que viaja en la dirección web; los carga
 * `src/services/dossier/` y los maqueta `dossier-pdf.ts`. Funciones puras, sin base de datos.
 *
 * **Criterio de datos personales (el más prudente, mientras el abogado no responda; CUMPLIMIENTO §9):** el expediente no lleva nunca el email, el NIF, el
 * nombre de quien aporta, su IP, su dispositivo, su tarjeta ni el identificador de su cuenta. Una persona que aporta es «una cuenta registrada» o «una
 * persona invitada». Se nombra, con su cargo, a quien firma por la entidad (ya figura así en el justificante del Fondo de actividades); en el expediente
 * que descarga la entidad, solo a quien firma **hoy**. También salen el titular que recibe una liquidación (la entidad o su proveedor) y, en la consola,
 * el comercio que paga un patrocinio. El de una aportación solo existe en la consola: para la entidad las aportaciones son anónimas (Regla 02 §7), y por
 * eso en el suyo los movimientos de la hucha van **sumados por tipo para toda la campaña**, nunca cobro a cobro ni por días.
 */

export const DOSSIER_KINDS = ['contribution', 'initiative', 'payout'] as const;
export type DossierKind = (typeof DOSSIER_KINDS)[number];
export type DossierScope = 'console' | 'entity';

/** Lo que una entidad puede descargar de sí misma. */
export const ENTITY_DOSSIER_KINDS: readonly DossierKind[] = ['initiative', 'payout'];

export const isDossierKind = (value: unknown): value is DossierKind => typeof value === 'string' && (DOSSIER_KINDS as readonly string[]).includes(value);

/** Tope de filas de cada lista del PDF: los totales se calculan siempre sobre todo; la lista enseña lo más reciente. */
export const DOSSIER_LEDGER_LIMIT = 1_500;
export const DOSSIER_AUDIT_LIMIT = 300;
export const DOSSIER_LIST_LIMIT = 500;
/** Apuntes que se leen como mucho para agrupar los movimientos de la entidad (se agrupan todos los leídos; si hubiera más, el PDF lo dice). */
export const DOSSIER_MOVEMENT_LIMIT = 50_000;

export interface DossierJournal {
  id: number;
  kind: string;
  occurredAt: Date;
  /** Pedido de Paycomet del asiento, si lo lleva. Solo en la consola. */
  reference: string | null;
  reversesId: number | null;
  entries: Array<{ account: string; direction: 'DEBIT' | 'CREDIT'; amountCents: number }>;
}

/**
 * Movimientos en lo que es de la entidad (la hucha de su campaña o lo aprobado para enviarle), sumados por tipo. Así el expediente de la entidad cuadra al
 * céntimo sin enseñar la hora ni el importe de cada aportación, que permitirían saber de quién es: lo que sale de aportaciones de personas va en una sola
 * fila para toda la campaña (`groupEntityMovements`); lo demás (la aprobación de la liquidación, el dinero de un comercio), por su día.
 */
export interface DossierMovement {
  /**
   * Primer y último día de España (`AAAA-MM-DD`) de la fila; iguales si es un solo día. `null` en lo que añade la bolsa Matching 2x: sus días, cruzados con
   * los de una fila de dos movimientos en dos días distintos, dirían qué importe tuvo la aportación de cada día.
   */
  from: string | null;
  to: string | null;
  kind: string;
  account: string;
  direction: 'DEBIT' | 'CREDIT';
  /** Cuántos son. `null` en lo que añade la bolsa Matching 2x: su número, restado del de donaciones, diría cuántas quedaron sin emparejar (y si es una, cuál). */
  count: number | null;
  totalCents: number;
}

export interface DossierLedger {
  /** Solo en la consola: los asientos enteros. */
  journals: DossierJournal[];
  /** Solo en el expediente de la entidad: sus movimientos, sumados por tipo. */
  movements: DossierMovement[];
  /** Solo en el expediente de la entidad: hay tantos apuntes que no se suman aquí (una suma parcial, restada de las tablas, dejaría lo que falta). */
  movementsOmitted: boolean;
  /** Asientos (o, para la entidad, apuntes) que existen en total; si son más que los leídos, el PDF lo dice. */
  totalJournals: number;
  /** Asientos de la lista cuyo debe no es igual a su haber. Siempre debe ser 0. */
  unbalanced: number;
}

/** Una cifra de la ficha frente a la misma cifra reconstruida desde los apuntes del libro mayor. */
export interface DossierCheck {
  key: 'raised' | 'charged' | 'refunded' | 'payoutNet' | 'payoutSent';
  recordCents: number;
  ledgerCents: number;
}

export interface DossierSignature {
  target: 'IDEA_APPROVAL' | 'ESCROW_PAYOUT';
  role: string;
  /** `null`: una cuenta suprimida o, en el expediente de la entidad, alguien que ya no firma por ella. */
  name: string | null;
  signedAt: Date;
  otpVerified: boolean;
  /** Huella de la firma (HMAC de lo firmado): si lo firmado cambia, deja de valer. */
  hash: string;
}

export interface DossierEmailGroup {
  templateKey: string;
  status: string;
  count: number;
  firstAt: Date;
  lastAt: Date;
}

export type DossierActor =
  | { kind: 'system' | 'webhook' | 'gate' | 'anonymous' | 'korum' | 'formerMember' | 'other' | 'erased' }
  | { kind: 'member'; name: string; role: string; roleLabel: string | null };

export interface DossierAuditRow {
  occurredAt: Date;
  action: string;
  actor: DossierActor;
  target: { type: string; id: string | null; name: string | null };
  statusChange: { from: string; to: string; reason: string | null } | null;
}

export interface DossierPayoutView {
  id: number;
  destinationType: string;
  beneficiaryName: string;
  /** Código del banco y cuatro últimos dígitos del IBAN del proveedor; nunca la cuenta entera. */
  iban: { bank: string | null; last4: string } | null;
  hasProviderInvoice: boolean;
  netPaidCents: number;
  korumFeeSettledCents: number;
  status: string;
  createdAt: Date;
  approvedAt: Date | null;
  executedAt: Date | null;
  /**
   * Lo que salió de la hucha al aprobarse (debe de `INITIATIVE_ESCROW` en su asiento de aprobación): el importe para el proyecto, la comisión de KORUM y el
   * coste de la pasarela incluido en la meta. `null` si aún no se ha aprobado.
   */
  escrowOutCents: number | null;
  /** Solo en la consola: los envíos cobro a cobro (los más recientes si hay muchos). */
  splits: Array<{ contributionId: number; chargedAt: Date; amountCents: number; status: string; executedAt: Date | null }>;
  /** Los envíos por estado: cuántos y cuánto suman. */
  splitSummary: Array<{ status: string; count: number; totalCents: number }>;
  /** Envíos que existen en total (la lista puede ser más corta). */
  totalSplits: number;
}

export interface DossierInitiativeView {
  id: number;
  title: string;
  walletEscrowId: string;
  format: string;
  status: string;
  createdAt: Date;
  closesAt: Date;
  firstPayinAt: Date | null;
  closedAt: Date | null;
  goalCents: number;
  raisedCents: number;
  totalContributions: number;
  /** Las 4 líneas públicas (Regla 02 §1), solo en campañas de presupuesto. `'mismatch'`: las cifras guardadas no cuadran con la meta, y el PDF lo dice. */
  breakdown: { line1Cents: number; line2Cents: number; line3Cents: number; line4Cents: number } | 'mismatch' | null;
  /**
   * Aportaciones por tipo y estado. En el expediente de la entidad el Auto-Impulso cuenta como una aportación más (Regla 02 §7). Dos estados no son de la
   * base: `MOVED`, el de un patrocinio cobrado en esta campaña cuyo dinero pasó a la bolsa del comercio (lo que de ella se coloca aquí va en `sponsorAllocations`); y
   * `POOL`, el de un patrocinio que es una bolsa Matching 2x (su dinero entra en la hucha al emparejar donaciones y ya figura en la línea de la bolsa), y
   * `POOL_PARTLY_MOVED` si además parte de esa bolsa ya se llevó a la bolsa del comercio o a otra campaña.
   * Y dos más: `CHARGEBACK_AFTER_PAYOUT` y `REFUNDED_AFTER_PAYOUT`, los de una aportación contracargada o devuelta con la campaña ya liquidada (su dinero
   * ya se había enviado, lo asumió KORUM y sigue en lo recaudado). Lo que añade la bolsa Matching 2x no está aquí. Las líneas cobradas y esas dos +
   * `matchingAddedCents` + `sponsorAllocations` suman lo recaudado, en los dos expedientes.
   */
  contributions: Array<{ type: string; status: string; count: number; totalCents: number }>;
  /**
   * Lo que la bolsa Matching 2x ha añadido a la hucha y sigue contando en lo recaudado, según el libro mayor (no según el estado de cada liberación: una
   * bolsa devuelta o contracargada con la campaña ya liquidada deja sus liberaciones como devueltas, pero ese dinero ya se envió y lo recaudado no baja).
   */
  matchingAddedCents: number;
  /** Solo en la consola, como detalle que no suma: las liberaciones de la bolsa por su estado, con su número. Para la entidad va vacío (sin número). */
  matchingDetail: Array<{ status: string; count: number; totalCents: number }>;
  /**
   * Dinero de patrocinios colocado en esta campaña desde la bolsa del comercio (asignaciones vigentes): de cuántos comercios y cuánto. También el de un
   * cobro de esta misma campaña que volvió a ella (una renovación colocada en su campaña de referencia), y el de una asignación cerrada con la campaña ya
   * liquidada (el cobro del comercio se deshizo después: ese dinero ya se había enviado).
   */
  sponsorAllocations: { count: number; totalCents: number };
}

export interface DossierContributionView {
  id: number;
  type: string;
  status: string;
  method: string;
  createdAt: Date;
  fiscalYear: number;
  /** Quién paga, sin identificarla: una cuenta (o una ya suprimida), una persona invitada, un comercio (con su nombre) o KORUM (Auto-Impulso). */
  payer: { kind: 'account' | 'erasedAccount' | 'guest' | 'korum' | 'matching' } | { kind: 'sponsor'; name: string };
  wantsTaxCertificate: boolean;
  ticketQuantity: number | null;
  amountCents: number;
  guaranteeCents: number;
  matchedBonusCents: number;
  totalChargedCents: number;
  refundedCents: number;
  refundedAt: Date | null;
  order: string | null;
  authCode: string | null;
  /** Avisos firmados de Paycomet sobre ese pedido: solo los campos que firma Paycomet, nunca la tarjeta. */
  notifications: Array<{ receivedAt: Date; transactionType: string; response: string; amountCents: number | null; status: string }>;
  /** Liquidaciones que repartieron este cobro. */
  splits: Array<{ source: 'campaign' | 'fund'; payoutId: number; amountCents: number; status: string; executedAt: Date | null }>;
}

interface DossierCommon {
  scope: DossierScope;
  /** Referencia del expediente: `EXP-A-…` (aportación), `EXP-C-…` (campaña) o `EXP-L-…` (liquidación). */
  reference: string;
  generatedAt: Date;
  entity: { name: string; legalName: string };
  initiative: DossierInitiativeView;
  ledger: DossierLedger;
  checks: DossierCheck[];
  signatures: DossierSignature[];
  emails: DossierEmailGroup[];
  audit: DossierAuditRow[];
  /** Hay más registros de actividad que los de la lista. */
  auditTruncated: boolean;
}

export type DossierData =
  | (DossierCommon & { kind: 'contribution'; contribution: DossierContributionView; payout: null })
  | (DossierCommon & { kind: 'initiative'; payout: DossierPayoutView | null })
  | (DossierCommon & { kind: 'payout'; payout: DossierPayoutView });

const PREFIX: Record<DossierKind, string> = { contribution: 'EXP-A', initiative: 'EXP-C', payout: 'EXP-L' };
export const dossierReference = (kind: DossierKind, id: number): string => `${PREFIX[kind]}-${id}`;

// --- Lo que viaja en la dirección web ------------------------------------------------------------------------------------------------------------------------

/** Nombres de los tipos en la dirección (en castellano, como el resto de los filtros del visor). */
export const DOSSIER_KIND_SLUGS: Record<DossierKind, string> = { contribution: 'aportacion', initiative: 'campana', payout: 'liquidacion' };
export const DOSSIER_QUERY_KEYS = { kind: 'expediente', ref: 'ref' } as const;

const KIND_BY_SLUG = new Map<string, DossierKind>(DOSSIER_KINDS.map((kind) => [DOSSIER_KIND_SLUGS[kind], kind]));
const MAX_INT = 2_147_483_647;
/** Pedido de Paycomet tal como lo genera la aplicación: letras, números y guiones. */
const ORDER_PATTERN = /^[A-Za-z0-9_-]{6,40}$/;

export type DossierRef = { by: 'id'; id: number } | { by: 'order'; order: string };
export interface DossierRequest {
  kind: DossierKind;
  ref: DossierRef;
}

const positiveInt = (text: string): number | null => {
  if (!/^[1-9]\d{0,9}$/.test(text)) return null;
  const value = Number(text);
  return value <= MAX_INT ? value : null;
};

type Raw = Record<string, string | string[] | undefined>;
const first = (raw: Raw, key: string): string => {
  const value = raw[key];
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
};

/** Lo que la persona escribió en el selector, para devolvérselo si no se encuentra: no tiene que reescribirlo. Solo texto corto y sin caracteres raros. */
export function dossierTyped(raw: Raw): { kindSlug: string | null; ref: string } {
  const [slug = ''] = first(raw, DOSSIER_QUERY_KEYS.kind).split(':', 2);
  const ref = first(raw, DOSSIER_QUERY_KEYS.ref);
  return { kindSlug: KIND_BY_SLUG.has(slug) ? slug : null, ref: /^[\p{L}\p{N} ._-]{1,40}$/u.test(ref) ? ref : '' };
}

/**
 * Lee qué expediente se pide: `expediente=campana&ref=12` (la consola escribe el número) o `expediente=campana:12` (el panel lo elige de una lista). Una
 * aportación también se puede pedir por su pedido de Paycomet, que es lo que trae un contracargo. `null` si no se pide ninguno; `'invalid'` si se pide mal.
 */
export function parseDossierRequest(raw: Raw): DossierRequest | 'invalid' | null {
  const value = first(raw, DOSSIER_QUERY_KEYS.kind);
  if (!value) return null;
  const [slug = '', inline] = value.split(':', 2);
  const kind = KIND_BY_SLUG.get(slug);
  const refText = inline ?? first(raw, DOSSIER_QUERY_KEYS.ref);
  if (!kind || !refText || refText.length > 40) return 'invalid';
  const id = positiveInt(refText);
  if (id !== null) return { kind, ref: { by: 'id', id } };
  return kind === 'contribution' && ORDER_PATTERN.test(refText) ? { kind, ref: { by: 'order', order: refText } } : 'invalid';
}
