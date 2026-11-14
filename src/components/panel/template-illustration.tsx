import type { TemplateIllustration } from '@/core/studio/campaign-templates';

/**
 * Ilustraciones de portada de las plantillas de campaña (Sprint 4.3): SVG dibujado por código con la paleta de la marca (azul marino, oro, esmeralda y
 * coral de cera), sin fotografías ni ilustraciones externas. Son decorativas: el nombre de la plantilla ya lo dice el texto de al lado.
 */

const NAVY = '#101F38';
const GOLD = '#F59E0B';
const EMERALD = '#047857';
const CORAL = '#FF5A43';
const CREAM = '#FFFDF8';

function Motif({ kind }: { kind: TemplateIllustration }) {
  switch (kind) {
    case 'fan':
      return (
        <g>
          <circle cx="60" cy="38" r="5" fill={NAVY} />
          {[0, 90, 180, 270].map((angle) => (
            <ellipse key={angle} cx="60" cy="20" rx="7" ry="14" fill={GOLD} stroke={NAVY} strokeWidth="2" transform={`rotate(${angle} 60 38)`} />
          ))}
          <rect x="57" y="52" width="6" height="14" rx="2" fill={NAVY} />
          <rect x="46" y="64" width="28" height="5" rx="2.5" fill={NAVY} />
        </g>
      );
    case 'court':
      return (
        <g>
          <rect x="22" y="16" width="76" height="48" rx="4" fill={EMERALD} stroke={NAVY} strokeWidth="3" />
          <line x1="60" y1="16" x2="60" y2="64" stroke={CREAM} strokeWidth="2.5" />
          <circle cx="60" cy="40" r="9" fill="none" stroke={CREAM} strokeWidth="2.5" />
          <rect x="22" y="29" width="11" height="22" fill="none" stroke={CREAM} strokeWidth="2.5" />
          <rect x="87" y="29" width="11" height="22" fill="none" stroke={CREAM} strokeWidth="2.5" />
        </g>
      );
    case 'kit':
      return (
        <g>
          <path d="M40 18 L52 14 Q60 22 68 14 L80 18 L92 30 L82 38 L76 33 L76 66 L44 66 L44 33 L38 38 L28 30 Z" fill={GOLD} stroke={NAVY} strokeWidth="3" strokeLinejoin="round" />
          <circle cx="60" cy="44" r="7" fill={NAVY} />
        </g>
      );
    case 'laptop':
      return (
        <g>
          <rect x="30" y="18" width="60" height="38" rx="4" fill={NAVY} />
          <rect x="35" y="23" width="50" height="28" rx="2" fill={CORAL} />
          <path d="M22 58 H98 L92 66 H28 Z" fill={GOLD} stroke={NAVY} strokeWidth="2.5" strokeLinejoin="round" />
        </g>
      );
    case 'bus':
      return (
        <g>
          <rect x="20" y="22" width="80" height="34" rx="7" fill={GOLD} stroke={NAVY} strokeWidth="3" />
          {[28, 48, 68].map((x) => (
            <rect key={x} x={x} y="28" width="14" height="12" rx="2" fill={CREAM} stroke={NAVY} strokeWidth="2" />
          ))}
          <rect x="86" y="28" width="9" height="20" rx="2" fill={CREAM} stroke={NAVY} strokeWidth="2" />
          <circle cx="40" cy="58" r="7" fill={NAVY} />
          <circle cx="82" cy="58" r="7" fill={NAVY} />
        </g>
      );
    case 'heart':
      return (
        <g>
          <path d="M60 64 C24 42 30 18 46 18 C54 18 58 23 60 28 C62 23 66 18 74 18 C90 18 96 42 60 64 Z" fill={CORAL} stroke={NAVY} strokeWidth="3" strokeLinejoin="round" />
          <path d="M42 30 Q46 24 52 26" fill="none" stroke={CREAM} strokeWidth="3" strokeLinecap="round" />
        </g>
      );
    case 'stage':
      return (
        <g>
          <path d="M18 62 H102 V68 H18 Z" fill={NAVY} />
          <path d="M26 62 V20 Q60 36 94 20 V62 Z" fill={EMERALD} stroke={NAVY} strokeWidth="3" strokeLinejoin="round" />
          <path d="M26 20 Q40 32 40 62 M94 20 Q80 32 80 62" fill="none" stroke={GOLD} strokeWidth="3" />
          <circle cx="60" cy="44" r="6" fill={GOLD} />
        </g>
      );
    case 'raffle':
      return (
        <g>
          <path d="M24 26 H96 V36 a6 6 0 0 0 0 12 V58 H24 V48 a6 6 0 0 0 0 -12 Z" fill={GOLD} stroke={NAVY} strokeWidth="3" strokeLinejoin="round" />
          <line x1="76" y1="28" x2="76" y2="56" stroke={NAVY} strokeWidth="2.5" strokeDasharray="4 3" />
          <text x="46" y="48" textAnchor="middle" fontFamily="Plus Jakarta Sans, sans-serif" fontSize="18" fontWeight="800" fill={NAVY}>
            {'#7'}
          </text>
        </g>
      );
    case 'instrument':
      // Tambor con sus baquetas y dos notas (Sprint 5.5b: plantilla «Instrumentos» de las entidades culturales).
      return (
        <g>
          <ellipse cx="54" cy="34" rx="26" ry="8" fill={CREAM} stroke={NAVY} strokeWidth="3" />
          <path d="M28 34 V58 Q54 70 80 58 V34 Q54 46 28 34 Z" fill={CORAL} stroke={NAVY} strokeWidth="3" strokeLinejoin="round" />
          <path d="M32 40 L42 60 L52 42 L62 62 L72 42 L78 56" fill="none" stroke={GOLD} strokeWidth="2.5" strokeLinejoin="round" />
          <line x1="40" y1="14" x2="56" y2="30" stroke={NAVY} strokeWidth="3" strokeLinecap="round" />
          <line x1="70" y1="12" x2="60" y2="30" stroke={NAVY} strokeWidth="3" strokeLinecap="round" />
          <path d="M92 20 V36 M92 20 L102 17 V33" fill="none" stroke={EMERALD} strokeWidth="2.5" strokeLinecap="round" />
          <circle cx="89" cy="37" r="3.5" fill={EMERALD} />
          <circle cx="99" cy="34" r="3.5" fill={EMERALD} />
        </g>
      );
    case 'scoreboard':
      // Marcador de pabellón con dígitos de segmentos (Sprint 5.5b: plantilla de los clubes).
      return (
        <g>
          <rect x="20" y="14" width="80" height="44" rx="5" fill={NAVY} stroke={NAVY} strokeWidth="3" />
          <rect x="28" y="22" width="26" height="28" rx="3" fill="#1C2E4E" />
          <rect x="66" y="22" width="26" height="28" rx="3" fill="#1C2E4E" />
          <path d="M35 27 H47 V45 H35 Z" fill="none" stroke={GOLD} strokeWidth="3" strokeLinejoin="round" />
          <path d="M79 27 V45" fill="none" stroke={GOLD} strokeWidth="3" strokeLinecap="round" />
          <circle cx="60" cy="31" r="2" fill={EMERALD} />
          <circle cx="60" cy="41" r="2" fill={EMERALD} />
          <rect x="56" y="58" width="8" height="10" fill={NAVY} />
        </g>
      );
  }
}

export function TemplateArt({ kind, className }: { kind: TemplateIllustration; className?: string }) {
  return (
    <svg viewBox="0 0 120 80" aria-hidden="true" focusable="false" className={className}>
      <rect width="120" height="80" rx="10" fill={CREAM} />
      <rect x="1.5" y="1.5" width="117" height="77" rx="9" fill="none" stroke={NAVY} strokeOpacity="0.25" strokeWidth="3" />
      <Motif kind={kind} />
    </svg>
  );
}
