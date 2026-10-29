import clsx from 'clsx';
import { useTranslations } from 'next-intl';
import { KorumMark } from './korum-mark';

export interface KorumLogoProps {
  /** Alto del isotipo en píxeles; el nombre escala con él. */
  size?: number;
  /** `light` para fondos claros (nombre azul marino); `dark` para fondos oscuros (nombre marfil). */
  tone?: 'light' | 'dark';
  /** Oculta el nombre y deja solo el isotipo (cabeceras muy estrechas). */
  markOnly?: boolean;
  className?: string;
}

/**
 * Logotipo horizontal provisional: isotipo + nombre. Se sustituye por el vectorial definitivo cuando el promotor lo aporte
 * (skill korum-brand-design-system §2). El nombre usa Plus Jakarta Sans; el isotipo ya lleva la cinta con la palabra.
 */
export function KorumLogo({ size = 40, tone = 'light', markOnly = false, className }: KorumLogoProps) {
  const t = useTranslations('brand');

  return (
    <span className={clsx('inline-flex items-center gap-3', className)}>
      <KorumMark size={size} decorative={!markOnly} />
      {markOnly ? null : (
        <span
          className={clsx('font-corp font-extrabold uppercase tracking-[0.14em]', tone === 'dark' ? 'text-varsity-ivory' : 'text-varsity-navy')}
          style={{ fontSize: `${Math.round(size * 0.55)}px`, lineHeight: 1 }}
        >
          {t('name')}
        </span>
      )}
    </span>
  );
}
