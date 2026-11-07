'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ShareModal, type ShareTarget } from '@/components/portal/share-modal';
import { Link } from '@/i18n/navigation';
import { BeforeAfter } from './before-after';

export interface AchievementCardData {
  id: number;
  title: string;
  description: string;
  thanksMessage: string | null;
  /** Importe ya formateado según el idioma. */
  raised: string;
  beforeSrc: string | null;
  afterSrc: string | null;
  /** Ruta de la ficha de la iniciativa, sin idioma. */
  href: string;
  /** URL absoluta de la ficha, para compartir. */
  url: string;
  /** Idioma real del texto de la iniciativa, si no es el de la página. */
  lang?: string;
}

/**
 * Logros conseguidos (`function renderFamilyAchievements` del prototipo, QA-F09): para cada mejora terminada, el comparador Antes / Después, el
 * agradecimiento del centro y «Compartir logro» (WhatsApp, email, copiar). El importe es el total que sumó la comunidad, nunca el de una persona.
 */
export function AchievementGrid({ items, entityName }: { items: AchievementCardData[]; entityName: string }) {
  const t = useTranslations('portal.achievements');
  const [target, setTarget] = useState<ShareTarget | null>(null);

  return (
    <>
      <ul className="mobile-stack grid gap-6 md:grid-cols-2" aria-label={t('listLabel')}>
        {items.map((item) => (
          <li key={item.id} className="flex">
            <article id={`logro-${item.id}`} data-testid="achievement-card" className="flex w-full flex-col gap-4 rounded-3xl border border-patio-rule bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-extrabold text-emerald-900">
                  <span aria-hidden="true">{'🎉 '}</span>
                  {t('raised', { amount: item.raised })}
                </p>
                <button
                  type="button"
                  onClick={() => setTarget({ title: item.title, entityName, url: item.url, groups: [], message: t('shareMessage', { title: item.title, entity: entityName }) })}
                  className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-bold text-varsity-navy underline underline-offset-4 hover:bg-patio-rule"
                >
                  <span aria-hidden="true">{'📤 '}</span>
                  {t('share')}
                </button>
              </div>
              <h2 lang={item.lang} className="font-joy text-xl font-bold text-varsity-navy wrap-anywhere">
                {item.title}
              </h2>
              <p lang={item.lang} className="text-sm text-ink-soft wrap-anywhere">
                {item.description}
              </p>
              {item.thanksMessage ? (
                <p lang={item.lang} className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm italic text-emerald-950 wrap-anywhere">
                  <span aria-hidden="true">{'💬 '}</span>
                  <strong className="not-italic">{t('thanksFrom')}</strong>
                  {` «${item.thanksMessage}»`}
                </p>
              ) : null}
              <BeforeAfter title={item.title} beforeSrc={item.beforeSrc} afterSrc={item.afterSrc} />
              <Link href={item.href} className="mt-auto inline-flex min-h-11 items-center font-bold text-varsity-navy underline underline-offset-4">
                {t('viewInitiative')}
              </Link>
            </article>
          </li>
        ))}
      </ul>
      <ShareModal target={target} onClose={() => setTarget(null)} />
    </>
  );
}
