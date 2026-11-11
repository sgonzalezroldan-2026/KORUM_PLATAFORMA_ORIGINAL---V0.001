/**
 * Imágenes para las pruebas de fotos: un JPEG con EXIF (ubicación, modelo y autor reconocibles) y un comentario. Desde el Sprint 4.4c las fotos se
 * recodifican con `sharp`, así que el JPEG ya no es un esqueleto: parte de uno real de 24×16 píxeles (el EXIF y el comentario se le añaden detrás de la
 * marca de inicio, que es donde los pone una cámara).
 */
export const REAL_JPEG_BASE64 =
  '/9j/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAQABgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAT/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCYALE4AD//2Q==';
export const REAL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAIAAACDRijCAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAIElEQVQ4jWP4Oo+bKohh1KCvo2H0dTQdzRvNIvPITwcAXqZtH1gKEz4AAAAASUVORK5CYII=';

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
    // El resto del JPEG real, sin su marca de inicio.
    Uint8Array.from(Buffer.from(REAL_JPEG_BASE64, 'base64')).subarray(2)
  );
}

export const containsText = (bytes: Uint8Array, needle: string) => Buffer.from(bytes).includes(Buffer.from(needle, 'latin1'));
