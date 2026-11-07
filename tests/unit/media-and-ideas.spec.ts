import { describe, expect, it } from 'vitest';
import { cleanIdeaText, displayIdeaAlias, generateIdeaAlias, IDEA_DESCRIPTION_MAX, ideaAction, ideaCategories, ideaProgress, isIdeaAlias, proposeIdeaSchema } from '@/core/ideas/idea-rules';
import { ImageMetadataError, minimalOrientationExif, readExifOrientation, stripImageMetadata } from '@/core/media/strip-image-metadata';
import { trustedClientIp } from '@/lib/trusted-ip';

/** Sprint 3.6 · piezas puras: quitar metadatos a las fotos, reglas del buzón de ideas e IP de confianza. */

const text = (value: string) => Uint8Array.from(Buffer.from(value, 'latin1'));
const concat = (...parts: Uint8Array[]) => Uint8Array.from(Buffer.concat(parts));
const contains = (bytes: Uint8Array, needle: string) => Buffer.from(bytes).includes(Buffer.from(needle, 'latin1'));

const u16 = (value: number) => Uint8Array.from([value >> 8, value & 255]);
const segment = (marker: number, payload: Uint8Array) => concat(Uint8Array.from([0xff, marker]), u16(payload.length + 2), payload);

/** EXIF «little endian» con orientación y una «ubicación» reconocible en el texto. */
function exifWith(orientation: number): Uint8Array {
  const tiff = concat(
    text('II'), Uint8Array.from([0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]),
    Uint8Array.from([0x01, 0x00]), // una entrada
    Uint8Array.from([0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00]),
    Uint8Array.from([0x00, 0x00, 0x00, 0x00]),
    text('GPSLatitude=40.4168;Make=Pixel 9;Author=Maria')
  );
  return segment(0xe1, concat(text('Exif\0\0'), tiff));
}

const jpeg = (...between: Uint8Array[]) => concat(Uint8Array.from([0xff, 0xd8]), segment(0xe0, text('JFIF\0\x01\x01\0\0\x01\0\x01\0\0')), ...between, segment(0xdb, Uint8Array.from([0, 1, 2, 3])), Uint8Array.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0, 0xaa, 0xbb, 0xcc, 0xff, 0xd9]));

