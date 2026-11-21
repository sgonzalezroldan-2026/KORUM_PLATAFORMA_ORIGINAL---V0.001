import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { kybRetainUntil } from '@/core/panel/entity-settings-rules';
import { fiscalCutoff, fiscalRetainUntil, lastExpiredFiscalYear, RETENTION } from '@/core/privacy/retention-policy';
import { AUDIT_PERSON_KEYS } from '@/core/privacy/retention-unlink';

/** Sprint 5.10b: todos los plazos de la tabla de plazos (`docs/legal/tabla-de-plazos.md`) viven en `retention-policy.ts` y en ningún otro sitio. */

describe('tabla de plazos en el código', () => {
  it('los plazos nuevos del 5.10b son los de la tabla validada por el promotor', () => {
    expect(RETENTION).toMatchObject({
      unverifiedSignupDays: 7,
      securityTraceDays: 365,
      operationsDaysAfterClosed: 365,
      privacyRequestDaysAfterClosed: 3 * 365,
      ideaDescriptionDaysAfterIdea: 365,
      ideaChatDaysAfterIdea: 365,
      sessionDays: 30,
      rejectedWebhookDays: 90,
      unattachedInvoiceDays: 30,
      signatureChallengeDays: 7,
      ownerDocumentYears: 6,
      fiscalYears: 6
    });
  });

  it('«6 años desde el cierre del ejercicio» se cuenta por años naturales: un dato de 2026 se conserva hasta el 1 de enero de 2033', () => {
    expect(fiscalRetainUntil(new Date('2026-11-21T10:00:00Z')).toISOString()).toBe('2033-01-01T00:00:00.000Z');
    expect(fiscalRetainUntil(new Date('2026-01-01T00:00:00Z')).toISOString()).toBe('2033-01-01T00:00:00.000Z');
    // Lo mismo que aplica la purga: en 2033, lo anterior a 2027 ha vencido.
    expect(lastExpiredFiscalYear(new Date('2033-01-02T00:00:00Z'))).toBe(2026);
    expect(fiscalCutoff(new Date('2033-01-02T00:00:00Z'), 6).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    // La documentación del titular sigue en «mientras dure la relación y 6 años»: 6 años justos desde que deja de ser la vigente.
    expect(kybRetainUntil(new Date('2026-11-09T08:00:00Z')).toISOString()).toBe('2032-11-09T08:00:00.000Z');
  });

  it('toda clave de los detalles de la auditoría que guarda una cuenta se puede quitar al vencer su plazo (y la guarda de la base admite las mismas)', () => {
    const keys = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'generated') walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        const text = fs.readFileSync(full, 'utf8');
        // Detalles de una anotación: `metadata: { … }` o `metadataJson: { … }`; las claves que terminan en `UserId` (o `by`) guardan una cuenta.
        for (const block of text.matchAll(/metadata(?:Json)?:\s*\{([^}]*)\}/g)) for (const key of block[1]!.matchAll(/\b(\w*UserId|by)\s*:/g)) keys.add(key[1]!);
      }
    };
    walk(path.join(process.cwd(), 'src'));
    expect([...keys].filter((key) => !(AUDIT_PERSON_KEYS as readonly string[]).includes(key))).toEqual([]);
    const migration = fs.readFileSync(path.join(process.cwd(), 'prisma', 'migrations', '20261203090000_account_rights', 'migration.sql'), 'utf8');
    const listed = /v_person_keys text\[\] := ARRAY\[([^\]]*)\]/.exec(migration)![1]!.match(/'(\w+)'/g)!.map((key) => key.slice(1, -1));
    expect(listed.sort()).toEqual([...AUDIT_PERSON_KEYS].sort());
  });

  it('ningún otro módulo declara su propio plazo de conservación', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'generated') walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name) || full.endsWith(path.join('privacy', 'retention-policy.ts'))) continue;
        const text = fs.readFileSync(full, 'utf8');
        // Los que había fuera antes del 5.10b: documentación del titular, factura sin adjuntar, avisos rechazados, códigos de firma y duración de la sesión.
        if (/(RETENTION_(DAYS|YEARS)|GRACE_DAYS|UNATTACHED_INVOICE_DAYS)\s*=\s*\d/.test(text) || /session:\s*\{\s*expiresIn:\s*\d/.test(text)) offenders.push(path.relative(process.cwd(), full));
      }
    };
    walk(path.join(process.cwd(), 'src'));
    expect(offenders).toEqual([]);
  });
});
