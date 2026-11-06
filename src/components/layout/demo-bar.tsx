import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';

/**
 * Barra del entorno de demostración (Regla 01 §6): solo existe con `NEXT_PUBLIC_DEMO_MODE=true` y lleva a los tres entornos. A diferencia
 * del prototipo, **no** cambia de persona sin iniciar sesión: los perfiles simulados serían una puerta trasera; cada entorno pide su acceso.
 */
export function DemoBar() {
  const t = useTranslations('demo');
  const links = [
    { href: '/', label: t('family') },
    { href: '/panel/cervantes', label: t('panel') },
    { href: '/admin', label: t('console') }
  ];
  return (
    <aside aria-label={t('label')} className="bg-varsity-navy-deep text-varsity-ivory">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1 text-sm">
        <p className="font-bold text-varsity-gold">{t('notice')}</p>
        <nav aria-label={t('environments')} className="flex flex-wrap gap-x-3">
          {links.map((link) => (
            <Link key={link.href} href={link.href} prefetch={false} className="inline-flex min-h-11 items-center underline underline-offset-4 hover:text-varsity-gold">
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </aside>
  );
}
