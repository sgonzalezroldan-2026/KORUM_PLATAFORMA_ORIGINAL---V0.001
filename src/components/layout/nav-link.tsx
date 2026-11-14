'use client';

import type { ComponentProps } from 'react';
import { Link, usePathname } from '@/i18n/navigation';

/**
 * Enlace de la navegación de marketing que se marca con `aria-current="page"` en la página en la que se está (heredado del Sprint 3.1). Es de
 * cliente porque la cabecera vive en páginas generadas una sola vez para todas las rutas: el servidor no sabe en cuál se pinta.
 */
export function NavLink({ href, className, ...rest }: Omit<ComponentProps<typeof Link>, 'href'> & { href: string }) {
  const pathname = usePathname();
  const current = pathname === href;
  return <Link href={href} aria-current={current ? 'page' : undefined} className={className} data-current={current ? 'true' : undefined} {...rest} />;
}
