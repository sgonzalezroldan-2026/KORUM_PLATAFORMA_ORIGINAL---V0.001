import type { ComponentType, ReactNode } from 'react';
import type { PillarKey } from '@/lib/seo/marketing-routes';

/**
 * Ilustraciones vectoriales de ambiente de la portada y de las páginas por público. Están dibujadas a mano en SVG con los colores de la marca
 * (azul marino, oro, esmeralda y papel crema), en plano y sin personas: no hay rostros ni menores identificables, ni marcas, ni letras legibles
 * (skill korum-brand-design-system §4). Son decorativas (`aria-hidden`), llevan un único identificador de recorte (una ilustración por página) y
 * pesan unos pocos KB cada una.
 */

const NAVY = '#101f38';
const GOLD = '#f59e0b';
const SUN = '#ffb800';
const EMERALD = '#047857';
const CREAM = '#fff6e0';
const IVORY = '#fdfbf7';
const CORAL = '#ff5a43';
const SKY = '#cfe8ff';
const WOOD = '#c98b4b';
const FLOOR = '#ecd9ab';

interface IllustrationProps {
  className?: string;
}

/** Marco común: papel crema con esquinas redondeadas que recorta el dibujo. `clipId` es único por ilustración (una por página). */
function Frame({ className, clipId, children }: IllustrationProps & { clipId: string; children: ReactNode }) {
  return (
    <svg viewBox="0 0 480 300" className={className} aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
      <clipPath id={clipId}>
        <rect width="480" height="300" rx="24" />
      </clipPath>
      <g clipPath={`url(#${clipId})`}>
        <rect width="480" height="300" fill={CREAM} />
        {children}
      </g>
    </svg>
  );
}

/** Patio de colegio de barrio con toldo de sombra, portería y mochilas. */
export function PatioIllustration({ className }: IllustrationProps) {
  return (
    <Frame className={className} clipId="korum-ill-patio">
      <circle cx="410" cy="62" r="46" fill={SUN} opacity="0.25" />
      <circle cx="410" cy="62" r="30" fill={SUN} />
      <rect x="0" y="222" width="480" height="78" fill={FLOOR} />
      <path d="M0 222H480" stroke={NAVY} strokeWidth="3" opacity="0.2" />
      {/* edificio */}
      <rect x="28" y="116" width="232" height="108" fill="#dbe4f0" stroke={NAVY} strokeWidth="3" />
      <path d="M16 118L144 66L272 118Z" fill={NAVY} />
      <rect x="127" y="166" width="34" height="58" rx="3" fill={GOLD} stroke={NAVY} strokeWidth="3" />
      {[48, 84, 188, 224].map((x) => (
        <rect key={x} x={x} y="140" width="22" height="26" fill={SKY} stroke={NAVY} strokeWidth="2.5" />
      ))}
      {[48, 84, 188, 224].map((x) => (
        <rect key={`b${x}`} x={x} y="184" width="22" height="26" fill={SKY} stroke={NAVY} strokeWidth="2.5" />
      ))}
      <path d="M144 66V44" stroke={NAVY} strokeWidth="3" />
      <path d="M144 44H170L162 51L170 58H144Z" fill={EMERALD} />
      {/* toldo de sombra */}
      <path d="M296 238V158M452 238V158" stroke={NAVY} strokeWidth="5" strokeLinecap="round" />
      <path d="M284 154L464 154L478 186L270 186Z" fill={IVORY} stroke={NAVY} strokeWidth="3" strokeLinejoin="round" />
      {[0, 2, 4].map((i) => (
        <path key={i} d={`M${284 + i * 36} 154H${320 + i * 36}L${311.6 + i * 41.6} 186H${270 + i * 41.6}Z`} fill={GOLD} />
      ))}
      <path d="M270 186Q290 198 310 186Q330 198 350 186Q370 198 390 186Q410 198 430 186Q450 198 470 186" fill="none" stroke={NAVY} strokeWidth="3" />
      {/* banco y mochilas */}
      <rect x="310" y="214" width="120" height="10" rx="3" fill={WOOD} stroke={NAVY} strokeWidth="2.5" />
      <path d="M322 224V240M418 224V240" stroke={NAVY} strokeWidth="4" strokeLinecap="round" />
      <rect x="332" y="190" width="30" height="24" rx="8" fill={CORAL} stroke={NAVY} strokeWidth="2.5" />
      <rect x="372" y="196" width="26" height="18" rx="7" fill={EMERALD} stroke={NAVY} strokeWidth="2.5" />
      {/* portería y balón */}
      <path d="M60 280V248H132V280" fill="none" stroke={IVORY} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M60 280V248H132V280" fill="none" stroke={NAVY} strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M72 250V278M84 250V278M96 250V278M108 250V278M120 250V278M62 262H130" stroke={NAVY} strokeWidth="1.2" opacity="0.35" />
      <circle cx="176" cy="268" r="14" fill={IVORY} stroke={NAVY} strokeWidth="2.5" />
      <path d="M176 258L184 264L181 273H171L168 264Z" fill={NAVY} />
    </Frame>
  );
}

