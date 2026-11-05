import { EmailConfigurationError, EmailSendError, type EmailMessage, type EmailProvider, type EmailSendResult } from './email-provider';

/**
 * Adaptador de Brevo (API transaccional v3). Suposición contra su documentación pública, sin cuenta real todavía: `POST /v3/smtp/email`
 * con la cabecera `api-key` y respuesta `{ messageId }`. Queda anotado en la bitácora hasta probarlo con una cuenta de verdad.
 *
 * Clasificación de errores: `400` (mensaje o dirección inválidos) es permanente; `401`/`403` (clave o remitente rechazados) son de
 * configuración (`EmailConfigurationError`: la bandeja aplaza los mensajes sin gastar intentos y avisa al Super-Admin); `429`, `5xx` y
 * los cortes de red son transitorios y se reintentan. Suposición: Brevo también puede devolver `400` por un remitente sin validar; si
 * ocurre con una cuenta real habrá que distinguirlo por el código del cuerpo (bitácora 2.6).
 */
const ENDPOINT = 'https://api.brevo.com/v3/smtp/email';
const TIMEOUT_MS = 10_000;

export class BrevoEmailProvider implements EmailProvider {
  readonly name = 'brevo';

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { 'api-key': this.apiKey, 'content-type': 'application/json', accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify({
          sender: { name: message.fromName, email: message.fromAddress },
          to: [{ email: message.to }],
          ...(message.replyTo ? { replyTo: { email: message.replyTo } } : {}),
          subject: message.subject,
          htmlContent: message.html,
          textContent: message.text,
          ...(message.attachments?.length ? { attachment: message.attachments.map((file) => ({ name: file.filename, content: file.contentBase64 })) } : {}),
          headers: { 'X-Korum-Idempotency': message.idempotencyKey }
        })
      });
    } catch {
      throw new EmailSendError('Brevo no respondió (corte de red o tiempo agotado).', false);
    }

    // Clave de API revocada o remitente no autorizado: lo arregla quien administra la cuenta y los mensajes deben esperar, no perderse.
    if (response.status === 401 || response.status === 403) throw new EmailConfigurationError(['email.apiKey (Brevo la ha rechazado)']);
    if (!response.ok) {
      // El cuerpo de error puede repetir la dirección del destinatario: solo se conserva el código.
      throw new EmailSendError(`Brevo respondió ${response.status}.`, response.status === 400);
    }
    const body = (await response.json().catch(() => null)) as { messageId?: unknown } | null;
    if (!body || typeof body.messageId !== 'string') throw new EmailSendError('Brevo aceptó el mensaje pero no devolvió su identificador.', false);
    return { providerMessageId: body.messageId };
  }
}
