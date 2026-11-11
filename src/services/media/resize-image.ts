import sharp from 'sharp';
import { detectFileType, type DetectedType } from '@/services/storage/file-rules';
import { ImageMetadataError, stripImageMetadata } from '@/core/media/strip-image-metadata';

/**
 * Redimensiona y recodifica una imagen antes de publicarla (Sprint 4.4c, heredado de los Sprints 4.2e y 4.4a): fotos de logros, portada de la
 * entidad e imagen de una campaña. Una foto de móvil pesa 4–12 MB y mide 4.000 px; en una ficha pública se ve a 800 px, así que se baja a un lado
 * máximo de 1.600 px (cabe en pantallas de alta densidad) y se vuelve a codificar en su mismo formato: pesa una décima parte y las familias en 4G
 * la cargan al momento.
 *
 * - **Metadatos:** al recodificar no pasa ni el EXIF (ubicación, modelo del aparato) ni el XMP ni los comentarios; la orientación se **aplica** a los
 *   píxeles antes (una foto vertical no sale tumbada) y se descarta. Después se pasa igualmente `stripImageMetadata`: dos barreras distintas.
 * - **Formatos:** solo los que el almacén admite (`image/jpeg`, `image/png`, `image/webp`), detectados por los primeros bytes, nunca por lo que
 *   declare quien sube. `sharp` no llega a ver un SVG, un GIF ni un PDF.
 * - **Bombas de descompresión:** una imagen pequeña en bytes puede decodificarse a miles de millones de píxeles; se rechaza lo que pase de
 *   `MAX_INPUT_PIXELS` antes de decodificarlo.
 * - Una animación (WebP o PNG animado) se queda en su primer fotograma: una portada o una foto de logro es estática.
 */

/** Lado mayor de la imagen publicada. Nunca se amplía una imagen más pequeña. */
export const WEB_IMAGE_MAX_SIDE = 1_600;
/** 40 megapíxeles (una cámara de 12 MP da 12; una de 50 MP con los píxeles reducidos, menos): lo que pase se rechaza sin decodificarlo. */
export const MAX_INPUT_PIXELS = 40_000_000;
const JPEG_QUALITY = 82;
const WEBP_QUALITY = 80;

export type ResizeRejection = 'UNSUPPORTED_TYPE' | 'UNREADABLE' | 'TOO_MANY_PIXELS';

export class ImageResizeError extends Error {
  readonly reason: ResizeRejection;

  constructor(reason: ResizeRejection) {
    super(`No se puede preparar la imagen: ${reason}.`);
    this.name = 'ImageResizeError';
    this.reason = reason;
  }
}

export interface PreparedImage {
  bytes: Uint8Array;
  mimeType: Extract<DetectedType, 'image/jpeg' | 'image/png' | 'image/webp'>;
  width: number;
  height: number;
  /** Tipos de bloque de metadatos que llevaba la imagen ORIGINAL (para la auditoría; nunca su contenido). La salida no lleva ninguno. */
  removed: string[];
}

/** Rechaza (sin decodificar) una imagen de más de `MAX_INPUT_PIXELS`: para lo que no se recodifica (el logotipo), que llegaría tal cual a satori y a los navegadores. */
export async function assertPixelLimit(input: Uint8Array): Promise<void> {
  try {
    const { width, height } = await sharp(input, { limitInputPixels: false, failOn: 'error' }).metadata();
    if (!width || !height) throw new ImageResizeError('UNREADABLE');
    if (width * height > MAX_INPUT_PIXELS) throw new ImageResizeError('TOO_MANY_PIXELS');
  } catch (error) {
    if (error instanceof ImageResizeError) throw error;
    throw new ImageResizeError('UNREADABLE');
  }
}

/** Bytes de entrada → imagen lista para el cubo público. Lanza `ImageResizeError` si no se puede (la interfaz lo cuenta como «imagen ilegible»). */
export async function prepareWebImage(input: Uint8Array, maxSide: number = WEB_IMAGE_MAX_SIDE): Promise<PreparedImage> {
  const type = detectFileType(input);
  if (type !== 'image/jpeg' && type !== 'image/png' && type !== 'image/webp') throw new ImageResizeError('UNSUPPORTED_TYPE');

  // Qué llevaba el original, solo para dejar constancia en la auditoría: si no se puede recorrer no importa, la recodificación lo descarta igual.
  let original: string[] = [];
  try {
    original = stripImageMetadata(input).removed;
  } catch {
    original = [];
  }

  try {
    const base = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error', animated: false });
    // `rotate()` sin argumentos aplica la orientación del EXIF a los píxeles; `resize` solo reduce.
    const pipeline = base.rotate().resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true });
    const encoded = type === 'image/jpeg' ? pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: false }) : type === 'image/webp' ? pipeline.webp({ quality: WEBP_QUALITY }) : pipeline.png({ compressionLevel: 9, effort: 7 });
    const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
    const stripped = stripImageMetadata(new Uint8Array(data));
    return { bytes: stripped.bytes, mimeType: type, width: info.width, height: info.height, removed: original };
  } catch (error) {
    if (error instanceof ImageMetadataError) throw new ImageResizeError('UNREADABLE');
    if (error instanceof Error && /pixel limit|exceeds pixel/i.test(error.message)) throw new ImageResizeError('TOO_MANY_PIXELS');
    throw new ImageResizeError('UNREADABLE');
  }
}
