import { KorumLogo } from '@/components/brand/korum-logo';
import { LanguageSwitcher } from '@/components/ui/language-switcher';
import { AccountLink } from '@/components/layout/account-link';
import { Link } from '@/i18n/navigation';

/**
 * Cabecera global del Entorno 1: el logotipo de KORUM (zona de confianza), el selector de idioma y el acceso (o «Mi cuenta» si ya se ha entrado). Va por encima de la portada
 * de la entidad, que lleva su propio nombre como único `h1`. El acceso vuelve a la misma comunidad (`next` solo admite rutas internas).
 */
export function PortalHeader({ orgSlug }: { orgSlug: string }) {
  return (
    <header className="border-b-2 border-varsity-navy/10 bg-white print:hidden">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-3">
        <Link href="/" className="inline-flex min-h-11 min-w-11 shrink-0 items-center rounded-lg">
          {/* El selector de idioma y «Entrar» comparten la fila: por debajo de 480 px solo cabe el isotipo, que no puede encogerse. */}
          <KorumLogo size={40} className="shrink-0 max-[479px]:hidden" />
          <KorumLogo size={40} markOnly className="shrink-0 min-[480px]:hidden" />
        </Link>
        <div className="flex items-center gap-2">
          <LanguageSwitcher />
          <AccountLink
            loginHref={`/login?next=${encodeURIComponent(`/${orgSlug}`)}`}
            className="inline-flex min-h-11 items-center whitespace-nowrap rounded-lg px-3 font-semibold text-varsity-navy hover:bg-varsity-navy/10"
          />
        </div>
      </div>
    </header>
  );
}
