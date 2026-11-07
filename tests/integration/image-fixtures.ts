/** Imágenes mínimas para las pruebas de fotos: un JPEG con EXIF (ubicación, modelo y autor reconocibles) y un PNG con texto. */

const text = (value: string) => Uint8Array.from(Buffer.from(value, 'latin1'));
const concat = (...parts: Uint8Array[]) => Uint8Array.from(Buffer.concat(parts));
const u16 = (value: number) => Uint8Array.from([value >> 8, value & 255]);
const segment = (marker: number, payload: Uint8Array) => concat(Uint8Array.from([0xff, marker]), u16(payload.length + 2), payload);

export const SECRET_MARKERS = ['GPSLatitude=40.4168', 'Make=Pixel 9', 'Author=Maria Lopez'] as const;

export function jpegWithExif(orientation = 6): Uint8Array {
  const tiff = concat(
    text('II'), Uint8Array.from([0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00]),
    Uint8Array.from([0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    text(SECRET_MARKERS.join(';'))
  );
  return concat(
    Uint8Array.from([0xff, 0xd8]),
    segment(0xe0, text('JFIF\0\x01\x01\0\0\x01\0\x01\0\0')),
    segment(0xe1, concat(text('Exif\0\0'), tiff)),
    segment(0xfe, text('Hecha por Maria Lopez')),
    segment(0xdb, Uint8Array.from([0, 1, 2, 3])),
    Uint8Array.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0, 0xaa, 0xbb, 0xcc, 0xff, 0xd9])
  );
}

export const containsText = (bytes: Uint8Array, needle: string) => Buffer.from(bytes).includes(Buffer.from(needle, 'latin1'));
