import { describe, expect, it } from 'vitest';
import { ACCOUNT_RULES, isDebitNormal, naturalBalance, type JournalLine, type PostJournalInput } from '@/core/finance/ledger-accounts';
import { canonicalLines, LedgerValidationError, sumByDirection, validateJournal } from '@/core/finance/ledger-validation';

const ORG = 'org-cervantes';
const INITIATIVE = 101;

function journal(lines: JournalLine[], overrides: Partial<PostJournalInput> = {}): PostJournalInput {
  return { idempotencyKey: 'paycomet:payin:ORD-1', kind: 'PAYIN_DONATION', description: 'Donación', lines, ...overrides };
}

const DONATION: JournalLine[] = [
  { account: 'PSP_CLEARING', direction: 'DEBIT', amountCents: 2_680 },
  { account: 'INITIATIVE_ESCROW', direction: 'CREDIT', amountCents: 2_500, organizationId: ORG, initiativeId: INITIATIVE },
  { account: 'KORUM_REVENUE_GUARANTEE', direction: 'CREDIT', amountCents: 180 }
];

function problemsOf(input: PostJournalInput): string[] {
  try {
    validateJournal(input);
    return [];
  } catch (error) {
    if (error instanceof LedgerValidationError) return error.problems;
    throw error;
  }
}