/** Aula con pizarra de tiza (solo garabatos), ventiladores y pupitres. */
export function ClassroomIllustration({ className }: IllustrationProps) {
  return (
    <Frame className={className} clipId="korum-ill-classroom">
      <rect y="228" width="480" height="72" fill={FLOOR} />
      <rect x="326" y="48" width="118" height="96" rx="4" fill={SKY} stroke={NAVY} strokeWidth="4" />
      <path d="M385 48V144M326 96H444" stroke={NAVY} strokeWidth="3" />
      <circle cx="414" cy="76" r="14" fill={SUN} />
      {/* pizarra */}
      <rect x="36" y="56" width="262" height="130" rx="8" fill="#0b5d46" stroke={WOOD} strokeWidth="8" />
      <g fill="none" stroke={IVORY} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" opacity="0.9">
        <circle cx="84" cy="106" r="20" />
        <path d="M70 100L84 90L98 100M74 116H94" />
        <path d="M136 98Q150 80 164 98T192 98T220 98T248 98" />
        <path d="M140 140L158 124L176 140L194 124L212 140" />
        <path d="M232 128L244 152L256 128L268 152" opacity="0.7" />
        <path d="M60 156H110M60 168H90" opacity="0.7" />
      </g>
      <rect x="120" y="188" width="70" height="7" rx="3" fill={WOOD} />
      {/* ventiladores de techo */}
      {[110, 262].map((x) => (
        <g key={x}>
          <path d={`M${x} 0V16`} stroke={NAVY} strokeWidth="3" />
          <circle cx={x} cy="20" r="6" fill={NAVY} />
          <ellipse cx={x - 28} cy="22" rx="26" ry="5" fill={GOLD} stroke={NAVY} strokeWidth="2" />
          <ellipse cx={x + 28} cy="22" rx="26" ry="5" fill={GOLD} stroke={NAVY} strokeWidth="2" />
        </g>
      ))}
      {/* pupitres */}
      {[52, 170, 288].map((x) => (
        <g key={x}>
          <rect x={x} y="214" width="84" height="10" rx="3" fill={WOOD} stroke={NAVY} strokeWidth="2.5" />
          <path d={`M${x + 10} 224V268M${x + 74} 224V268`} stroke={NAVY} strokeWidth="4" strokeLinecap="round" />
          <rect x={x + 14} y="200" width="26" height="14" rx="2" fill={CORAL} stroke={NAVY} strokeWidth="2" />
          <rect x={x + 44} y="204" width="22" height="10" rx="2" fill={EMERALD} stroke={NAVY} strokeWidth="2" />
          <rect x={x + 20} y="244" width="46" height="8" rx="3" fill={NAVY} opacity="0.85" />
        </g>
      ))}
    </Frame>
  );
}

