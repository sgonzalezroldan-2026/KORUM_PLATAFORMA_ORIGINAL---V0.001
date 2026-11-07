import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { getPrisma } from '@/lib/prisma';
import { getSetting } from '@/services/settings/settings.service';

/**
 * Mi Hucha solo existe si el Super-Admin la tiene activada (`hucha.mode`). El 404 se decide aquí, antes del `loading.tsx` de la página: dentro
 * de ella, el esqueleto ya habría enviado un `200` (skill de interfaz §5).
 */
export default async function HuchaLayout({ children }: { children: ReactNode }) {
  const mode = await getSetting(getPrisma(), 'hucha.mode');
  if (mode !== 'PLEDGE' && mode !== 'REGULATED_WALLET') notFound();
  return children;
}