describe('validateJournal · reglas de la partida doble', () => {
  it('acepta los asientos tipo de la skill de pagos', () => {
    expect(problemsOf(journal(DONATION))).toEqual([]);
    expect(
      problemsOf(
        journal(
          [
            { account: 'PSP_CLEARING', direction: 'DEBIT', amountCents: 29_538 },
            { account: 'INITIATIVE_ESCROW', direction: 'CREDIT', amountCents: 25_000, organizationId: ORG, initiativeId: INITIATIVE },
            { account: 'KORUM_REVENUE_SPONSOR_FEE', direction: 'CREDIT', amountCents: 3_750 },
            { account: 'TAX_PAYABLE_VAT', direction: 'CREDIT', amountCents: 788 }
          ],
          { kind: 'PAYIN_SPONSOR' }
        )
      )
    ).toEqual([]);
  });

  it('rechaza un asiento que no cuadra e indica las dos sumas', () => {
    const lines = DONATION.map((line, index) => (index === 1 ? { ...line, amountCents: 2_499 } : line));
    expect(problemsOf(journal(lines))).toEqual(['no cuadra: debe 2680 ≠ haber 2679']);
  });

  it('exige al menos 2 apuntes y apuntes al debe y al haber', () => {
    expect(problemsOf(journal([DONATION[0]!]))).toEqual(
      expect.arrayContaining(['un asiento necesita al menos 2 apuntes', 'un asiento necesita apuntes al debe y al haber'])
    );
    const onlyDebits: JournalLine[] = [
      { account: 'PSP_CLEARING', direction: 'DEBIT', amountCents: 100 },
      { account: 'GATEWAY_FEES_EXPENSE', direction: 'DEBIT', amountCents: 100 }
    ];
    expect(problemsOf(journal(onlyDebits))).toContain('un asiento necesita apuntes al debe y al haber');
  });

  it('exige importes enteros, seguros y mayores que cero', () => {
    for (const amountCents of [0, -100, 12.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      const lines: JournalLine[] = [
        { account: 'GATEWAY_FEES_EXPENSE', direction: 'DEBIT', amountCents },
        { account: 'PSP_CLEARING', direction: 'CREDIT', amountCents }
      ];
      expect(problemsOf(journal(lines)).some((problem) => problem.includes('entero de céntimos mayor que 0')), String(amountCents)).toBe(true);
    }
  });

  it('exige las dimensiones de cada cuenta (hucha por iniciativa, monedero por familia, bolsa por comercio)', () => {
    const missing = (account: JournalLine['account']) =>
      problemsOf(
        journal([
          { account: 'PSP_CLEARING', direction: 'DEBIT', amountCents: 100 },
          { account, direction: 'CREDIT', amountCents: 100 }
        ])
      );
    expect(missing('INITIATIVE_ESCROW')).toEqual([
      'apunte 2 (INITIATIVE_ESCROW): falta la dimensión obligatoria organizationId',
      'apunte 2 (INITIATIVE_ESCROW): falta la dimensión obligatoria initiativeId'
    ]);
    expect(missing('FAMILY_WALLET')).toEqual(['apunte 2 (FAMILY_WALLET): falta la dimensión obligatoria userId']);
    expect(missing('SPONSOR_CREDIT_POOL')).toHaveLength(2);
    expect(missing('MATCHING_POOL')).toHaveLength(2);
    expect(missing('ORG_PAYABLE')).toEqual(['apunte 2 (ORG_PAYABLE): falta la dimensión obligatoria organizationId']);
    expect(missing('KORUM_REVENUE_BRACKET')).toEqual([]);
  });

  it('exige clave de idempotencia sin espacios y descripción, y no admite contra-asientos', () => {
    expect(problemsOf(journal(DONATION, { idempotencyKey: '' }))).toContain('falta la clave de idempotencia');
    expect(problemsOf(journal(DONATION, { idempotencyKey: ' ORD-1' }))).toContain('la clave de idempotencia no puede tener espacios al principio o al final');
    expect(problemsOf(journal(DONATION, { idempotencyKey: 'x'.repeat(201) }))).toContain('la clave de idempotencia supera 200 caracteres');
    expect(problemsOf(journal(DONATION, { description: '  ' }))).toContain('falta la descripción');
    expect(problemsOf(journal(DONATION, { kind: 'REVERSAL' }))).toContain('los contra-asientos se crean con reverseJournal(), no con postJournal()');
  });

  it('ningún apunte puede llevar el dinero a una entidad distinta de la del asiento', () => {
    const lines = DONATION.map((line, index) => (index === 1 ? { ...line, organizationId: 'org-otra' } : line));
    expect(problemsOf(journal(lines, { organizationId: ORG }))).toEqual(['apunte 2 (INITIATIVE_ESCROW): la entidad org-otra no es la del asiento (org-cervantes)']);
    expect(problemsOf(journal(DONATION, { organizationId: ORG }))).toEqual([]);
  });

  it('informa de todos los problemas a la vez', () => {
    const problems = problemsOf(journal([{ account: 'INITIATIVE_ESCROW', direction: 'CREDIT', amountCents: 0 }], { idempotencyKey: '', description: '' }));
    expect(problems.length).toBeGreaterThanOrEqual(5);
  });
});

describe('sumas, saldos y forma canónica', () => {
  it('suma con BigInt sin desbordar aunque haya importes enormes', () => {
    const big = Number.MAX_SAFE_INTEGER;
    const totals = sumByDirection([
      { direction: 'DEBIT', amountCents: big },
      { direction: 'DEBIT', amountCents: big },
      { direction: 'CREDIT', amountCents: big }
    ]);
    expect(totals.DEBIT).toBe(BigInt(big) * 2n);
    expect(totals.CREDIT).toBe(BigInt(big));
  });

  it('activo y gasto crecen al debe; pasivo e ingreso, al haber', () => {
    expect(isDebitNormal('PSP_CLEARING')).toBe(true);
    expect(isDebitNormal('GATEWAY_FEES_EXPENSE')).toBe(true);
    expect(isDebitNormal('INITIATIVE_ESCROW')).toBe(false);
    expect(isDebitNormal('KORUM_REVENUE_BRACKET')).toBe(false);
    expect(naturalBalance('PSP_CLEARING', 2_680, 36)).toBe(2_644);
    expect(naturalBalance('INITIATIVE_ESCROW', 0, 2_500)).toBe(2_500);
  });

  it('cada cuenta del esquema tiene naturaleza definida', () => {
    for (const rule of Object.values(ACCOUNT_RULES)) expect(['ASSET', 'LIABILITY', 'REVENUE', 'EXPENSE']).toContain(rule.nature);
    expect(Object.keys(ACCOUNT_RULES)).toHaveLength(19);
  });

  it('la forma canónica no depende del orden de los apuntes', () => {
    expect(canonicalLines([...DONATION].reverse())).toEqual(canonicalLines(DONATION));
    expect(canonicalLines(DONATION.map((line, index) => (index === 0 ? { ...line, amountCents: 2_681 } : line)))).not.toEqual(canonicalLines(DONATION));
  });
});