/** Pabellón con marcador LED encendido (sin cifras legibles), gradas y balón. */
export function GymIllustration({ className }: IllustrationProps) {
  return (
    <Frame className={className} clipId="korum-ill-gym">
      <rect y="206" width="480" height="94" fill="#e0b572" />
      <g stroke={IVORY} strokeWidth="3" fill="none" opacity="0.9">
        <path d="M0 262H480" />
        <ellipse cx="300" cy="262" rx="64" ry="18" />
        <path d="M300 244V280" />
      </g>
      {/* marcador */}
      <path d="M200 0V34M360 0V34" stroke={NAVY} strokeWidth="4" />
      <rect x="170" y="34" width="220" height="86" rx="12" fill={NAVY} />
      <rect x="180" y="44" width="200" height="66" rx="8" fill="#0a1424" />
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x={198 + i * 46} y="58" width="30" height="38" rx="5" fill={i === 1 ? GOLD : 'none'} stroke={GOLD} strokeWidth="3.5" opacity={i === 1 ? 0.55 : 1} />
      ))}
      <circle cx="288" cy="70" r="3.5" fill={GOLD} />
      <circle cx="288" cy="86" r="3.5" fill={GOLD} />
      {/* gradas */}
      <path d="M0 206V150H150V206Z" fill="#c7d3e6" stroke={NAVY} strokeWidth="3" />
      <path d="M0 178H150M0 192H150" stroke={NAVY} strokeWidth="2.5" />
      <path d="M0 150V236H0" stroke={NAVY} strokeWidth="3" />
      {[
        { x: 22, c: CORAL },
        { x: 62, c: EMERALD },
        { x: 102, c: GOLD }
      ].map((scarf) => (
        <g key={scarf.x}>
          <rect x={scarf.x} y="130" width="16" height="42" rx="4" fill={scarf.c} stroke={NAVY} strokeWidth="2.5" />
          <path d={`M${scarf.x + 4} 142H${scarf.x + 12}M${scarf.x + 4} 152H${scarf.x + 12}`} stroke={IVORY} strokeWidth="2.5" />
        </g>
      ))}
      {/* balón, conos y bolsa */}
      <circle cx="90" cy="262" r="18" fill={IVORY} stroke={NAVY} strokeWidth="3" />
      <path d="M90 249L101 257L97 270H83L79 257Z" fill={NAVY} />
      <path d="M90 244V249M108 256L101 257M102 273L97 270M78 273L83 270M72 256L79 257" stroke={NAVY} strokeWidth="2" />
      {[160, 196].map((x) => (
        <g key={x}>
          <path d={`M${x} 280L${x + 12} 252L${x + 24} 280Z`} fill={CORAL} stroke={NAVY} strokeWidth="2.5" strokeLinejoin="round" />
          <path d={`M${x + 5} 270H${x + 19}`} stroke={IVORY} strokeWidth="3" />
        </g>
      ))}
      <rect x="400" y="240" width="52" height="36" rx="10" fill={EMERALD} stroke={NAVY} strokeWidth="3" />
      <path d="M412 240Q426 222 440 240" fill="none" stroke={NAVY} strokeWidth="3" />
    </Frame>
  );
}

/** Escenario con cortinas, focos, atriles e instrumentos. */
export function StageIllustration({ className }: IllustrationProps) {
  return (
    <Frame className={className} clipId="korum-ill-stage">
      <rect x="40" y="0" width="400" height="214" fill="#fbe6b3" />
      <path d="M240 0L170 214H310Z" fill={SUN} opacity="0.28" />
      <circle cx="240" cy="14" r="12" fill={NAVY} />
      <path d="M0 214H480V300H0Z" fill={WOOD} />
      <path d="M0 236H480M0 262H480" stroke={NAVY} strokeWidth="2" opacity="0.2" />
      {/* cortinas */}
      <path d="M0 0H70Q92 90 64 214H0Z" fill={CORAL} />
      <path d="M480 0H410Q388 90 416 214H480Z" fill={CORAL} />
      <path d="M22 0Q40 100 20 214M46 0Q60 100 44 214M458 0Q440 100 460 214M434 0Q420 100 436 214" fill="none" stroke="#c23f2a" strokeWidth="5" />
      <path d="M0 0H480V22H0Z" fill="#c23f2a" />
      <path d="M0 22Q30 40 60 22T120 22T180 22T240 22T300 22T360 22T420 22T480 22V0H0Z" fill="#a8321f" />
      {/* atriles */}
      {[150, 330].map((x) => (
        <g key={x}>
          <path d={`M${x} 232V152M${x - 18} 252L${x} 232L${x + 18} 252`} stroke={NAVY} strokeWidth="4" strokeLinecap="round" fill="none" />
          <path d={`M${x - 26} 130L${x + 26} 124L${x + 26} 160L${x - 26} 160Z`} fill={IVORY} stroke={NAVY} strokeWidth="3" strokeLinejoin="round" />
          <path d={`M${x - 16} 138H${x + 16}M${x - 16} 146H${x + 16}M${x - 16} 154H${x + 8}`} stroke={NAVY} strokeWidth="2" opacity="0.5" />
        </g>
      ))}
      {/* tambor */}
      <ellipse cx="240" cy="226" rx="38" ry="12" fill={IVORY} stroke={NAVY} strokeWidth="3" />
      <path d="M202 226V256Q240 276 278 256V226" fill={EMERALD} stroke={NAVY} strokeWidth="3" strokeLinejoin="round" />
      <path d="M214 232L222 262M240 236V268M266 232L258 262" stroke={IVORY} strokeWidth="2.5" />
      <path d="M222 212L206 192M258 212L276 190" stroke={NAVY} strokeWidth="4" strokeLinecap="round" />
      {/* violín */}
      <g transform="rotate(-18 96 240)">
        <ellipse cx="96" cy="250" rx="20" ry="14" fill={WOOD} stroke={NAVY} strokeWidth="3" />
        <ellipse cx="96" cy="230" rx="14" ry="11" fill={WOOD} stroke={NAVY} strokeWidth="3" />
        <path d="M96 222V176" stroke={NAVY} strokeWidth="5" strokeLinecap="round" />
        <path d="M91 244H101" stroke={NAVY} strokeWidth="2.5" />
      </g>
      {/* notas */}
      <g fill={NAVY}>
        <ellipse cx="392" cy="96" rx="9" ry="6.5" transform="rotate(-20 392 96)" />
        <path d="M399 94V54L416 60" stroke={NAVY} strokeWidth="3.5" fill="none" strokeLinecap="round" />
        <ellipse cx="108" cy="80" rx="8" ry="6" transform="rotate(-20 108 80)" />
        <path d="M115 78V44" stroke={NAVY} strokeWidth="3.5" strokeLinecap="round" />
      </g>
    </Frame>
  );
}

