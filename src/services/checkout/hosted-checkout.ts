import { isTrustedChallengeUrl, signCheckoutResult, signPaymentSimulator } from '@/core/checkout/checkout-rules';
import { absoluteUrl, localizedPath } from '@/lib/seo/marketing-routes';
import { checkoutResultPath, paymentSimulatorPath } from '@/lib/seo/portal-routes';
import { PaymentProviderError, type PaymentProvider } from '@/services/payments/payment-provider';

/**
 * Envío a la página de pago de Paycomet, común al checkout de familias y al patrocinio de comercios. Devuelve la dirección a la que enviar a la
 * persona o `null` si no hay una página de pago fiable (entonces quien llama deja el pago como fallido). Solo se redirige a `https://*.paycomet.com`.
 */
export async function startHostedRedirect(
  provider: PaymentProvider,
  hmacSecret: string,
  input: {
    order: string;
    totalChargedCents: number;
    method: 'CARD' | 'BIZUM';
    orgSlug: string;
    initiativeId: number;
    locale: 'es' | 'ca' | 'en';
    ip: string | null;
    /** Vuelta propia (Mi Hucha vuelve a `/mi-hucha`); por defecto, la pantalla de resultado del checkout con su firma. */
    returnUrl?: string;
    /** Primer pago de una aportación mensual: Paycomet guarda la tarjeta. */
    saveCard?: boolean;
  }
): Promise<string | null> {
  const query = (signature: string) => `?${new URLSearchParams({ pedido: input.order, sig: signature }).toString()}`;
  const resultUrl = input.returnUrl ?? `${absoluteUrl(input.locale, checkoutResultPath(input.orgSlug, input.initiativeId))}${query(signCheckoutResult(hmacSecret, input.order))}`;
  try {
    const hosted = await provider.startHostedPayment({
      order: input.order,
      amountCents: input.totalChargedCents,
      method: input.method,
      originalIp: input.ip ?? '0.0.0.0',
      locale: input.locale,
      urlOk: resultUrl,
      urlKo: resultUrl,
      ...(input.saveCard ? { saveCard: true } : {})
    });
    if (provider.mode === 'mock') {
      return `${localizedPath(input.locale, paymentSimulatorPath(input.orgSlug, input.initiativeId))}${query(signPaymentSimulator(hmacSecret, input.order))}`;
    }
    if (hosted.challengeUrl && isTrustedChallengeUrl(hosted.challengeUrl)) return hosted.challengeUrl;
  } catch (error) {
    if (!(error instanceof PaymentProviderError)) throw error;
  }
  return null;
}
