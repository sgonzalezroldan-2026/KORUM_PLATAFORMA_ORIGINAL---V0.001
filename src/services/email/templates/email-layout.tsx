import type { CSSProperties, ReactElement } from 'react';
import type { EmailContent } from './email-content';

/**
 * Diseño único de los emails de KORUM (Escudo Varsity Heritage): cabecera azul marino con acento dorado, cuerpo en papel cálido y pie
 * legal. Solo HTML de tablas y estilos en línea, con colores sólidos: es lo que soportan todos los clientes de correo. El logotipo de la
 * cabecera se dibuja con HTML (sin imagen), así que no depende de que el cliente cargue imágenes ni de un PNG; el vectorial definitivo
 * lo sustituirá cuando el promotor lo aporte. Los textos llegan traducidos en `labels`: aquí no hay ningún literal.
 */

const NAVY = '#101F38';
const GOLD = '#F59E0B';
const EMERALD = '#047857';
const PAPER = '#FBF7EE';
const INK = '#1F2937';
const MUTED = '#4B5563';
const FONT = "'Plus Jakarta Sans', Arial, Helvetica, sans-serif";
const BRAND_NAME = 'KORUM';

export interface EmailLayoutLabels {
  tagline: string;
  buttonFallback: string;
  footer: string;
  platform: string;
  logoLabel: string;
}

const cell = (style: CSSProperties): CSSProperties => ({ fontFamily: FONT, ...style });

export function EmailLayout({ content, labels, locale }: { content: EmailContent; labels: EmailLayoutLabels; locale: string }): ReactElement {
  return (
    <html lang={locale}>
      {/* eslint-disable-next-line @next/next/no-head-element -- documento de email completo: no es una página de Next */}
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light" />
        <title>{content.subject}</title>
      </head>
      <body style={{ margin: 0, padding: 0, backgroundColor: PAPER }}>
        <div style={{ display: 'none', maxHeight: 0, overflow: 'hidden', opacity: 0 }}>{content.preheader}</div>
        <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} style={{ backgroundColor: PAPER }}>
          <tbody>
            <tr>
              <td align="center" style={{ padding: '24px 12px' }}>
                <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} style={{ maxWidth: 560, backgroundColor: '#FFFFFF', border: '1px solid #E5DFD0', borderRadius: 12 }}>
                  <tbody>
                    <tr>
                      <td role="img" aria-label={labels.logoLabel} style={cell({ backgroundColor: NAVY, borderBottom: `4px solid ${GOLD}`, borderRadius: '12px 12px 0 0', padding: '20px 28px' })}>
                        <span style={{ color: '#FFFFFF', fontSize: 24, fontWeight: 800, letterSpacing: 4 }}>{BRAND_NAME}</span>
                        <br />
                        <span style={{ color: GOLD, fontSize: 13 }}>{labels.tagline}</span>
                      </td>
                    </tr>
                    <tr>
                      <td style={cell({ padding: '28px 28px 8px', color: INK })}>
                        <h1 style={{ margin: '0 0 16px', fontSize: 24, lineHeight: '30px', color: NAVY }}>{content.title}</h1>
                        {content.paragraphs.map((paragraph) => (
                          <p key={paragraph} style={{ margin: '0 0 14px', fontSize: 16, lineHeight: '24px' }}>
                            {paragraph}
                          </p>
                        ))}
                      </td>
                    </tr>
                    {content.highlight ? (
                      <tr>
                        <td align="center" style={cell({ padding: '4px 28px 12px' })}>
                          <p style={{ margin: '0 0 6px', fontSize: 14, color: MUTED }}>{content.highlight.label}</p>
                          <p style={{ margin: 0, fontSize: 36, lineHeight: '44px', fontWeight: 800, letterSpacing: 8, color: NAVY, fontVariantNumeric: 'tabular-nums' }}>{content.highlight.value}</p>
                        </td>
                      </tr>
                    ) : null}
                    {content.facts.length > 0 ? (
                      <tr>
                        <td style={{ padding: '0 28px 8px' }}>
                          <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} style={{ backgroundColor: PAPER, borderLeft: `4px solid ${EMERALD}`, borderRadius: 6 }}>
                            <tbody>
                              {content.facts.map((fact) => (
                                <tr key={`${fact.label}:${fact.value}`}>
                                  <td style={cell({ padding: '8px 12px', fontSize: 14, color: MUTED, width: '42%', verticalAlign: 'top' })}>{fact.label}</td>
                                  <td style={cell({ padding: '8px 12px', fontSize: 15, color: INK, fontWeight: 700, fontVariantNumeric: 'tabular-nums', verticalAlign: 'top' })}>{fact.value}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    ) : null}
                    {content.button ? (
                      <tr>
                        <td align="center" style={cell({ padding: '20px 28px 8px' })}>
                          <a href={content.button.url} style={{ display: 'inline-block', backgroundColor: NAVY, color: '#FFFFFF', fontSize: 16, fontWeight: 700, textDecoration: 'none', padding: '12px 28px', lineHeight: '20px', borderRadius: 8 }}>
                            {content.button.label}
                          </a>
                          <p style={{ margin: '14px 0 0', fontSize: 12, lineHeight: '18px', color: MUTED }}>
                            {labels.buttonFallback}
                            <br />
                            <a href={content.button.url} style={{ color: EMERALD, wordBreak: 'break-all' }}>
                              {content.button.url}
                            </a>
                          </p>
                        </td>
                      </tr>
                    ) : null}
                    {content.footnote ? (
                      <tr>
                        <td style={cell({ padding: '16px 28px 0', fontSize: 14, lineHeight: '21px', color: MUTED })}>{content.footnote}</td>
                      </tr>
                    ) : null}
                    <tr>
                      <td style={cell({ padding: '24px 28px', fontSize: 12, lineHeight: '18px', color: MUTED })}>
                        <p style={{ margin: '0 0 8px' }}>{labels.footer}</p>
                        <p style={{ margin: 0 }}>{labels.platform}</p>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>
      </body>
    </html>
  );
}
