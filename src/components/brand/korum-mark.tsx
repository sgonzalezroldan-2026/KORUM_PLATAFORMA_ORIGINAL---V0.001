import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { KorumMarkSvg, type KorumMarkSvgProps } from './korum-mark-svg';

export interface KorumMarkProps extends Omit<KorumMarkSvgProps, 'wordmark' | 'pathId'> {
  /** Pasa `decorative` si el texto «KORUM» ya acompaña al isotipo (p. ej. dentro de `KorumLogo`). */
  decorative?: boolean;
}

/**
 * Isotipo de KORUM con nombre accesible y texto de la cinta traducidos. Para tarjetas `next/og` o correos, donde no hay
 * contexto de React, usa `KorumMarkSvg` directamente.
 */
export function KorumMark({ label, decorative = false, ...rest }: KorumMarkProps) {
  const t = useTranslations('brand');
  const pathId = useId();

  return <KorumMarkSvg {...rest} decorative={decorative} label={label ?? t('markLabel')} wordmark={t('name')} pathId={`korum-ribbon-${pathId.replace(/:/g, '')}`} />;
}
