import { validateTaxId, type TaxIdKind } from './tax-id';

/**
 * Fichero del Modelo 182 (QA-REG02): registros de 250 posiciones, según el diseño de registro de la AEAT. Función pura: quien llama decide
 * quién entra. La posición 132 (recurrencia) se redactó de nuevo con la Orden HAC/1430/2025; el diseño completo lo debe revisar la asesoría
 * fiscal antes de la primera presentación real (ficha 6.1).
 */

export const RECORD_LENGTH = 250;
/** Primer ejercicio con la escala vigente del Real Decreto-ley 6/2023. Antes de él KORUM no existía. */
const FIRST_SUPPORTED_YEAR = 2024;
const IRPF_THRESHOLD_CENTS = 25_000;

export class Model182FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Model182FormatError';
  }
}

export const PROVINCE_CODES: ReadonlySet<string> = new Set([...Array.from({ length: 52 }, (_, index) => String(index + 1).padStart(2, '0')), '99']);

export type DeclaredNature = 'F' | 'J' | 'E';

/** Persona física, persona jurídica o entidad en atribución de rentas (comunidad de bienes `E`, sociedad civil `J`). */
export function declaredNature(taxId: string, kind: TaxIdKind): DeclaredNature {
  if (kind !== 'CIF') return 'F';
  return taxId[0] === 'E' || taxId[0] === 'J' ? 'E' : 'J';
}

/**
 * Recurrencia (posición 132): donó en los dos ejercicios anteriores, y cada uno por un importe igual o superior al del ejercicio anterior a
 * él. Los importes van del más antiguo al más reciente: `[año−3, año−2, año−1]`.
 */
export function isRecurrentDonor([threeAgo, twoAgo, oneAgo]: readonly [number, number, number]): boolean {
  return twoAgo > 0 && oneAgo > 0 && oneAgo >= twoAgo && twoAgo >= threeAgo;
}

/**
 * Porcentaje de deducción (posiciones 79-83), en centésimas. En personas físicas se declara el de la parte que excede de 250 €; si no se
 * excede, el general. Personas jurídicas: 40 %, o 50 % con recurrencia. Las entidades en atribución de rentas siguen la escala de IRPF,
 * porque la renta se atribuye a sus miembros (a confirmar por la asesoría).
 */
export function deductionPercent(nature: DeclaredNature, amountCents: number, recurrent: boolean): number {
  if (nature === 'J') return recurrent ? 5_000 : 4_000;
  if (amountCents <= IRPF_THRESHOLD_CENTS) return 8_000;
  return recurrent ? 4_500 : 4_000;
}

/** Mayúsculas, sin acentos ni caracteres especiales. La Ñ y la Ç se conservan. */
export function normalizeText(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/Ñ/g, '\u0001')
    .replace(/Ç/g, '\u0002')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\u0001/g, 'Ñ')
    .replace(/\u0002/g, 'Ç')
    .replace(/[^A-Z0-9ÑÇ ]/g, ' ')
    .replace(/ +/g, ' ')
    .trim();
}

const numeric = (value: number | string, length: number): string => {
  const text = String(value);
  if (!/^\d+$/.test(text) || text.length > length) throw new Model182FormatError(`Valor numérico fuera de formato para ${length} posiciones.`);
  return text.padStart(length, '0');
};
const text = (value: string, length: number): string => normalizeText(value).slice(0, length).padEnd(length, ' ');
const taxIdField = (value: string): string => value.padStart(9, '0');

function assertRecord(record: string): string {
  if (record.length !== RECORD_LENGTH) throw new Model182FormatError(`Registro de ${record.length} posiciones.`);
  return record;
}

export interface Model182Declarant {
  taxId: string;
  legalName: string;
  contactPhone: string;
  contactName: string;
  fiscalYear: number;
  /** Número de justificante: 13 cifras que empiezan por 182. */
  declarationNumber: string;
}

