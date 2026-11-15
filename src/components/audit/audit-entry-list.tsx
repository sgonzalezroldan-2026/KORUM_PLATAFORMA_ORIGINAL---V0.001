import { getFormatter, getTranslations } from 'next-intl/server';
import { auditTargetKeyOf, ENTITY_PROBE_ACTION, isKnownAuditAction } from '@/core/audit/audit-catalog';
import { Link } from '@/i18n/navigation';
import type { AuditActorView, AuditRowView } from '@/services/audit/audit-viewer.service';

/**
 * Lista de registros de la auditoría (Sprint 5.8a), la misma pieza para la consola y para el panel de la entidad: lo que cambia es lo que trae cada fila
 * (`audit-viewer.service.ts` ya ha quitado lo que la entidad no debe ver). Cada registro dice qué pasó en lenguaje llano, quién, sobre qué (con el nombre de la
 * campaña, del comercio o de la idea, no solo su número), cuándo (hora de España) y desde dónde. Es una lista y no una tabla: en el móvil se lee en una sola
 * columna, sin desplazamiento lateral. Componente de servidor (asíncrono: lee los textos con la API de servidor, así que no puede acabar montado en el
 * navegador ni necesita que sus secciones viajen a él).
 */

const WHEN = { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Europe/Madrid' } as const;

export async function AuditEntryList({ rows, variant }: { rows: AuditRowView[]; variant: 'console' | 'entity' }) {
  const [t, actions, statuses, roles, format] = await Promise.all([
    getTranslations('audit'),
    getTranslations('audit.actions'),
    getTranslations('status.initiative'),
    getTranslations('panel.approvals.doubleCheck.roles'),
    getFormatter()
  ]);

  const actorText = (actor: AuditActorView): string => {
    switch (actor.kind) {
      case 'korum':
        return actor.email ? t('actor.korumNamed', { name: actor.name ?? actor.email, email: actor.email }) : t('actor.korum');
      case 'member':
        return t('actor.member', { name: actor.name, role: actor.roleLabel ?? roles(actor.role as never) });
      case 'person':
        return actor.name && actor.email ? t('actor.person', { name: actor.name, email: actor.email }) : actor.email ? t('actor.personNoName', { email: actor.email }) : t('actor.other');
      default:
        return t(`actor.${actor.kind}`);
    }
  };

  const titleOf = (row: AuditRowView): string => {
    // En el panel, pedir algo que no existe y pedir algo de otra entidad se cuentan igual.
    if (variant === 'entity' && row.action === ENTITY_PROBE_ACTION) return t('entity.probe');
    return isKnownAuditAction(row.action) ? actions(row.action as never) : t('list.unknownAction', { code: row.action });
  };

  const targetText = (target: AuditRowView['target']): string => {
    const key = auditTargetKeyOf(target.type);
    const type = key ? t(`targets.${key}`) : target.type;
    if (!target.id) return type;
    return target.name ? t('list.targetWithName', { type, id: target.id, name: target.name }) : t('list.targetWithId', { type, id: target.id });
  };

  /** «Desde dónde». En el panel, `null` cuando no hay nada que decir (de quien no firma por la entidad no se enseña el dispositivo): el bloque no se pinta. */
  const originText = (row: AuditRowView): string | null => {
    if (row.actor.kind === 'system' || row.actor.kind === 'webhook') return t('list.originAutomatic');
    const parts = [row.device ? t('list.device', { device: row.device }) : null, row.network ? t('list.network', { network: row.network }) : null].filter((part): part is string => part !== null);
    if (parts.length > 0) return parts.join(' · ');
    return variant === 'entity' ? null : t('list.originUnknown');
  };

  return (
    <ol className="flex flex-col gap-3" data-testid="audit-rows">
      {rows.map((row) => {
        const when = `${format.dateTime(row.occurredAt, WHEN)} · ${t(`categories.${row.category ?? 'unclassified'}`)}`;
        const origin = originText(row);
        return (
          <li key={row.id} className="korum-trust-vault flex flex-col gap-2 p-4" data-testid="audit-row" data-action={row.action}>
            <p className="text-sm font-semibold text-ink-soft">
              <time dateTime={row.occurredAt.toISOString()}>{when}</time>
            </p>
            <h3 className="font-corp text-lg font-extrabold text-varsity-navy">{titleOf(row)}</h3>
            {row.statusChange ? (
              <p className="font-semibold text-varsity-navy" data-testid="audit-status-change">
                {[
                  t('list.statusChange', { from: statuses(row.statusChange.from), to: statuses(row.statusChange.to) }),
                  row.statusChange.reason ? t('list.statusReason', { reason: t(`reasons.${row.statusChange.reason}`) }) : null
                ]
                  .filter((part): part is string => part !== null)
                  .join(' · ')}
              </p>
            ) : null}
            <dl className="mobile-stack grid gap-x-6 gap-y-2 text-sm md:grid-cols-2">
              <div>
                <dt className="font-semibold text-ink-soft">{t('list.who')}</dt>
                <dd className="wrap-break-word text-varsity-navy" data-testid="audit-actor">
                  {actorText(row.actor)}
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-ink-soft">{t('list.about')}</dt>
                <dd className="wrap-break-word text-varsity-navy" data-testid="audit-target">
                  {targetText(row.target)}
                </dd>
              </div>
              {variant === 'console' && row.organization ? (
                <div>
                  <dt className="font-semibold text-ink-soft">{t('list.organization')}</dt>
                  <dd className="wrap-break-word">
                    <Link href={`/admin/entidades/${row.organization.id}`} className="inline-flex min-h-11 items-center font-semibold text-varsity-navy underline">
                      {row.organization.name}
                    </Link>
                  </dd>
                </div>
              ) : null}
              {origin !== null ? (
                <div>
                  <dt className="font-semibold text-ink-soft">{t('list.from')}</dt>
                  <dd className="wrap-break-word text-varsity-navy" data-testid="audit-origin">
                    {origin}
                  </dd>
                </div>
              ) : null}
            </dl>
            {variant === 'console' ? (
              <details className="text-sm">
                <summary className="inline-flex min-h-11 cursor-pointer items-center font-semibold text-varsity-navy underline">{t('list.details')}</summary>
                <div className="mt-2 flex flex-col gap-1 rounded-lg bg-varsity-ivory p-3" data-testid="audit-details">
                  <p className="break-all text-ink-soft">{t('list.code', { code: row.action })}</p>
                  {row.details.length > 0 ? (
                    <dl className="flex flex-col gap-1">
                      {row.details.map((detail) => (
                        <div key={detail.key} className="flex flex-wrap gap-x-2">
                          <dt className="font-semibold text-ink-soft">{detail.key}</dt>
                          <dd className="break-all text-varsity-navy">{detail.value}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                </div>
              </details>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
