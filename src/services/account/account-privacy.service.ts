import { ErasureBlockedError, erasePersonalData, type ErasureBlock, type ErasureDeps } from '@/core/privacy/erasure.service';
import { renderPersonalDataPdf, type ExportLocale, type ExportTranslator } from '@/core/privacy/export-pdf';
import { buildPersonalDataExport } from '@/core/privacy/personal-data-export';
import { closePrivacyRequest, openPrivacyRequest } from '@/core/privacy/privacy-requests';
import type { Keyring } from '@/core/security/crypto';
import type { VerifiedAccountActor } from '@/core/security/verified-actor';
import type { Db } from '@/lib/db';
import { reserveAttempt } from '@/lib/rate-limit';
import { ACCOUNT_ERASURE_RULE, ACCOUNT_EXPORT_RULE } from '@/lib/rate-limit-rules';

/**
 * Derechos RGPD en autoservicio desde *Mi cuenta* (Sprint 3.7, QA-PRIV01 y QA-REG03). Quien llama ya ha obtenido el `VerifiedAccountActor`
 * con `requireVerifiedAccount` (sesión reautenticada hace menos de 10 minutos); aquí se aplican el límite de intentos por persona y el rastro
 * de la solicitud (`PrivacyRequest`), y se llama a los servicios de `src/core/privacy/`, que vuelven a comprobar el actor dentro de su operación.
 *
 * - **Exportar:** cada descarga abre y cierra su propia solicitud `EXPORT` (respuesta al momento, muy dentro del mes legal). El fichero se
 *   entrega en la propia respuesta: nunca va adjunto a un email ni queda guardado en el almacén.
 * - **Suprimir:** abre una solicitud `ERASURE`; si la supresión está bloqueada (firmante de una entidad, Super-Admin, saldo en el monedero) la
 *   solicitud se cierra como rechazada con el motivo, sin datos personales, y la persona ve qué tiene que hacer antes.
 */

export type ExportFormat = 'json' | 'pdf';

export interface ExportFile {
  bytes: Uint8Array;
  contentType: string;
  fileName: string;
}

export type ExportOutcome = { status: 'OK'; file: ExportFile } | { status: 'RATE_LIMITED' };

/** Nombre del fichero: fecha, sin el email ni el nombre de la persona (los nombres de las descargas quedan en el historial del navegador). */
export const exportFileName = (format: ExportFormat, now: Date) => `korum-mis-datos-${now.toISOString().slice(0, 10)}.${format}`;

export async function exportOwnData(
  db: Db,
  deps: { keyring: Keyring; hmacSecret: string },
  input: { actor: VerifiedAccountActor; format: ExportFormat; locale: ExportLocale; t: ExportTranslator },
  now: Date = new Date()
): Promise<ExportOutcome> {
  if (!(await reserveAttempt(db, `${ACCOUNT_EXPORT_RULE.prefix}${input.actor.userId}`, ACCOUNT_EXPORT_RULE, now))) return { status: 'RATE_LIMITED' };
  const request = await openPrivacyRequest(db, deps.hmacSecret, { actor: input.actor, type: 'EXPORT', notes: `formato:${input.format}` }, now);
  let bytes: Uint8Array;
  try {
    const data = await buildPersonalDataExport(db, deps.keyring, { kind: 'self', actor: input.actor }, now);
    bytes = input.format === 'pdf' ? renderPersonalDataPdf(data, input.t, input.locale) : new TextEncoder().encode(`${JSON.stringify(data, null, 2)}\n`);
  } catch (error) {
    // La solicitud no se queda «Recibida» para siempre: se cierra como no atendida y la persona puede volver a pedirla.
    await closePrivacyRequest(db, request.id, { status: 'REJECTED', notes: 'error:exportacion' }, { kind: 'self', actor: input.actor }, now).catch(() => undefined);
    throw error;
  }
  await closePrivacyRequest(db, request.id, { status: 'COMPLETED' }, { kind: 'self', actor: input.actor }, now);
  return {
    status: 'OK',
    file: { bytes, contentType: input.format === 'pdf' ? 'application/pdf' : 'application/json; charset=utf-8', fileName: exportFileName(input.format, now) }
  };
}

export type EraseOutcome =
  | { status: 'ERASED'; retainedFiscalRecords: number }
  | { status: 'BLOCKED'; reason: Exclude<ErasureBlock, 'NOT_ACCOUNT_OWNER'> }
  | { status: 'RATE_LIMITED' };

export async function eraseOwnAccount(db: Db, deps: ErasureDeps, input: { actor: VerifiedAccountActor }, now: Date = new Date()): Promise<EraseOutcome> {
  const { actor } = input;
  if (!(await reserveAttempt(db, `${ACCOUNT_ERASURE_RULE.prefix}${actor.userId}`, ACCOUNT_ERASURE_RULE, now))) return { status: 'RATE_LIMITED' };
  const request = await openPrivacyRequest(db, deps.hmacSecret, { actor, type: 'ERASURE' }, now);
  try {
    const result = await erasePersonalData(db, deps, { userId: actor.userId, requestedBy: { kind: 'self', actor }, requestId: request.id }, now);
    return { status: 'ERASED', retainedFiscalRecords: result.retainedFiscalRecords };
  } catch (error) {
    // `NOT_ACCOUNT_OWNER` no puede darse aquí (el actor es la propia cuenta): si apareciera, es un fallo y debe verse como tal.
    if (!(error instanceof ErasureBlockedError) || error.reason === 'NOT_ACCOUNT_OWNER') throw error;
    await closePrivacyRequest(db, request.id, { status: 'REJECTED', notes: `bloqueo:${error.reason}` }, { kind: 'self', actor }, now);
    return { status: 'BLOCKED', reason: error.reason };
  }
}
