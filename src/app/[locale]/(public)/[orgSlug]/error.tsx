'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import { EmptyState } from '@/components/ui/empty-state';

/** Error del portal: lenguaje llano y botón de reintentar, con la referencia para soporte; nunca el error técnico. */
export default function PortalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations('portal.error');
  const common = useTranslations('common');
  const errorT = useTranslations('error');
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    console.error(error);
    heading.current?.focus();
  }, [error]);

  return (
    <EmptyState
      icon="🛠️"
      title={t('title')}
      description={error.digest ? `${t('description')} ${errorT('reference', { reference: error.digest })}` : t('description')}
      headingLevel={1}
      role="alert"
      headingRef={heading}
      action={
        <button type="button" onClick={reset} className="tactile-btn">
          {common('retry')}
        </button>
      }
    />
  );
}
