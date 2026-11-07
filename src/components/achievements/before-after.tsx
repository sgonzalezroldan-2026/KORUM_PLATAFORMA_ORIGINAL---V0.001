'use client';

import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

export interface BeforeAfterProps {
  title: string;
  /** Ruta de la imagen (`/api/files/public/{id}`), o `null` si la entidad aún no la ha publicado. */
  beforeSrc: string | null;
  afterSrc: string | null;
}

const chip = 'absolute top-2 rounded-full bg-varsity-navy px-3 py-1 text-xs font-extrabold uppercase text-white';

/**
 * Comparador Antes / Después (`id="fview-logros"` del prototipo): el ANTES a la izquierda y el DESPUÉS a la derecha, como se lee. Con las dos fotos,
 * una barra deslizante enseña más de una o de otra, con teclado (flechas, inicio y fin) y valor leído en voz alta. Con una sola foto se enseña tal
 * cual, y sin ninguna —o si una no carga— un texto que explica que llegarán. Las fotos las sube la entidad sin metadatos y confirmando que no
 * aparecen menores identificables.
 */
export function BeforeAfter({ title, beforeSrc, afterSrc }: BeforeAfterProps) {
  const t = useTranslations('portal.achievements');
  const sliderId = useId();
  // Porcentaje de la imagen «antes» que se ve, de izquierda a derecha; el resto es el «después».
  const [before, setBefore] = useState(50);
  // Una imagen que no carga (fichero retirado) no deja el texto alternativo desbordado sobre la tarjeta: se cae al aviso.
  const [failed, setFailed] = useState(false);

  if ((!beforeSrc && !afterSrc) || failed) {
    return (
      <p className="rounded-2xl border-2 border-dashed border-patio-rule-strong bg-patio-cream p-4 text-center text-sm font-semibold text-ink-soft" data-testid="achievement-no-photos">
        {t('noPhotos')}
      </p>
    );
  }
  if (!beforeSrc || !afterSrc) {
    const only = afterSrc ?? beforeSrc!;
    const isAfter = afterSrc !== null;
    return (
      <figure className="relative overflow-hidden rounded-2xl bg-patio-rule" data-testid="achievement-single-photo">
        {/* eslint-disable-next-line @next/next/no-img-element -- la ruta es propia y devuelve una redirección al cubo público; no pasa por el optimizador */}
        <img src={only} alt={t(isAfter ? 'afterAlt' : 'beforeAlt', { title })} width={800} height={600} loading="lazy" decoding="async" onError={() => setFailed(true)} className="aspect-4/3 w-full object-cover" />
        <figcaption className={`${chip} left-2`}>{t(isAfter ? 'after' : 'before')}</figcaption>
      </figure>
    );
  }

  return (
    <div className="space-y-2" data-testid="achievement-comparer">
      <div className="relative overflow-hidden rounded-2xl bg-patio-rule">
        {/* eslint-disable-next-line @next/next/no-img-element -- ver arriba */}
        <img src={afterSrc} alt={t('afterAlt', { title })} width={800} height={600} loading="lazy" decoding="async" onError={() => setFailed(true)} className="aspect-4/3 w-full object-cover" />
        {/* eslint-disable-next-line @next/next/no-img-element -- ver arriba */}
        <img
          src={beforeSrc}
          alt={t('beforeAlt', { title })}
          width={800}
          height={600}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="absolute inset-0 size-full object-cover"
          style={{ clipPath: `inset(0 ${100 - before}% 0 0)` }}
        />
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow-[0_0_0_1px_rgb(16_31_56/0.5)]" style={{ left: `${before}%` }} />
        {/* Cada etiqueta solo está mientras se ve su imagen. */}
        {before > 0 ? (
          <span aria-hidden="true" className={`${chip} left-2`}>
            {t('before')}
          </span>
        ) : null}
        {before < 100 ? (
          <span aria-hidden="true" className={`${chip} right-2`}>
            {t('after')}
          </span>
        ) : null}
      </div>
      <label htmlFor={sliderId} className="block text-sm font-bold text-varsity-navy">
        {t('compareLabel')}
      </label>
      <input
        id={sliderId}
        type="range"
        min={0}
        max={100}
        step={5}
        value={before}
        onChange={(event) => setBefore(Number(event.target.value))}
        aria-valuetext={t('compareValue', { after: 100 - before, before })}
        className="h-11 w-full cursor-pointer accent-varsity-emerald"
      />
    </div>
  );
}
