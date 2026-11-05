import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';

export interface CtaBandProps {
  title: string;
  text: string;
  /** `signup`: dar de alta una entidad. `finder`: buscar la entidad de la persona (familias y comercios). */
  action: 'signup' | 'finder';
}

/** Llamada final de cada página de marketing: un único botón principal y, a su lado, una salida de bajo compromiso. */
export async function CtaBand({ title, text, action }: CtaBandProps) {
  const t = await getTranslations('marketing.cta');

  return (
    <section aria-labelledby="cta-title" className="rounded-patch bg-varsity-navy px-6 py-8 text-varsity-ivory shadow-vault sm:px-10">
      <h2 id="cta-title" className="font-corp text-2xl font-extrabold">
        {title}
      </h2>
      <p className="mt-2 max-w-2xl text-varsity-ivory/90">{text}</p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        {action === 'signup' ? (
          <Link href="/registro-comunidad" className="tactile-btn">
            {t('signup')}
          </Link>
        ) : (
          <Link href="/#buscador" className="tactile-btn">
            {t('find')}
          </Link>
        )}
        <Link href="/como-funciona" className="inline-flex min-h-11 items-center rounded-lg px-3 font-bold text-varsity-gold underline underline-offset-4">
          {t('howItWorks')}
        </Link>
      </div>
    </section>
  );
}
