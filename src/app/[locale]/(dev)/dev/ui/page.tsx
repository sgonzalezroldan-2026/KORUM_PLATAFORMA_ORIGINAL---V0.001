import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { UiGallery } from '@/components/dev/ui-gallery';

export const metadata: Metadata = { title: 'Galería de componentes' };

/** Galería interna de componentes: solo existe en desarrollo o en el entorno de demostración (nunca en producción real). */
export default function UiGalleryPage() {
  const available = process.env.NODE_ENV !== 'production' || process.env.NEXT_PUBLIC_DEMO_MODE === 'true';
  if (!available) notFound();

  return <UiGallery />;
}
