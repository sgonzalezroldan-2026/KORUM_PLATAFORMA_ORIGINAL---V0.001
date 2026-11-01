import { createHash } from 'node:crypto';

/**
 * Registro de facturación de alta de Veri*factu: huella SHA-256 encadenada, según las especificaciones de la AEAT (versión 0.1.2), y URL del
 * QR. Funciones puras, comprobadas con los ejemplos oficiales. KORUM calcula la huella para encadenar las facturas en orden; el proveedor
 * homologado que se elija la recibe y la AEAT la comprueba.
 */

const HUSO_ZONE = 'Europe/Madrid';
export const VERIFACTU_QR_BASE_URL = 'https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR';

export interface VerifactuRecord {
  issuerTaxId: string;
  invoiceNumber: string;
  /** `dd-mm-aaaa` */
  issueDate: string;
  invoiceType: string;
  /** Con punto decimal: `12.35`. */
  taxTotal: string;
  amountTotal: string;
  previousHash: string | null;
  /** `aaaa-mm-ddThh:mm:ss+01:00` */
  generatedAt: string;
}

export const formatCents = (cents: number): string => `${Math.trunc(cents / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;

function madridParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: HUSO_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)!.value;
  return { year: pick('year'), month: pick('month'), day: pick('day'), hour: pick('hour'), minute: pick('minute'), second: pick('second'), offset: pick('timeZoneName').replace('GMT', '') || '+00:00' };
}

/** Fecha de expedición en hora de Madrid: una factura de las 00:30 del 1 de enero es del año nuevo aunque en UTC aún sea el anterior. */
export function issueDateOf(date: Date): string {
  const { day, month, year } = madridParts(date);
  return `${day}-${month}-${year}`;
}

export function generatedAtOf(date: Date): string {
  const { year, month, day, hour, minute, second, offset } = madridParts(date);
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`;
}

export const invoiceYearOf = (date: Date): number => Number(madridParts(date).year);

/** La cadena exacta sobre la que se calcula la huella. El primer registro lleva `Huella=` sin valor. */
export function hashInput(record: VerifactuRecord): string {
  return [
    `IDEmisorFactura=${record.issuerTaxId.trim()}`,
    `NumSerieFactura=${record.invoiceNumber.trim()}`,
    `FechaExpedicionFactura=${record.issueDate.trim()}`,
    `TipoFactura=${record.invoiceType.trim()}`,
    `CuotaTotal=${record.taxTotal.trim()}`,
    `ImporteTotal=${record.amountTotal.trim()}`,
    `Huella=${record.previousHash?.trim() ?? ''}`,
    `FechaHoraHusoGenRegistro=${record.generatedAt.trim()}`
  ].join('&');
}

/** Hexadecimal, mayúsculas, 64 caracteres. */
export const computeVerifactuHash = (record: VerifactuRecord): string => createHash('sha256').update(hashInput(record), 'utf8').digest('hex').toUpperCase();

export function verifactuQrUrl(record: Pick<VerifactuRecord, 'issuerTaxId' | 'invoiceNumber' | 'issueDate' | 'amountTotal'>, baseUrl: string = VERIFACTU_QR_BASE_URL): string {
  const query = new URLSearchParams({ nif: record.issuerTaxId, numserie: record.invoiceNumber, fecha: record.issueDate, importe: record.amountTotal });
  return `${baseUrl}?${query.toString()}`;
}