describe('fotos sin metadatos (heredado del 2.4)', () => {
  it('JPEG: fuera el EXIF con ubicación y modelo, el XMP, los comentarios y los bloques de otros programas; la imagen no cambia', () => {
    const xmp = segment(0xe1, text('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta Creator="Maria Lopez"/>'));
    const photoshop = segment(0xed, text('Photoshop 3.0\0author=Maria'));
    const comment = segment(0xfe, text('Hecha en casa de Maria'));
    const original = jpeg(exifWith(1), xmp, photoshop, comment);
    const { bytes, removed } = stripImageMetadata(original);
    for (const secret of ['GPSLatitude', 'Pixel 9', 'Maria', 'xmpmeta', 'Photoshop', 'casa']) expect(contains(bytes, secret)).toBe(false);
    expect(removed).toEqual(['APP1', 'APP13', 'COM']);
    // JFIF, tablas y datos de la imagen intactos, hasta el EOI.
    expect(contains(bytes, 'JFIF')).toBe(true);
    expect(Array.from(bytes.slice(-4))).toEqual([0xbb, 0xcc, 0xff, 0xd9]);
    expect(bytes.length).toBeLessThan(original.length);
  });

  it('JPEG: conserva la orientación (una foto vertical no sale tumbada) con un EXIF mínimo sin ningún otro campo', () => {
    const { bytes } = stripImageMetadata(jpeg(exifWith(6)));
    expect(contains(bytes, 'GPSLatitude')).toBe(false);
    // El único EXIF que queda es el de 34 bytes con la orientación.
    const start = Buffer.from(bytes).indexOf(Buffer.from('Exif\0\0', 'latin1'));
    expect(start).toBeGreaterThan(0);
    expect(readExifOrientation(bytes.subarray(start))).toBe(6);
    expect(minimalOrientationExif(6).length).toBe(36);
  });

  it('JPEG con orientación normal (1) o sin EXIF: no se añade ningún bloque', () => {
    expect(contains(stripImageMetadata(jpeg(exifWith(1))).bytes, 'Exif')).toBe(false);
    expect(contains(stripImageMetadata(jpeg()).bytes, 'Exif')).toBe(false);
  });

  it('JPEG truncado, con longitudes incoherentes o sin imagen: se rechaza (mejor no publicar que publicar con metadatos)', () => {
    const good = jpeg(exifWith(1));
    expect(() => stripImageMetadata(good.slice(0, 30))).toThrow(ImageMetadataError);
    expect(() => stripImageMetadata(concat(Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]), text('xx')))).toThrow(ImageMetadataError);
    expect(() => stripImageMetadata(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]))).not.toThrow();
    expect(() => stripImageMetadata(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0]))).toThrow(ImageMetadataError);
  });

  const crc = Uint8Array.from([0, 0, 0, 0]);
  const pngChunk = (type: string, body: Uint8Array = new Uint8Array()) => concat(Uint8Array.from([(body.length >>> 24) & 255, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255]), text(type), body, crc);
  const PNG_HEAD = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it('PNG: fuera tEXt, iTXt, zTXt, eXIf y tIME, y lo que venga detrás del bloque final', () => {
    const original = concat(PNG_HEAD, pngChunk('IHDR', new Uint8Array(13)), pngChunk('tEXt', text('Author\0Maria')), pngChunk('eXIf', text('GPS')), pngChunk('tIME', new Uint8Array(7)), pngChunk('IDAT', text('pixels')), pngChunk('iTXt', text('x')), pngChunk('IEND'), text('escondido tras IEND'));
    const { bytes, removed } = stripImageMetadata(original);
    expect(removed).toEqual(['tEXt', 'eXIf', 'tIME', 'iTXt', 'trailing']);
    for (const secret of ['Maria', 'GPS', 'escondido']) expect(contains(bytes, secret)).toBe(false);
    expect(contains(bytes, 'IHDR') && contains(bytes, 'IDAT') && contains(bytes, 'IEND')).toBe(true);
    expect(() => stripImageMetadata(concat(PNG_HEAD, pngChunk('IHDR', new Uint8Array(13))))).toThrow(ImageMetadataError);
  });

  const webpChunk = (type: string, body: Uint8Array) => concat(text(type), Uint8Array.from([body.length & 255, (body.length >>> 8) & 255, 0, 0]), body, body.length % 2 ? Uint8Array.from([0]) : new Uint8Array());
  const webp = (...chunks: Uint8Array[]) => {
    const body = concat(text('WEBP'), ...chunks);
    return concat(text('RIFF'), Uint8Array.from([body.length & 255, (body.length >>> 8) & 255, 0, 0]), body);
  };

  it('WebP: fuera EXIF y XMP, con sus banderas apagadas en VP8X y la longitud del contenedor corregida', () => {
    const flags = Uint8Array.from([0b00101100, 0, 0, 0, 1, 0, 0, 1, 0, 0]);
    const original = webp(webpChunk('VP8X', flags), webpChunk('EXIF', text('GPS Maria')), webpChunk('XMP ', text('xmp Maria')), webpChunk('VP8 ', text('pixeles')));
    const { bytes, removed } = stripImageMetadata(original);
    expect(removed).toEqual(['EXIF', 'XMP']);
    expect(contains(bytes, 'Maria')).toBe(false);
    const buffer = Buffer.from(bytes);
    expect(buffer.readUInt32LE(4) + 8).toBe(bytes.length);
    expect(buffer[20]! & 0b00001100).toBe(0);
    expect(buffer[20]! & 0b00100000).toBe(0b00100000);
  });

  it('JPEG: nada de lo que venga detrás del fin de la imagen (foto con movimiento, segunda imagen, datos escondidos)', () => {
    const { bytes, removed } = stripImageMetadata(concat(jpeg(), text('GPSLatitude oculto tras el EOI'), Uint8Array.from([0xff, 0xd8, 0xff, 0xe1])));
    expect(removed).toEqual(['trailing']);
    expect(contains(bytes, 'oculto')).toBe(false);
    expect(Array.from(bytes.slice(-2))).toEqual([0xff, 0xd9]);
  });

  it('JPEG: se descartan las imágenes incrustadas (MPF) y las miniaturas (JFXX) y se conservan el perfil de color, el JFIF y la marca Adobe corta', () => {
    const mpf = segment(0xe2, text('MPF\0segunda imagen con EXIF y GPS'));
    const icc = segment(0xe2, text('ICC_PROFILE\0perfil'));
    const jfxx = segment(0xe0, text('JFXX\0miniatura con EXIF'));
    const adobe = segment(0xee, text('Adobe\0d\0\0\0\0'));
    const longAdobe = segment(0xee, text('Adobe y además el nombre de la persona que editó la foto'));
    const { bytes, removed } = stripImageMetadata(jpeg(mpf, icc, jfxx, adobe, longAdobe));
    expect(removed).toEqual(['APP2', 'APP0', 'APP14']);
    for (const gone of ['segunda imagen', 'miniatura', 'nombre de la persona']) expect(contains(bytes, gone)).toBe(false);
    for (const kept of ['ICC_PROFILE', 'JFIF', 'Adobe\0']) expect(contains(bytes, kept)).toBe(true);
  });

  it('JPEG progresivo: varios SOS, con 0xFF 0x00 y reinicios dentro de los datos, se copian enteros y el EXIF de entre medias se quita', () => {
    const scan = (data: number[]) => concat(Uint8Array.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0]), Uint8Array.from(data));
    const first = scan([0xaa, 0xff, 0x00, 0xbb, 0xff, 0xd0, 0xcc]);
    const second = scan([0x11, 0xff, 0x00, 0x22, 0xff, 0xd7, 0x33]);
    const original = concat(Uint8Array.from([0xff, 0xd8]), segment(0xe0, text('JFIF\0\0\0\0\0\0')), segment(0xdb, Uint8Array.from([0, 1])), first, segment(0xc4, Uint8Array.from([5, 6])), exifWith(1), second, Uint8Array.from([0xff, 0xd9]));
    const { bytes, removed } = stripImageMetadata(original);
    expect(removed).toEqual(['APP1']);
    expect(contains(bytes, 'GPSLatitude')).toBe(false);
    expect(Buffer.from(bytes).includes(Buffer.from(first))).toBe(true);
    expect(Buffer.from(bytes).includes(Buffer.from(second))).toBe(true);
    expect(Array.from(bytes.slice(-2))).toEqual([0xff, 0xd9]);
  });

  it('PNG y WebP: solo se conservan los bloques que dibujan la imagen; un bloque auxiliar desconocido se descarta', () => {
    const png = concat(PNG_HEAD, pngChunk('IHDR', new Uint8Array(13)), pngChunk('pHYs', new Uint8Array(9)), pngChunk('prVt', text('privado Maria')), pngChunk('IDAT', text('pixels')), pngChunk('IEND'));
    const strippedPng = stripImageMetadata(png);
    expect(strippedPng.removed).toEqual(['prVt']);
    expect(contains(strippedPng.bytes, 'pHYs') && contains(strippedPng.bytes, 'IDAT')).toBe(true);
    const image = webp(webpChunk('VP8X', Uint8Array.from([0, 0, 0, 0, 1, 0, 0, 1, 0, 0])), webpChunk('PRIV', text('privado Maria')), webpChunk('VP8 ', text('pixeles')));
    const strippedWebp = stripImageMetadata(image);
    expect(strippedWebp.removed).toEqual(['PRIV']);
    expect(contains(strippedWebp.bytes, 'Maria')).toBe(false);
    expect(Buffer.from(strippedWebp.bytes).readUInt32LE(4) + 8).toBe(strippedWebp.bytes.length);
  });

  it('lista blanca: un JPEG con un bloque que no se entiende (JPGn, 0xC8, 0x00) se rechaza, y la miniatura del JFIF se quita', () => {
    for (const unknown of [0xf0, 0xc8, 0x00]) expect(() => stripImageMetadata(jpeg(segment(unknown, text('datos escondidos'))))).toThrow(ImageMetadataError);
    const withThumbnail = concat(Uint8Array.from([0xff, 0xd8]), segment(0xe0, text('JFIF    miniaturaRGBsecreta')), segment(0xdb, Uint8Array.from([0, 1])), Uint8Array.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0, 0xaa, 0xff, 0xd9]));
    const { bytes, removed } = stripImageMetadata(withThumbnail);
    expect(removed).toEqual(['JFIF-thumbnail']);
    expect(contains(bytes, 'miniatura')).toBe(false);
    expect(Array.from(bytes.slice(2, 4))).toEqual([0xff, 0xe0]);
    expect(Array.from(bytes.slice(4, 6))).toEqual([0x00, 0x10]);
    expect(Array.from(bytes.slice(18, 20))).toEqual([0x00, 0x00]);
  });

  it('un PNG con un bloque crítico desconocido y un WebP animado se rechazan; la lista de bloques quitados está acotada', () => {
    expect(() => stripImageMetadata(concat(PNG_HEAD, pngChunk('IHDR', new Uint8Array(13)), pngChunk('XMPS', text('Maria')), pngChunk('IEND')))).toThrow(ImageMetadataError);
    expect(() => stripImageMetadata(webp(webpChunk('VP8X', Uint8Array.from([0b00000010, 0, 0, 0, 1, 0, 0, 1, 0, 0])), webpChunk('ANIM', Uint8Array.from([0, 0, 0, 0, 0, 0])), webpChunk('ANMF', text('fotograma'))))).toThrow(ImageMetadataError);
    const many = Array.from({ length: 5000 }, () => segment(0xef, new Uint8Array()));
    const { removed } = stripImageMetadata(jpeg(...many));
    expect(removed).toEqual(['APP15']);
    const pngNames = Array.from({ length: 300 }, (_, index) => pngChunk(`a${String.fromCharCode(97 + (index % 26))}${String.fromCharCode(97 + Math.floor(index / 26))}b`));
    expect(stripImageMetadata(concat(PNG_HEAD, pngChunk('IHDR', new Uint8Array(13)), ...pngNames, pngChunk('IDAT', text('x')), pngChunk('IEND'))).removed.length).toBeLessThanOrEqual(20);
  });

  it('un fichero que no es una imagen admitida se rechaza', () => {
    expect(() => stripImageMetadata(text('%PDF-1.7 hola'))).toThrow(ImageMetadataError);
    expect(() => stripImageMetadata(new Uint8Array())).toThrow(ImageMetadataError);
  });
});

