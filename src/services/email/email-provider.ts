/**
 * Interfaz común de los proveedores de email (DECISIONES_TECNICAS §4). El resto del código solo conoce `EmailProvider`: cambiar de
 * proveedor (Brevo, SMTP, el modo de vista previa local) no toca la bandeja de salida ni las plantillas.
 */

export interface EmailAttachment {
  filename: string;
  contentType: string;
  /** Contenido en base64. */
  contentBase64: string;
}

export interface EmailMessage {
  to: string;
  fromAddress: string;
  fromName: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
  /** Identifica el envío. Brevo no deduplica por él: el envío es «al menos una vez» y un duplicado reenvía el mismo contenido. */
  idempotencyKey: string;
}

export interface EmailSendResult {
  providerMessageId: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<EmailSendResult>;
}

/**
 * Fallo de envío. `permanent` indica que reintentar no sirve (dirección inválida, mensaje rechazado): la bandeja lo marca como
 * fallido de inmediato. Los transitorios (red, 429, 5xx) y los de configuración (clave rechazada) se reintentan con espera.
 */
export class EmailSendError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean
  ) {
    super(message);
    this.name = 'EmailSendError';
  }
}

export class EmailConfigurationError extends Error {
  constructor(missing: string[]) {
    super(`Falta configuración de email: ${missing.join(', ')}. Configúrala en /admin/ajustes.`);
    this.name = 'EmailConfigurationError';
  }
}
