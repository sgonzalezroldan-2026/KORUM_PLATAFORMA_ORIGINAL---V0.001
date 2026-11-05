import { render } from '@react-email/render';
import { InvalidPayloadError, TEMPLATE_CATALOG } from './templates/catalog';
import type { EmailContent, TemplateContext } from './templates/email-content';
import { EmailLayout } from './templates/email-layout';
import { buildPublicUrl, createEmailFormatters, createEmailTranslator, type EmailLocale } from './templates/translator';
import type { EmailAttachment } from './email-provider';

/**
 * Compone un email completo (asunto, HTML, texto plano y adjuntos) a partir de una plantilla del catálogo y su payload. Es una función
 * pura salvo por el QR (que se genera aquí): no lee la base de datos. Quien llama le da ya resueltas la entidad y la iniciativa
 * (`outbox-context.ts`), así que se puede probar sin base de datos y previsualizar en desarrollo.
 */

const FOOTER_KEYS = { transactional: 'common.footerTransactional', organization: 'common.footerOrganization', account: 'common.footerAccount' } as const;

export class UnknownTemplateError extends Error {
  constructor(templateKey: string) {
    super(`No existe la plantilla de email «${templateKey}».`);
    this.name = 'UnknownTemplateError';
  }
}

export interface RenderEmailInput {
  templateKey: string;
  locale: EmailLocale;
  payload: unknown;
  createdAt: Date;
  appUrl: string;
  organization?: TemplateContext['organization'];
  initiative?: TemplateContext['initiative'];
  qrSecret?: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  attachments: EmailAttachment[];
  /** Nombre de la entidad para el remitente «{Entidad} vía KORUM». */
  senderName: string | undefined;
}

/** Texto plano equivalente: mismo contenido y orden que el HTML, sin adornos. */
export function toPlainText(content: EmailContent, footer: { footer: string; platform: string }): string {
  const blocks = [content.title, ...content.paragraphs];
  if (content.highlight) blocks.push(`${content.highlight.label}: ${content.highlight.value}`);
  if (content.facts.length > 0) blocks.push(content.facts.map((fact) => `${fact.label}: ${fact.value}`).join('\n'));
  if (content.button) blocks.push(`${content.button.label}: ${content.button.url}`);
  if (content.footnote) blocks.push(content.footnote);
  blocks.push('--', footer.footer, footer.platform);
  return `${blocks.join('\n\n')}\n`;
}

export async function renderEmail(input: RenderEmailInput): Promise<RenderedEmail> {
  const template = TEMPLATE_CATALOG.get(input.templateKey);
  if (!template) throw new UnknownTemplateError(input.templateKey);

  const t = createEmailTranslator(input.locale);
  const context: TemplateContext = {
    locale: input.locale,
    t,
    ...createEmailFormatters(input.locale),
    url: (path) => buildPublicUrl(input.appUrl, input.locale, path),
    createdAt: input.createdAt,
    ...(input.organization ? { organization: input.organization } : {}),
    ...(input.initiative ? { initiative: input.initiative } : {}),
    ...(input.qrSecret ? { qrSecret: input.qrSecret } : {})
  };
  const content = await template.build(input.payload, context);

  const labels = {
    tagline: t('common.tagline'),
    buttonFallback: t('common.buttonFallback'),
    footer: t(FOOTER_KEYS[content.footer], { organization: input.organization?.name ?? '' }),
    platform: t('common.footerPlatform'),
    logoLabel: t('common.logoLabel')
  };
  const html = await render(<EmailLayout content={content} labels={labels} locale={input.locale} />);
  return {
    subject: content.subject,
    html,
    text: toPlainText(content, labels),
    attachments: content.attachments ?? [],
    senderName: input.organization ? t('common.senderName', { organization: input.organization.name }) : undefined
  };
}

export { InvalidPayloadError };