export interface Model182Donor {
  taxId: string;
  kind: TaxIdKind;
  fullName: string;
  provinceCode: string;
  amountCents: number;
  /** Importes del mismo donante a esta entidad en los tres ejercicios anteriores, del más antiguo al más reciente. */
  previousYearsCents: readonly [number, number, number];
}

export function buildDeclarantRecord(declarant: Model182Declarant, donorCount: number, totalCents: number): string {
  return assertRecord(
    [
      '1',
      '182',
      numeric(declarant.fiscalYear, 4),
      taxIdField(declarant.taxId),
      text(declarant.legalName, 40),
      'T',
      numeric(declarant.contactPhone, 9),
      text(declarant.contactName, 40),
      numeric(declarant.declarationNumber, 13),
      '  ', // Ni complementaria ni sustitutiva.
      numeric(0, 13),
      numeric(donorCount, 9),
      numeric(totalCents, 15),
      '1', // Entidad acogida al Título III de la Ley 49/2002.
      ' '.repeat(77),
      ' '.repeat(13)
    ].join('')
  );
}

export function buildDonorRecord(declarant: Model182Declarant, donor: Model182Donor): string {
  const nature = declaredNature(donor.taxId, donor.kind);
  const recurrent = isRecurrentDonor(donor.previousYearsCents);
  return assertRecord(
    [
      '2',
      '182',
      numeric(declarant.fiscalYear, 4),
      taxIdField(declarant.taxId),
      taxIdField(donor.taxId),
      ' '.repeat(9), // Sin representante legal.
      text(donor.fullName, 40),
      numeric(donor.provinceCode, 2),
      'A', // Donativo no incluido en actividades prioritarias de mecenazgo.
      numeric(deductionPercent(nature, donor.amountCents, recurrent), 5),
      numeric(donor.amountCents, 13),
      ' ', // Dinerario.
      numeric(0, 2),
      numeric(0, 5),
      nature,
      ' ', // Sin revocación.
      numeric(0, 4),
      ' ',
      ' '.repeat(20),
      recurrent ? '1' : '2',
      ' '.repeat(9),
      ' '.repeat(40),
      ' '.repeat(69)
    ].join('')
  );
}

export interface Model182File {
  /** Texto con los registros separados por CRLF. */
  content: string;
  /** Lo que se presenta: ISO-8859-1, donde la Ñ y la Ç ocupan un byte y cada registro mide exactamente 250. */
  bytes: Buffer;
  donorCount: number;
  totalCents: number;
}

export function buildModel182File(declarant: Model182Declarant, donors: readonly Model182Donor[]): Model182File {
  if (!Number.isSafeInteger(declarant.fiscalYear) || declarant.fiscalYear < FIRST_SUPPORTED_YEAR) throw new Model182FormatError(`Ejercicio ${declarant.fiscalYear} no admitido.`);
  if (!/^182\d{10}$/.test(declarant.declarationNumber)) throw new Model182FormatError('El número de justificante debe tener 13 cifras y empezar por 182.');
  if (!/^\d{9}$/.test(declarant.contactPhone)) throw new Model182FormatError('El teléfono de contacto debe tener 9 cifras.');
  const declarantId = validateTaxId(declarant.taxId);
  if (!declarantId.valid) throw new Model182FormatError('El NIF de la entidad declarante no es válido.');
  const normalized = { ...declarant, taxId: declarantId.normalized };

  let totalCents = 0;
  for (const donor of donors) {
    if (!Number.isSafeInteger(donor.amountCents) || donor.amountCents <= 0) throw new Model182FormatError('Un donante tiene un importe no válido.');
    if (!PROVINCE_CODES.has(donor.provinceCode)) throw new Model182FormatError('Un donante tiene un código de provincia no válido.');
    totalCents += donor.amountCents;
  }
  const records = [buildDeclarantRecord(normalized, donors.length, totalCents), ...donors.map((donor) => buildDonorRecord(normalized, donor))];
  const content = `${records.join('\r\n')}\r\n`;
  return { content, bytes: Buffer.from(content, 'latin1'), donorCount: donors.length, totalCents };
}
