/**
 * Candado semántico de las categorías exentas (skill korum-quorum-antifraud §4). Una iniciativa de infraestructura o equipamiento no
 * puede usar una categoría al 0 %. Se comparan palabras completas, nunca trozos: «cobrar» y «sobras» contienen «obra» y no la activan.
 * Primero se retiran las expresiones culturales seguras, así «obra de teatro» pasa y «obra de teatro y ventiladores» no.
 *
 * La lista blanca evita las expresiones abiertas, que continúan con un aparato o una instalación: «fans de» dejaría pasar «fans de techo».
 * Ante la duda se bloquea, porque el candado solo pide elegir una categoría con tramos. Es un filtro de buena fe: quien quiera esquivarlo
 * puede, y por eso el Super-Admin revisa las categorías al 0 %.
 */

const CULTURAL_WHITELIST = [
  // Castellano
  'obra de teatro', 'obras de teatro', 'obra teatral', 'obras teatrales', 'obra literaria', 'obras literarias', 'obra musical', 'obras musicales', 'obra de arte', 'obras de arte',
  'obra de titeres', 'obras de titeres', 'obra de danza', 'obra social', 'obras sociales', 'obra solidaria', 'obras solidarias', 'obra benefica', 'obras beneficas',
  'taller de pintura', 'pintura infantil', 'mano de obra solidaria', 'banana split',
  // Catalán (el apóstrofo ya se ha convertido en espacio)
  'obra de teatre', 'obres de teatre', 'obres teatrals', 'obres literaries', 'obres musicals', 'obra d art', 'obres d art', 'obra de titelles', 'obra de dansa', 'obres socials', 'obres solidaries', 'obra benefica', 'ma d obra solidaria',
  // Personas aficionadas, no aparatos
  'club de fans', 'fan club', 'fan zone', 'fiesta para fans', 'festa per a fans', 'sports fans', 'football fans', 'soccer fans'
];

const INFRASTRUCTURE_TERMS = [
  // Castellano
  'ventilador', 'ventiladores', 'aire acondicionado', 'aires acondicionados', 'aerotermia', 'split', 'splits', 'climatizacion', 'climatizar', 'pizarra', 'pizarras', 'proyector', 'proyectores',
  'reforma', 'reformas', 'reformar', 'rehabilitacion', 'remodelacion', 'fachada', 'fachadas', 'asfaltado', 'cesped artificial', 'cancha', 'canchas', 'toldo', 'toldos', 'pergola', 'pergolas', 'calefaccion',
  'ordenador', 'ordenadores', 'portatil', 'portatiles', 'tablet', 'tablets', 'tableta', 'tabletas', 'marcador led', 'marcadores led', 'obra', 'obras',
  'mobiliario', 'radiador', 'radiadores', 'ventilacion', 'altavoz', 'altavoces', 'porteria', 'porterias', 'pista deportiva', 'pistas deportivas',
  // Catalán
  'ventiladors', 'aire condicionat', 'aires condicionats', 'climatitzacio', 'climatitzar', 'pissarra', 'pissarres', 'projector', 'projectors', 'reformes', 'rehabilitacio', 'remodelacio', 'facana', 'facanes',
  'gespa artificial', 'asfaltat', 'tendal', 'tendals', 'calefaccio', 'ordinador', 'ordinadors', 'portatils', 'tauleta', 'tauletes', 'marcador led', 'marcadors led', 'obres',
  'mobiliari', 'radiador', 'radiadors', 'ventilacio', 'altaveu', 'altaveus', 'porteria', 'porteries', 'pista esportiva', 'pistes esportives',
  // Inglés
  'fan', 'fans', 'air conditioning', 'air conditioner', 'air conditioners', 'aircon', 'air con', 'whiteboard', 'whiteboards', 'awning', 'awnings', 'renovation', 'renovations', 'facade', 'facades',
  'computer', 'computers', 'laptop', 'laptops', 'heating', 'artificial turf', 'artificial grass', 'scoreboard', 'scoreboards',
  'furniture', 'radiator', 'radiators', 'ventilation', 'loudspeaker', 'loudspeakers', 'goalpost', 'goalposts', 'ac unit', 'ac units', 'sports court', 'refurbishment'
];

function wholeWords(terms: readonly string[]): RegExp {
  const longestFirst = [...terms].sort((a, b) => b.length - a.length);
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${longestFirst.join('|')})(?![\\p{L}\\p{N}])`, 'gu');
}

const WHITELIST_PATTERN = wholeWords(CULTURAL_WHITELIST);
const INFRASTRUCTURE_PATTERN = wholeWords(INFRASTRUCTURE_TERMS);

/** Sin acentos ni signos ni caracteres invisibles, y con un solo espacio entre palabras: `Calefacció` → `calefaccio`, `18Ventiladores` → `18 ventiladores`. */
function normalizeText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\p{M}\p{Cf}·]/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/(\p{N})(\p{L})/gu, '$1 $2')
    .replace(/(\p{L})(\p{N})/gu, '$1 $2')
    .trim();
}

export interface SemanticLockResult {
  isBlocked: boolean;
  /** Palabra que lo ha bloqueado, sin acentos, para explicárselo a la entidad. */
  matchedTerm: string | null;
}

export function evaluateSemanticLock(text: string): SemanticLockResult {
  const withoutCulture = normalizeText(text).replace(WHITELIST_PATTERN, ' ');
  const match = withoutCulture.match(INFRASTRUCTURE_PATTERN);
  return { isBlocked: match !== null, matchedTerm: match?.[0] ?? null };
}
