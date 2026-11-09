import { useTranslations } from 'next-intl';
import { EntityCrest, heroBackground } from '@/components/portal/entity-crest';

/**
 * Vista previa de la cabecera del portal con la identidad de la entidad (Sprint 4.2e): portada bajo el velo azul marino, borde y brillo de su color y
 * escudo con su logotipo o sus iniciales, tal como lo verán las familias. Es una imagen de muestra: el nombre no es un título de la página.
 */
export function EntityBrandPreview({ name, accent, logoSrc, bannerSrc }: { name: string; accent: string; logoSrc: string | null; bannerSrc: string | null }) {
  const t = useTranslations('panel.settings.brand');
  return (
    <figure className="flex flex-col gap-2" data-testid="brand-preview">
      <div className="overflow-hidden rounded-3xl bg-varsity-navy p-5 text-varsity-ivory shadow-xl" style={heroBackground(accent, bannerSrc)}>
        <div className="flex min-w-0 items-center gap-4">
          <EntityCrest name={name} logoSrc={logoSrc} />
          <p className="font-joy text-2xl font-bold tracking-tight wrap-anywhere">{name}</p>
        </div>
      </div>
      <figcaption className="text-sm text-ink-soft">{t('previewCaption')}</figcaption>
    </figure>
  );
}
