import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { UiGallery } from '@/components/dev/ui-gallery';
import { isDevGalleryAvailable } from '@/config/dev-gallery';

export const metadata: Metadata = { title: 'Galería de componentes' };

/** Galería interna de componentes: solo existe en desarrollo o en el entorno de demostración (nunca en producción real). */
export default function UiGalleryPage() {
  if (!isDevGalleryAvailable()) notFound();

  return <UiGallery />;
}
