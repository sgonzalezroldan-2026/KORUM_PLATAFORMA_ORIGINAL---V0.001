import { KorumLogo } from '@/components/brand/korum-logo';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { Link } from '@/i18n/navigation';

/** Cabecera de los entornos privados (panel de la entidad y consola): marca colegial, a quién pertenece la vista y cerrar sesión. */
export function ConsoleHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header className="bg-varsity-navy text-varsity-ivory">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/" className="inline-flex min-h-11 min-w-11 shrink-0 items-center rounded-lg">
            <KorumLogo size={40} markOnly tone="dark" />
          </Link>
          <div className="min-w-0">
            <p className="truncate font-corp font-extrabold">{title}</p>
            <p className="truncate text-sm text-varsity-ivory/80">{subtitle}</p>
          </div>
        </div>
        <SignOutButton />
      </div>
    </header>
  );
}
