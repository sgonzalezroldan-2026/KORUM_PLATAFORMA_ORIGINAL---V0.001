import { getTranslations } from 'next-intl/server';
import { Confetti } from '@/components/checkout/checkout-celebration';
import type { Locale } from '@/i18n/routing';

/**
 * Momento de celebración al llegar al panel tras el alta de la entidad (heredado del Sprint 3.2, EXPERIENCIA_DE_PRODUCTO §6): confeti breve (solo
 * con movimiento permitido) y una pegatina que salta con la bienvenida; los primeros pasos ya los enseña el cuadro de mandos justo debajo. Solo
 * se pinta con `?bienvenida=1` (lo añade el alta) y mientras la entidad no tenga ninguna campaña: recargar la página más adelante no lo repite.
 */
export async function WelcomeCelebration({ locale, entityName }: { locale: Locale; entityName: string }) {
  const t = await getTranslations({ locale, namespace: 'panel.welcomeCelebration' });
  return (
    <section aria-labelledby="welcome-celebration-title" className="korum-paper-dots flex flex-col items-start gap-3 rounded-3xl border-2 border-varsity-gold p-5 sm:p-6" data-testid="welcome-celebration">
      <Confetti />
      <h2 id="welcome-celebration-title" className="die-cut-sticker korum-sticker-pop font-joy text-xl font-bold text-varsity-navy sm:text-2xl">
        <span aria-hidden="true">{'🎉 '}</span>
        {t('title')}
      </h2>
      <p className="max-w-3xl font-semibold text-ink">{t('body', { name: entityName })}</p>
      <p className="max-w-3xl text-ink-soft">{t('next')}</p>
    </section>
  );
}
