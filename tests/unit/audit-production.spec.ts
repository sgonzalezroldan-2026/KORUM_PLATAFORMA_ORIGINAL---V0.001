import { describe, expect, it } from 'vitest';

import exceptionsFile from '../../scripts/audit-exceptions.json';
import {
  auditPasses,
  collectAdvisories,
  evaluateAudit,
  exceptionsSchema,
  type AuditException
} from '../../scripts/audit-production-core';

const PICOMATCH = {
  source: 1247710,
  name: 'picomatch',
  dependency: 'picomatch',
  title: 'picomatch vulnerable to ReDoS through single-branch repeated extglobs',
  url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
  severity: 'high',
  range: '<=4.0.7'
};

const OTHER = {
  source: 1,
  name: 'otra-libreria',
  dependency: 'otra-libreria',
  title: 'Ejecución de código',
  url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
  severity: 'critical',
  range: '<2.0.0'
};

const MODERATE = { ...OTHER, name: 'leve', url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff', severity: 'moderate' };

function report(...advisories: object[]) {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      picomatch: { severity: 'high', via: advisories },
      // Un paquete que solo arrastra a otro lleva nombres, no avisos: no cuenta dos veces.
      vite: { severity: 'high', via: ['picomatch', 'tinyglobby'] }
    }
  };
}

const EXCEPTION: AuditException = {
  id: 'GHSA-fc5q-39xc-vjpf',
  package: 'picomatch',
  reason: 'Sin versión corregida; solo se usa al compilar y en las pruebas.',
  reviewBy: '2026-12-18'
};

describe('comprobación de vulnerabilidades de producción', () => {
  it('recoge solo los avisos altos o críticos, una vez cada uno', () => {
    const advisories = collectAdvisories(report(PICOMATCH, PICOMATCH, MODERATE, OTHER));
    expect(advisories.map((a) => `${a.id}:${a.packageName}`)).toEqual([
      'GHSA-aaaa-bbbb-cccc:otra-libreria',
      'GHSA-fc5q-39xc-vjpf:picomatch'
    ]);
  });

  it('sin avisos, pasa', () => {
    const verdict = evaluateAudit(collectAdvisories({ vulnerabilities: {} }), [], '2026-11-18');
    expect(auditPasses(verdict)).toBe(true);
  });

  it('un aviso alto sin excepción bloquea', () => {
    const verdict = evaluateAudit(collectAdvisories(report(PICOMATCH)), [], '2026-11-18');
    expect(verdict.blocking).toHaveLength(1);
    expect(auditPasses(verdict)).toBe(false);
  });

  it('una excepción vigente deja pasar su aviso, también el último día', () => {
    for (const today of ['2026-11-18', '2026-12-18']) {
      const verdict = evaluateAudit(collectAdvisories(report(PICOMATCH)), [EXCEPTION], today);
      expect(verdict.excepted).toHaveLength(1);
      expect(auditPasses(verdict)).toBe(true);
    }
  });

  it('una excepción caducada vuelve a bloquear', () => {
    const verdict = evaluateAudit(collectAdvisories(report(PICOMATCH)), [EXCEPTION], '2026-12-19');
    expect(verdict.expired).toHaveLength(1);
    expect(auditPasses(verdict)).toBe(false);
  });

  it('la excepción de un aviso no tapa otro aviso ni otro paquete', () => {
    const otherPackage = { ...PICOMATCH, name: 'micromatch' };
    const verdict = evaluateAudit(collectAdvisories(report(PICOMATCH, OTHER, otherPackage)), [EXCEPTION], '2026-11-18');
    expect(verdict.blocking.map((a) => a.packageName).sort()).toEqual(['micromatch', 'otra-libreria']);
    expect(auditPasses(verdict)).toBe(false);
  });

  it('avisa de las excepciones que ya no hacen falta', () => {
    const verdict = evaluateAudit(collectAdvisories({ vulnerabilities: {} }), [EXCEPTION], '2026-11-18');
    expect(verdict.unused).toEqual([EXCEPTION]);
    expect(auditPasses(verdict)).toBe(true);
  });

  it('rechaza un informe que no es el de `npm audit`', () => {
    expect(() => collectAdvisories({ error: { code: 'ENOTFOUND' } })).toThrow();
  });

  it('el fichero de excepciones es válido y cada una lleva motivo y fecha de revisión', () => {
    const exceptions = exceptionsSchema.parse(exceptionsFile);
    for (const exception of exceptions) {
      expect(exception.reason.length).toBeGreaterThan(40);
      expect(Number.isNaN(Date.parse(exception.reviewBy))).toBe(false);
    }
  });
});