describe('reglas del buzón de ideas (QA-F09)', () => {
  it('el alias es siempre #FAM-NNNN con cuatro cifras, nunca texto libre', () => {
    for (let index = 0; index < 500; index += 1) expect(generateIdeaAlias()).toMatch(/^#FAM-[1-9]\d{3}$/);
    expect(generateIdeaAlias(() => 0)).toBe('#FAM-1000');
    expect(generateIdeaAlias(() => 8999)).toBe('#FAM-9999');
    expect(isIdeaAlias('#FAM-1234')).toBe(true);
    expect(isIdeaAlias('Mamá de Lucas 3ºB')).toBe(false);
  });

  it('un alias antiguo («Código #FAM-8492») se enseña como #FAM-8492; sin patrón, nada del texto original', () => {
    expect(displayIdeaAlias('Código #FAM-8492')).toBe('#FAM-8492');
    expect(displayIdeaAlias('#FAM-0001')).toBe('#FAM-0001');
    expect(displayIdeaAlias('Mamá de Lucas 3ºB')).toBe('#FAM-0000');
  });

  it('también se quitan los rellenos invisibles (Hangul, selectores de variación) y las cadenas de marcas combinantes', () => {
    expect(cleanIdeaText('Fuenteㅤᅟᅠ de agua️')).toBe('Fuente de agua');
    expect(proposeIdeaSchema.safeParse({ orgSlug: 'x', title: 'ㅤㅤㅤㅤㅤㅤㅤㅤㅤ', category: 'Cultura', description: 'Una explicación suficientemente larga.' }).success).toBe(false);
    expect(cleanIdeaText('à́̂̃̄̅b')).toHaveLength(4);
  });

  it('el texto se limpia: sin caracteres invisibles ni de dirección, espacios y saltos colapsados', () => {
    expect(cleanIdeaText('  Fuentes‮  de​ agua \n\n  fresca  ')).toBe('Fuentes de agua fresca');
  });

  it('valida la propuesta: título, tipo y explicación con sus límites, sobre el texto ya limpio', () => {
    const base = { orgSlug: 'cervantes', title: 'Fuentes de agua fresca', category: 'Patios y Deporte', description: 'Los niños rellenarían sus cantimploras en el patio.' };
    expect(proposeIdeaSchema.safeParse(base).success).toBe(true);
    expect(proposeIdeaSchema.safeParse({ ...base, title: 'Corto' }).success).toBe(false);
    expect(proposeIdeaSchema.safeParse({ ...base, title: '​​​​​​​​​' }).success).toBe(false);
    expect(proposeIdeaSchema.safeParse({ ...base, description: 'x'.repeat(IDEA_DESCRIPTION_MAX + 1) }).success).toBe(false);
    expect(proposeIdeaSchema.safeParse({ ...base, category: '' }).success).toBe(false);
  });

  it('el quórum cuenta solo las firmas verificadas y los días restantes se redondean hacia arriba', () => {
    const now = new Date('2026-11-06T12:00:00Z');
    const idea = (verifiedVotes: number, hours: number) => ({ verifiedVotes, expiresAt: new Date(now.getTime() + hours * 3_600_000) });
    expect(ideaProgress(idea(27, 24 * 10), 30, now)).toEqual({ percent: 90, quorumReached: false, daysRemaining: 10 });
    expect(ideaProgress(idea(30, 5), 30, now)).toEqual({ percent: 100, quorumReached: true, daysRemaining: 1 });
    expect(ideaProgress(idea(45, -3), 30, now)).toEqual({ percent: 100, quorumReached: true, daysRemaining: 0 });
    expect(ideaProgress(idea(0, 1), 0, now).percent).toBe(0);
  });

  it('qué ofrece cada tarjeta: firmar, ya firmada o cerrada', () => {
    const now = new Date('2026-11-06T12:00:00Z');
    const future = new Date(now.getTime() + 86_400_000);
    const past = new Date(now.getTime() - 1);
    expect(ideaAction('PUBLIC_VOTING', false, future, now)).toBe('SIGN');
    expect(ideaAction('PUBLIC_VOTING', true, future, now)).toBe('SIGNED');
    expect(ideaAction('PUBLIC_VOTING', false, past, now)).toBe('CLOSED');
    expect(ideaAction('DOUBLE_CHECK', false, future, now)).toBe('CLOSED');
    expect(ideaAction('DOUBLE_CHECK', true, future, now)).toBe('SIGNED');
  });

  it('las categorías de una idea excluyen la de taquilla y rifas', () => {
    expect(ideaCategories([{ name: 'Patios y Deporte', icon: '⚽' }, { name: 'Taquilla y Rifas', icon: '🎟️' }]).map((category) => category.name)).toEqual(['Patios y Deporte']);
  });
});

describe('IP de confianza del proxy (heredado del 2.2)', () => {
  const read = (headers: Record<string, string>) => (name: string) => headers[name];

  it('prefiere la cabecera que fija la plataforma y descarta valores que no son una IP', () => {
    expect(trustedClientIp(read({ 'x-vercel-forwarded-for': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' }), { vercel: true })).toBe('203.0.113.7');
    // Fuera de Vercel esa cabecera la puede enviar cualquiera: no se tiene en cuenta.
    expect(trustedClientIp(read({ 'x-vercel-forwarded-for': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' }), { vercel: false })).toBe('198.51.100.1');
    expect(trustedClientIp(read({ 'x-real-ip': '203.0.113.9' }))).toBe('203.0.113.9');
    expect(trustedClientIp(read({ 'x-forwarded-for': '2001:db8::1, 10.0.0.1' }))).toBe('2001:db8::1');
    expect(trustedClientIp(read({ 'x-vercel-forwarded-for': 'no-es-una-ip', 'x-real-ip': '203.0.113.9' }), { vercel: true })).toBe('203.0.113.9');
  });

  it('sin una IP válida devuelve null (quien llama avisa a la consola)', () => {
    expect(trustedClientIp(read({}))).toBeNull();
    expect(trustedClientIp(read({ 'x-forwarded-for': 'unknown' }))).toBeNull();
    expect(trustedClientIp(read({ 'x-forwarded-for': '<script>' }))).toBeNull();
  });
});

describe('consola: cada tipo de alerta tiene su texto en los tres idiomas', () => {
  it('incluido TRUSTED_IP_MISSING (la consola pinta `alertType.<TIPO>` y una clave que falta rompería la página)', async () => {
    const { OpsAlertType } = await import('@/generated/prisma/enums');
    for (const locale of ['es', 'ca', 'en']) {
      const catalog = (await import(`../../messages/${locale}.json`)).default as { admin: { alertType: Record<string, string> } };
      for (const type of Object.values(OpsAlertType)) expect(catalog.admin.alertType[type], `${locale}: ${type}`).toBeTruthy();
    }
  });
});
