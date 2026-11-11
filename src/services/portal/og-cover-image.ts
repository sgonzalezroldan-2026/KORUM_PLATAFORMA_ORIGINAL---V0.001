import sharp from 'sharp';
import type { KorumPrismaClient } from '@/lib/prisma';
import { FILE_RULES } from '@/services/storage/file-rules';
import { readPublicImage } from './og-entity-logo';

/**
 * Miniatura de la imagen de una campaña para su tarjeta de WhatsApp y redes (Sprint 4.4c). La tarjeta debe pesar menos de 300 KB (QA-F02) y su salida
 * es un PNG, que con una fotografía crece mucho: por eso la imagen entra como una miniatura cuadrada de 480 px (se pinta a 240) recodificada en JPEG, y
 * no como fondo. Acepta también WebP (se recodifica aquí, así que satori no lo ve). Nunca lanza: sin miniatura la tarjeta sale como siempre.
 */
const ACCEPTED = new Set(['image/png', 'image/jpeg', 'image/webp']);
export const OG_COVER_SIDE = 480;

export async function ogCoverThumbnail(db: KorumPrismaClient, fileId: string | null): Promise<string | null> {
  const image = await readPublicImage(db, fileId, FILE_RULES.INITIATIVE_COVER.maxBytes, ACCEPTED);
  if (!image) return null;
  try {
    const jpeg = await sharp(image.bytes, { limitInputPixels: 40_000_000, failOn: 'error' }).rotate().resize({ width: OG_COVER_SIDE, height: OG_COVER_SIDE, fit: 'cover' }).jpeg({ quality: 72 }).toBuffer();
    return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  } catch {
    return null;
  }
}
