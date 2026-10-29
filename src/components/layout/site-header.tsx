import { KorumLogo } from '@/components/brand/korum-logo';
import { LanguageSwitcher } from '@/components/ui/language-switcher';
import { Link } from '@/i18n/navigation';

/**
 * Cabecera del Entorno 0 (marketing y acceso): logotipo que lleva al inicio y selector de idioma.
 * El enlace no lleva `aria-label`: su nombre es el texto visible «KORUM» (WCAG 2.5.3), con el isotipo decorativo.
 */
export function SiteHeader() {
  return (
    <header className="border-b-2 border-varsity-navy/10 bg-white">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-3">
        <Link href="/" className="rounded-lg">
          <KorumLogo size={40} />
        </Link>
        <LanguageSwitcher />
      </div>
    </header>
  );
}
