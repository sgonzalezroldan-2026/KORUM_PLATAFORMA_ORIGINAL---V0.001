/**
 * Isotipo de KORUM como SVG puro, sin hooks ni traducciones: se puede usar en servidor, en cliente y en lugares donde
 * React no tiene contexto (tarjetas `next/og`, correos). `KorumMark` lo envuelve con el nombre accesible traducido.
 * Para `next/og` usa `variant="simple"` (sin cinta con texto).
 *
 * Parche colegial redondo con la K, laureles y cinta (lámina de referencia docs/brand/korum-logo.jpg).
 * Sin año ni subtítulo: sirve a colegios, clubes y entidades culturales (skill korum-brand-design-system §1 y §5).
 */

const NAVY = '#101f38';
const GOLD = '#f59e0b';
const GOLD_DEEP = '#d97706';
const IVORY = '#fdfbf7';

/** Por debajo de este tamaño (px) la cinta con texto y los laureles no se leen y se omiten. */
export const MARK_FULL_MIN_SIZE = 56;

// K de serifa plana (viewBox 100): tallo con remates, brazo superior y pierna con remate inferior.
const K_PATH =
  'M31 30H47V34H45.5V46L56 34H52V30H69V34H65.5L53.5 47.5L67 64H69.5V68H52.5V64H55L45.5 52.5V64H47V68H31V64H34V34H31Z';

interface LaurelLeaf {
  cx: number;
  cy: number;
  rotation: number;
  gold: boolean;
}

/** Hojas de la rama izquierda sobre un arco; la derecha es su reflejo. Cálculo determinista (sin aleatoriedad). */
function laurelLeaves(): LaurelLeaf[] {
  const leaves: LaurelLeaf[] = [];
  const total = 7;
  for (let i = 0; i < total; i += 1) {
    const angle = ((122 + (i * 112) / (total - 1)) * Math.PI) / 180; // de abajo-izquierda a arriba-izquierda
    const radius = 30 + (i % 2 === 0 ? -2.4 : 2.4);
    leaves.push({
      cx: Number((50 + radius * Math.cos(angle)).toFixed(2)),
      cy: Number((50 + radius * Math.sin(angle)).toFixed(2)),
      // Eje largo de la hoja a lo largo de la rama (tangente al arco) y abierto ±38° hacia fuera o hacia dentro.
      rotation: Number(((angle * 180) / Math.PI + (i % 2 === 0 ? -38 : 38)).toFixed(1)),
      gold: i % 2 === 0
    });
  }
  return leaves;
}

const LEAVES = laurelLeaves();

export interface KorumMarkSvgProps {
  /** Lado en píxeles. */
  size?: number;
  /** `full` incluye laureles y cinta; `simple` solo círculo y K. Por defecto se elige según el tamaño. */
  variant?: 'full' | 'simple';
  /** Nombre accesible. Sin él (o con `decorative`) el SVG queda oculto para lectores de pantalla. */
  label?: string;
  decorative?: boolean;
  /** Texto de la cinta (la palabra KORUM, traducida o no). */
  wordmark?: string;
  /** Identificador único del trazado del texto; obligatorio si hay varias marcas en la misma página. */
  pathId?: string;
  className?: string;
}

export function KorumMarkSvg({
  size = 48,
  variant,
  label,
  decorative = false,
  wordmark = 'KORUM',
  pathId = 'korum-mark-ribbon',
  className
}: KorumMarkSvgProps) {
  const simple = (variant ?? (size < MARK_FULL_MIN_SIZE ? 'simple' : 'full')) === 'simple';
  const hidden = decorative || !label;

  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={className}
      role={hidden ? undefined : 'img'}
      aria-label={hidden ? undefined : label}
      aria-hidden={hidden ? true : undefined}
      focusable="false"
    >
      <circle cx="50" cy="50" r="49" fill={NAVY} />
      <circle cx="50" cy="50" r="46" fill={GOLD} />
      <circle cx="50" cy="50" r="41.4" fill={IVORY} />
      <circle cx="50" cy="50" r="40" fill={NAVY} />
      {simple ? null : (
        <circle cx="50" cy="50" r="43.7" fill="none" stroke={GOLD_DEEP} strokeWidth="0.7" strokeDasharray="2.5 2" />
      )}

      {simple ? null : (
        <g fill="none" stroke={IVORY} strokeWidth="1" strokeLinecap="round" opacity="0.9">
          <path d="M34.1 75.4A30 30 0 0 1 32.4 25.7" />
          <path d="M65.9 75.4A30 30 0 0 0 67.6 25.7" />
        </g>
      )}

      {simple
        ? null
        : LEAVES.map((leaf) => {
            const mirroredX = Number((100 - leaf.cx).toFixed(2));
            return (
              <g key={`${leaf.cx}-${leaf.cy}`}>
                <ellipse cx={leaf.cx} cy={leaf.cy} rx="2.3" ry="5.6" transform={`rotate(${leaf.rotation} ${leaf.cx} ${leaf.cy})`} fill={leaf.gold ? GOLD : IVORY} />
                <ellipse
                  cx={mirroredX}
                  cy={leaf.cy}
                  rx="2.3"
                  ry="5.6"
                  transform={`rotate(${Number((-leaf.rotation).toFixed(1))} ${mirroredX} ${leaf.cy})`}
                  fill={leaf.gold ? GOLD : IVORY}
                />
              </g>
            );
          })}

      <g transform={simple ? 'translate(50 50) scale(1.15) translate(-50 -49)' : 'translate(50 46) scale(0.88) translate(-50 -49)'}>
        <path d={K_PATH} fill={GOLD_DEEP} transform="translate(1.4 1.4)" />
        <path d={K_PATH} fill={GOLD} stroke={IVORY} strokeWidth="2.4" strokeLinejoin="round" paintOrder="stroke" />
      </g>

      {simple ? null : (
        <g>
          <path d="M22 72 Q50 82 78 72 L81 82 Q50 93 19 82 Z" fill={GOLD} stroke={IVORY} strokeWidth="1" strokeLinejoin="round" />
          <path id={pathId} d="M26 81.2 Q50 88.6 74 81.2" fill="none" />
          <text fill={NAVY} fontSize="8.4" fontWeight="800" letterSpacing="1.2" textAnchor="middle" style={{ fontFamily: 'var(--font-plus-jakarta), system-ui, sans-serif' }}>
            <textPath href={`#${pathId}`} startOffset="50%">
              {wordmark}
            </textPath>
          </text>
        </g>
      )}
    </svg>
  );
}
