// @vitest-environment node
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { ImageResizeError, MAX_INPUT_PIXELS, prepareWebImage, WEB_IMAGE_MAX_SIDE } from '@/services/media/resize-image';

/**
 * Sprint 4.4c · redimensionado y recodificado de las imágenes públicas (fotos de logros, portada y campaña): lado mayor de 1.600 px sin ampliar nada,
 * orientación aplicada a los píxeles, sin metadatos, mismo formato y rechazo de lo que no es una imagen admitida o pesa demasiado al decodificarse.
 */

const solid = (width: number, height: number, background = { r: 16, g: 31, b: 56 }) => sharp({ create: { width, height, channels: 3, background } });
const text = (value: string) => Uint8Array.from(Buffer.from(value, 'latin1'));
const contains = (bytes: Uint8Array, needle: string) => Buffer.from(bytes).includes(Buffer.from(needle, 'latin1'));

describe('Sprint 4.4c · prepareWebImage', () => {
  it('reduce una foto grande a 1.600 px de lado mayor, conserva el JPEG y el resultado pesa mucho menos', async () => {
    const original = await solid(4000, 3000).jpeg({ quality: 95 }).toBuffer();
    const prepared = await prepareWebImage(new Uint8Array(original));
    expect(prepared.mimeType).toBe('image/jpeg');
    expect(prepared.width).toBe(WEB_IMAGE_MAX_SIDE);
    expect(prepared.height).toBe(1200);
    const meta = await sharp(Buffer.from(prepared.bytes)).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 1600, 1200]);
    expect(prepared.bytes.length).toBeLessThan(original.length);
  });

  it('una foto vertical con orientación EXIF sale derecha (los píxeles ya giran) y sin ningún EXIF', async () => {
    // 4000×3000 con orientación 6: en pantalla es una foto vertical de 3000×4000.
    const original = await solid(4000, 3000).jpeg().withMetadata({ orientation: 6, exif: { IFD0: { Copyright: 'Maria Lopez', Make: 'Pixel 9' } } }).toBuffer();
    expect(contains(new Uint8Array(original), 'Maria Lopez')).toBe(true);
    const prepared = await prepareWebImage(new Uint8Array(original));
    expect([prepared.width, prepared.height]).toEqual([1200, 1600]);
    const meta = await sharp(Buffer.from(prepared.bytes)).metadata();
    expect(meta.orientation ?? 1).toBe(1);
    expect(meta.exif).toBeUndefined();
    for (const marker of ['Maria Lopez', 'Pixel 9']) expect(contains(prepared.bytes, marker), marker).toBe(false);
    // La auditoría recibe qué llevaba el original, no su contenido.
    expect(prepared.removed).toContain('APP1');
  });

  it('nunca amplía una imagen pequeña y conserva PNG y WebP', async () => {
    for (const [format, mime] of [['png', 'image/png'], ['webp', 'image/webp'], ['jpeg', 'image/jpeg']] as const) {
      const original = await solid(320, 200)[format]().toBuffer();
      const prepared = await prepareWebImage(new Uint8Array(original));
      expect(prepared.mimeType).toBe(mime);
      expect([prepared.width, prepared.height]).toEqual([320, 200]);
      expect((await sharp(Buffer.from(prepared.bytes)).metadata()).format).toBe(format);
    }
  });

  it('un PNG con transparencia la conserva', async () => {
    const original = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const prepared = await prepareWebImage(new Uint8Array(original));
    const meta = await sharp(Buffer.from(prepared.bytes)).metadata();
    expect(meta.hasAlpha).toBe(true);
  });

  it('admite un lado máximo distinto para quien lo pida (miniaturas)', async () => {
    const original = await solid(1000, 500).png().toBuffer();
    const prepared = await prepareWebImage(new Uint8Array(original), 400);
    expect([prepared.width, prepared.height]).toEqual([400, 200]);
  });

  it('rechaza lo que no es una imagen admitida: PDF, SVG con scripts, GIF y texto', async () => {
    const gif = await solid(8, 8).gif().toBuffer();
    const rejected = [text('%PDF-1.7 documento'), text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), new Uint8Array(gif), text('hola, no soy una imagen')];
    for (const bytes of rejected) await expect(prepareWebImage(bytes)).rejects.toMatchObject({ name: 'ImageResizeError', reason: 'UNSUPPORTED_TYPE' });
  });

  it('rechaza una imagen truncada o corrupta sin lanzar un error del servidor', async () => {
    const original = await solid(800, 600).jpeg().toBuffer();
    await expect(prepareWebImage(new Uint8Array(original.subarray(0, 40)))).rejects.toBeInstanceOf(ImageResizeError);
    const corrupt = Buffer.from(original);
    corrupt.fill(0xaa, 200, corrupt.length - 20);
    await expect(prepareWebImage(new Uint8Array(corrupt))).rejects.toBeInstanceOf(ImageResizeError);
  });

  it('rechaza una bomba de descompresión: pocos bytes que se decodifican a más de 40 megapíxeles', async () => {
    const side = Math.ceil(Math.sqrt(MAX_INPUT_PIXELS)) + 200;
    const bomb = await solid(side, side).png({ compressionLevel: 9 }).toBuffer();
    expect(bomb.length).toBeLessThan(4 * 1024 * 1024);
    await expect(prepareWebImage(new Uint8Array(bomb))).rejects.toMatchObject({ name: 'ImageResizeError', reason: 'TOO_MANY_PIXELS' });
  }, 60_000);
});
