import { getTranslations } from 'next-intl/server';
import { StatusBadge } from '@/components/ui/status-badge';
import { templatesFor } from '@/core/studio/campaign-templates';
import type { StudioVertical } from '@/core/studio/studio-draft';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { TemplateArt } from './template-illustration';

/**
 * Punto de entrada del Estudio (`studio-select-initiative` del prototipo, «+ Nueva iniciativa» y «+ Nueva taquilla / rifa»): las campañas que ya tiene la
 * entidad, dos botones para empezar en blanco y las plantillas listas para usar. Una plantilla solo rellena textos y, en taquilla, un precio y un aforo de
 * partida: el presupuesto de un proveedor lo escribe siempre la entidad.
 */

type Status = Parameters<typeof StatusBadge>[0]['status'];

export interface StudioPickerProps {
  locale: Locale;
  orgSlug: string;
  vertical: StudioVertical;
  canCreate: boolean;
  initiatives: Array<{ id: number; walletEscrowId: string; title: string; format: 'BUDGET' | 'TICKETING'; status: string }>;
  maxDrafts: number;
}

export async function StudioPicker({ locale, orgSlug, vertical, canCreate, initiatives, maxDrafts }: StudioPickerProps) {
  const t = await getTranslations({ locale, namespace: 'panel.studio' });
  const base = `/panel/${orgSlug}/estudio`;
  const templates = templatesFor(vertical);

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="studio-new" className="flex flex-col gap-3">
        <h2 id="studio-new" className="font-corp text-xl font-extrabold text-varsity-navy">
          {t('picker.newTitle')}
        </h2>
        {canCreate ? (
          <div className="flex flex-wrap gap-3">
            <Link href={`${base}?nueva=presupuesto`} className="tactile-btn" data-testid="studio-new-budget">
              <span aria-hidden="true">{'🏗️ '}</span>
              {t('picker.newBudget')}
            </Link>
            <Link href={`${base}?nueva=taquilla`} className="tactile-btn" data-testid="studio-new-ticketing">
              <span aria-hidden="true">{'🎟️ '}</span>
              {t('picker.newTicketing')}
            </Link>
          </div>
        ) : (
          <p role="status" className="rounded-xl border-2 border-amber-400 bg-amber-50 p-3 text-sm font-semibold text-amber-950">
            {t('picker.tooManyDrafts', { max: maxDrafts })}
          </p>
        )}
      </section>

      <section aria-labelledby="studio-templates" className="flex flex-col gap-3">
        <div>
          <h2 id="studio-templates" className="font-corp text-xl font-extrabold text-varsity-navy">
            {t('picker.templatesTitle')}
          </h2>
          <p className="text-sm text-ink-soft">{t('picker.templatesHint')}</p>
        </div>
        <ul className="mobile-stack grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {templates.map((template) => (
            <li key={template.key} className="korum-notebook-sheet flex flex-col gap-2 p-3" data-testid={`studio-template-${template.key}`}>
              <TemplateArt kind={template.illustration} className="h-auto max-h-32 w-full" />
              <p className="font-joy text-lg font-bold text-varsity-navy">{t(`templates.${template.key}.name`)}</p>
              <p className="flex-1 text-sm text-ink-soft">{t(`templates.${template.key}.summary`)}</p>
              {canCreate ? (
                <Link href={`${base}?nueva=${template.format === 'TICKETING' ? 'taquilla' : 'presupuesto'}&plantilla=${template.key}`} className="inline-flex min-h-11 items-center font-bold text-varsity-navy underline underline-offset-4">
                  {t('picker.useTemplate')}
                  <span className="sr-only">{` ${t(`templates.${template.key}.name`)}`}</span>
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="studio-existing" className="flex flex-col gap-3">
        <h2 id="studio-existing" className="font-corp text-xl font-extrabold text-varsity-navy">
          {t('picker.existingTitle')}
        </h2>
        {initiatives.length === 0 ? (
          <p className="rounded-xl bg-white p-4 text-ink-soft">{t('picker.existingEmpty')}</p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="studio-existing">
            {initiatives.map((item) => (
              <li key={item.id} className="korum-trust-vault flex flex-wrap items-center justify-between gap-3 p-3">
                <div className="flex min-w-0 flex-col">
                  <span className="font-corp font-extrabold text-varsity-navy wrap-anywhere">{item.title}</span>
                  <span className="text-xs text-ink-soft">{`${item.walletEscrowId} · ${t(`format.${item.format}`)}`}</span>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <StatusBadge status={item.status as Status} />
                  <Link href={`${base}?iniciativa=${item.id}`} className="inline-flex min-h-11 items-center font-bold text-varsity-navy underline underline-offset-4">
                    {t(item.status === 'BUDGETING' ? 'picker.edit' : 'picker.open')}
                    <span className="sr-only">{` ${item.title}`}</span>
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