/** Calle comercial de barrio con toldo, escaparates, letrero en blanco y bicicleta. */
export function ShopIllustration({ className }: IllustrationProps) {
  return (
    <Frame className={className} clipId="korum-ill-shop">
      <rect y="250" width="480" height="50" fill="#d9c9a0" />
      <path d="M0 250H480" stroke={NAVY} strokeWidth="3" opacity="0.25" />
      <rect x="64" y="96" width="352" height="156" fill="#f6e7c8" stroke={NAVY} strokeWidth="3" />
      {/* letrero en blanco y toldo */}
      <rect x="160" y="30" width="160" height="38" rx="8" fill={NAVY} />
      <circle cx="240" cy="49" r="8" fill={GOLD} />
      <path d="M56 88H424L440 128H40Z" fill={IVORY} stroke={NAVY} strokeWidth="3" strokeLinejoin="round" />
      {[0, 2, 4, 6].map((i) => (
        <path key={i} d={`M${56 + i * 46} 88H${102 + i * 46}L${90 + i * 50} 128H${40 + i * 50}Z`} fill={CORAL} />
      ))}
      <path d="M40 128Q63 142 86 128T132 128T178 128T224 128T270 128T316 128T362 128T408 128T440 128" fill="none" stroke={NAVY} strokeWidth="3" />
      {/* puerta y escaparates */}
      <rect x="212" y="158" width="56" height="94" rx="3" fill={EMERALD} stroke={NAVY} strokeWidth="3" />
      <rect x="222" y="168" width="36" height="34" fill={SKY} stroke={NAVY} strokeWidth="2.5" />
      <circle cx="258" cy="212" r="3.5" fill={GOLD} />
      <rect x="86" y="156" width="104" height="72" rx="3" fill={SKY} stroke={NAVY} strokeWidth="3" />
      <path d="M86 206H190" stroke={NAVY} strokeWidth="3" />
      <ellipse cx="112" cy="198" rx="16" ry="8" fill={WOOD} stroke={NAVY} strokeWidth="2" />
      <ellipse cx="146" cy="198" rx="16" ry="8" fill={WOOD} stroke={NAVY} strokeWidth="2" />
      <ellipse cx="174" cy="199" rx="10" ry="7" fill={GOLD} stroke={NAVY} strokeWidth="2" />
      <rect x="290" y="156" width="104" height="72" rx="3" fill={SKY} stroke={NAVY} strokeWidth="3" />
      <circle cx="320" cy="190" r="14" fill={EMERALD} />
      <circle cx="342" cy="182" r="12" fill="#059669" />
      <rect x="312" y="196" width="40" height="24" rx="4" fill={CORAL} stroke={NAVY} strokeWidth="2.5" />
      {/* bicicleta y macetas */}
      <g fill="none" stroke={NAVY} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="414" cy="268" r="20" />
        <circle cx="458" cy="268" r="20" />
        <path d="M414 268L432 244H452L458 268M432 244L444 268H414M426 238H440" />
      </g>
      {[40, 70].map((x) => (
        <g key={x}>
          <path d={`M${x} 240H${x + 22}L${x + 19} 262H${x + 3}Z`} fill={CORAL} stroke={NAVY} strokeWidth="2.5" strokeLinejoin="round" />
          <circle cx={x + 11} cy="232" r="11" fill={EMERALD} />
        </g>
      ))}
    </Frame>
  );
}

/** Qué ilustración acompaña a cada página pilar (las informativas no llevan). */
export const PILLAR_ILLUSTRATIONS: Partial<Record<PillarKey, ComponentType<IllustrationProps>>> = {
  colegios: ClassroomIllustration,
  clubes: GymIllustration,
  culturales: StageIllustration,
  comercios: ShopIllustration
};
