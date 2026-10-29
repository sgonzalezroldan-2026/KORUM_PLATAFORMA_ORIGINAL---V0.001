'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import { EmptyState } from '@/components/ui/empty-state';

/** Error: explicación en lenguaje llano, botón para reintentar y referencia para soporte; nunca el error técnico. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations('error');
  const common = useTranslations('common');
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    console.error(error);
    // Mueve el foco al titular para que teclado y lectores de pantalla perciban el cambio.
    heading.current?.focus();
  }, [error]);

  return (
    <main id="contenido" className="mx-auto w-full max-w-2xl px-4 py-16">
      <EmptyState
        icon="🛠️"
        title={t('title')}
        description={error.digest ? `${t('description')} ${t('reference', { reference: error.digest })}` : t('description')}
        headingLevel={1}
        role="alert"
        headingRef={heading}
        action={
          <button type="button" onClick={reset} className="tactile-btn">
            {common('retry')}
          </button>
        }
      />
    </main>
  );
}
