'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ShareModal, type ShareTarget } from './share-modal';

/** Botón «Compartir» de la ficha, con su propio diálogo. En el listado, un único diálogo atiende a todas las tarjetas. */
export function ShareButton({ target }: { target: ShareTarget }) {
  const t = useTranslations('portal.detail');
  const [current, setCurrent] = useState<ShareTarget | null>(null);

  return (
    <>
      <button type="button" onClick={() => setCurrent(target)} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-sky-700 px-4 font-extrabold text-white hover:bg-sky-800">
        <span aria-hidden="true">{'📤'}</span>
        {t('share')}
      </button>
      <ShareModal target={current} onClose={() => setCurrent(null)} />
    </>
  );
}
