import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EmailMessage, EmailProvider, EmailSendResult } from './email-provider';

/**
 * Modo vista previa (desarrollo, pruebas y entorno con `PAYCOMET_MODE=mock`): no envía nada a nadie. Guarda cada mensaje como `.html`
 * y `.txt` en `.email-preview/` (carpeta ignorada por git) para abrirlo en el navegador, y los adjuntos junto a ellos. Es la forma de
 * construir y revisar los emails sin cuenta del proveedor, SPF, DKIM ni DMARC.
 */
export class PreviewEmailProvider implements EmailProvider {
  readonly name = 'preview';
  /** Mensajes «enviados» en este proceso: los tests los leen sin tocar el disco. */
  readonly sent: EmailMessage[] = [];

  constructor(private readonly options: { directory?: string; writeFiles?: boolean } = {}) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    this.sent.push(message);
    const id = `preview-${createHash('sha256').update(message.idempotencyKey).digest('hex').slice(0, 16)}`;
    // En Vercel el disco es de solo lectura, y en producción los enlaces y códigos de un solo uso no deben quedar en ficheros.
    // `KORUM_EMAIL_PREVIEW_FILES=1` solo lo pone el servidor de las pruebas de navegador sobre la compilación de producción (`next start`,
    // como la CI), que necesita leer los códigos de acceso; en Vercel nunca se escribe.
    const testServer = process.env.KORUM_EMAIL_PREVIEW_FILES === '1';
    const canWrite = this.options.writeFiles ?? (!process.env.VERCEL && (process.env.NODE_ENV !== 'production' || testServer));
    if (!canWrite) return { providerMessageId: id };

    const directory = this.options.directory ?? path.join(process.cwd(), '.email-preview');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${id}.html`), message.html, 'utf8');
    await writeFile(path.join(directory, `${id}.txt`), `Para: ${message.to}\nDe: ${message.fromName} <${message.fromAddress}>\nAsunto: ${message.subject}\n\n${message.text}`, 'utf8');
    for (const attachment of message.attachments ?? []) {
      await writeFile(path.join(directory, `${id}-${path.basename(attachment.filename)}`), Buffer.from(attachment.contentBase64, 'base64'));
    }
    return { providerMessageId: id };
  }
}
