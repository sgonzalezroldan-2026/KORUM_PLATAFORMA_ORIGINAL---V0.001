/**
 * Comprobación de vulnerabilidades de las dependencias de producción (paso del CI).
 *
 * `npm audit --omit=dev --audit-level=high` no admite excepciones: un aviso sin versión corregida deja el CI en rojo
 * sin que se pueda hacer nada. Esta comprobación hace lo mismo, pero deja pasar los avisos de una lista corta y
 * escrita (`audit-exceptions.json`), cada uno con su motivo y una **fecha de revisión**: pasada esa fecha, la
 * excepción deja de valer y el CI vuelve a fallar. Cualquier otro aviso alto o crítico falla como siempre.
 */
import { z } from 'zod';

const BLOCKING_SEVERITIES = new Set(['high', 'critical']);

const advisorySchema = z.object({
  name: z.string(),
  title: z.string().default(''),
  url: z.string(),
  severity: z.string()
});

const reportSchema = z.object({
  vulnerabilities: z.record(z.string(), z.object({ via: z.array(z.unknown()) }))
});

export const exceptionsSchema = z.array(
  z.object({
    id: z.string().regex(/^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/),
    package: z.string().min(1),
    reason: z.string().min(20),
    reviewBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  })
);

export type AuditException = z.infer<typeof exceptionsSchema>[number];

export interface Advisory {
  id: string;
  packageName: string;
  severity: string;
  title: string;
  url: string;
}

export interface AuditVerdict {
  /** Avisos altos o críticos sin excepción vigente: hacen fallar el CI. */
  blocking: Advisory[];
  /** Avisos cubiertos por una excepción que sigue en plazo. */
  excepted: { advisory: Advisory; exception: AuditException }[];
  /** Avisos con una excepción cuya fecha de revisión ya pasó: también hacen fallar el CI. */
  expired: { advisory: Advisory; exception: AuditException }[];
  /** Excepciones que ya no hacen falta (el aviso no aparece): se pueden borrar. */
  unused: AuditException[];
}

/** Saca del informe de `npm audit --json` los avisos altos o críticos, uno por aviso y paquete. */
export function collectAdvisories(report: unknown): Advisory[] {
  const parsed = reportSchema.parse(report);
  const found = new Map<string, Advisory>();
  for (const entry of Object.values(parsed.vulnerabilities)) {
    for (const via of entry.via) {
      const advisory = advisorySchema.safeParse(via);
      if (!advisory.success) continue;
      if (!BLOCKING_SEVERITIES.has(advisory.data.severity)) continue;
      const id = advisory.data.url.split('/').pop() ?? advisory.data.url;
      found.set(`${id}:${advisory.data.name}`, {
        id,
        packageName: advisory.data.name,
        severity: advisory.data.severity,
        title: advisory.data.title,
        url: advisory.data.url
      });
    }
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id) || a.packageName.localeCompare(b.packageName));
}

/** Decide qué avisos bloquean. `today` va en formato `AAAA-MM-DD`; una excepción vale hasta su fecha, incluida. */
export function evaluateAudit(advisories: Advisory[], exceptions: AuditException[], today: string): AuditVerdict {
  const verdict: AuditVerdict = { blocking: [], excepted: [], expired: [], unused: [] };
  const used = new Set<AuditException>();
  for (const advisory of advisories) {
    const exception = exceptions.find((e) => e.id === advisory.id && e.package === advisory.packageName);
    if (!exception) {
      verdict.blocking.push(advisory);
      continue;
    }
    used.add(exception);
    if (today > exception.reviewBy) verdict.expired.push({ advisory, exception });
    else verdict.excepted.push({ advisory, exception });
  }
  verdict.unused = exceptions.filter((e) => !used.has(e));
  return verdict;
}

export function auditPasses(verdict: AuditVerdict): boolean {
  return verdict.blocking.length === 0 && verdict.expired.length === 0;
}
