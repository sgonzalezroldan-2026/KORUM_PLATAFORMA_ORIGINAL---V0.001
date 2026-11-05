import QRCode from 'qrcode';
import type { EmailAttachment } from '../email-provider';

/**
 * Adjuntos de la entrada: el QR como PNG (los clientes de correo no pintan SVG) y, en eventos, un `.ics` de día completo para el
 * calendario. Los dos pesan unos pocos KB; el catálogo prohíbe los adjuntos pesados. El QR se compone aquí, al enviar, a partir del
 * contenido firmado (`buildPassQrPayload`): el mensaje de la bandeja guarda solo el identificador del pase, nunca el QR.
 */

const QR_WIDTH_PX = 320;

export async function buildQrAttachment(qrPayload: string, filename: string): Promise<EmailAttachment> {
  const png = await QRCode.toBuffer(qrPayload, { type: 'png', width: QR_WIDTH_PX, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#101F38', light: '#FFFFFF' } });
  return { filename, contentType: 'image/png', contentBase64: png.toString('base64') };
}

const escapeIcs = (text: string) => text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
/** Día natural en Europe/Madrid (el mismo que muestra el email), como AAAAMMDD; `plusDays` salta de día sin pasar por la hora. */
function madridDay(date: Date, plusDays = 0): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).map((part) => [part.type, part.value]));
  const day = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + plusDays));
  return day.toISOString().slice(0, 10).replaceAll('-', '');
}

/** Evento de día completo (la ficha de la iniciativa solo guarda la fecha del evento, no la hora). */
export function buildCalendarAttachment(input: { uid: string; summary: string; location: string | null; date: Date; stamp: Date; filename: string }): EmailAttachment {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//KORUM//Entradas//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${input.uid}@korum`,
    `DTSTAMP:${input.stamp.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
    `DTSTART;VALUE=DATE:${madridDay(input.date)}`,
    `DTEND;VALUE=DATE:${madridDay(input.date, 1)}`,
    `SUMMARY:${escapeIcs(input.summary)}`,
    ...(input.location ? [`LOCATION:${escapeIcs(input.location)}`] : []),
    'END:VEVENT',
    'END:VCALENDAR'
  ];
  return { filename: input.filename, contentType: 'text/calendar', contentBase64: Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8').toString('base64') };
}
