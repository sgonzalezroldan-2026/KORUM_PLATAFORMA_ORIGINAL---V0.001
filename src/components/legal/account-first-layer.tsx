import { getTranslations } from 'next-intl/server';
import { legalPathOf } from '@/core/legal/legal-catalog';
import type { Locale } from '@/i18n/routing';
import { getPrisma } from '@/lib/prisma';
import { legalMarkerValues } from '@/services/legal/legal-page-data';
import { FirstLayer, FirstLayerLink } from './first-layer';

/**
 * Primera capa de «Entrar o crear una cuenta» (primeras capas §11, Sprint 5.10a): en `/login` y en la página de una invitación, donde también se crea la cuenta.
 * Al crearla se registra la aceptación de las condiciones de uso vigentes (`recordAccountTermsAcceptance`).
 */
export async function AccountFirstLayer({ locale, testId, existingAccount = false }: { locale: Locale; testId: string; existingAccount?: boolean }) {
  const [t, markers] = await Promise.all([getTranslations({ locale, namespace: 'auth.login' }), legalMarkerValues(getPrisma())]);
  return (
    <FirstLayer
      testId={testId}
      line={t.rich(existingAccount ? 'firstLayer.lineExisting' : 'firstLayer.line', {
        terms: (chunks) => (
          <FirstLayerLink href={legalPathOf('terminos')} newTab={t('firstLayer.newTab')}>
            {chunks}
          </FirstLayerLink>
        ),
        rights: (chunks) => (
          <FirstLayerLink href={legalPathOf('privacidad')} newTab={t('firstLayer.newTab')}>
            {chunks}
          </FirstLayerLink>
        )
      })}
      summary={t('firstLayer.summary')}
      items={(['who', 'why', 'recipients', 'rights'] as const).map((key) => t.rich(`firstLayer.items.${key}`, { company: markers.legalName ?? 'none', email: markers.privacyEmail ?? 'none', strong: (chunks) => <strong>{chunks}</strong> }))}
      privacyLabel={t('firstLayer.privacy')}
      newTab={t('firstLayer.newTab')}
    />
  );
}
