import type { ReactNode } from 'react';
import { PrivateIntlProvider } from '@/components/layout/private-intl-provider';

/**
 * Entorno 2 (panel de la entidad, firmas y portería): sus componentes interactivos usan los textos del panel y de la portería, que el proveedor
 * raíz no envía a las páginas públicas (`src/i18n/client-messages.ts`). No añade nada visible: la cabecera y la guardia viven más abajo.
 */
export default function DashboardGroupLayout({ children }: { children: ReactNode }) {
  return <PrivateIntlProvider zone="dashboard">{children}</PrivateIntlProvider>;
}
