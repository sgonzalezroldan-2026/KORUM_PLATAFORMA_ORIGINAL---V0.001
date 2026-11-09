import type { CSSProperties } from 'react';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const FILE_SRC = /^\/api\/files\/public\/[a-z0-9]{20,40}$/;

/** Iniciales para el escudo de la entidad mientras no tenga logotipo propio: hasta dos letras, sin símbolos. */
export function monogram(name: string): string {
  const letters = name
    .split(/\s+/)
    .map((word) => [...word].find((char) => /\p{L}/u.test(char)) ?? '')
    .filter((char) => char !== '');
  return letters.slice(0, 2).join('').toUpperCase();
}

/** Solo rutas de `/api/files/public/{id}`: nunca una URL arbitraria dentro de un `style` o un `src`. */
export const safeImageSrc = (src: string | null | undefined): string | null => (src && FILE_SRC.test(src) ? src : null);

/**
 * Fondo de la cabecera de la entidad (Sprint 4.2e): azul marino KORUM con el brillo y el borde de su color y, si tiene portada, la foto bajo un velo
 * azul marino del 86 %, que mantiene el texto blanco por encima de 4.5:1 sea cual sea la foto.
 */
export function heroBackground(accent: string, bannerSrc: string | null): CSSProperties {
  const color = HEX_COLOR.test(accent) ? accent : '#f59e0b';
  const banner = safeImageSrc(bannerSrc);
  const layers = [`radial-gradient(circle at 100% 0%, ${color}59, transparent 55%)`, ...(banner ? ['linear-gradient(rgba(16, 31, 56, 0.86), rgba(16, 31, 56, 0.86))', `url("${banner}")`] : [])];
  return {
    backgroundImage: layers.join(', '),
    backgroundSize: banner ? 'auto, auto, cover' : undefined,
    backgroundPosition: banner ? 'center' : undefined,
    borderBottom: `6px solid ${color}`
  };
}

/** Escudo de la entidad: su logotipo sobre blanco o, sin él, sus iniciales. Decorativo: el nombre ya está en el `h1` de al lado. */
export function EntityCrest({ name, logoSrc, size = 'md' }: { name: string; logoSrc: string | null; size?: 'sm' | 'md' }) {
  const logo = safeImageSrc(logoSrc);
  const box = size === 'sm' ? 'size-12 text-xl' : 'size-16 text-2xl';
  return (
    <div aria-hidden="true" className={`flex ${box} shrink-0 items-center justify-center overflow-hidden rounded-3xl border-2 border-white/80 bg-white font-joy font-bold text-varsity-navy shadow-lg`} data-testid="entity-crest">
      {/* eslint-disable-next-line @next/next/no-img-element -- logotipo público servido por /api/files/public, de tamaño pequeño y fijo */}
      {logo ? <img src={logo} alt="" width={64} height={64} className="size-full object-contain p-1" /> : monogram(name)}
    </div>
  );
}
