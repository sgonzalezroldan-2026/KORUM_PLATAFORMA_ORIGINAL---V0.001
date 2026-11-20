import { useFormatter, useTranslations } from 'next-intl';
import { CurrencyText } from '@/components/ui/currency-text';
import { EmptyState } from '@/components/ui/empty-state';
import { Link } from '@/i18n/navigation';
import { initiativePath } from '@/lib/seo/portal-routes';
import type { AccountOverview } from '@/repositories/account.repository';

/**
 * Historial de *Mi cuenta*: aportaciones y compras, y entradas (Sprint 3.7). Cada fila dice en texto su estado (nunca solo con color).
 * El enlace de cada pase lleva la firma **de vista** (`signPassView`), la misma que el email y la pantalla del pago: nunca la del QR de la puerta.
 */

const sectionClass = 'korum-trust-vault flex scroll-mt-4 flex-col gap-4 p-5';
const headingClass = 'font-corp text-2xl font-extrabold text-varsity-navy';
const DATE = { dateStyle: 'medium', timeZone: 'Europe/Madrid' } as const;

export function AccountContributions({ contributions }: { contributions: AccountOverview['contributions'] }) {
  const t = useTranslations('account.contributions');
  const format = useFormatter();

  return (
    <section id="contributions" aria-labelledby="contributions-title" className={sectionClass}>
      <h2 id="contributions-title" className={headingClass}>
        {t('title')}
      </h2>
      {contributions.length === 0 ? (
        <EmptyState icon="💛" title={t('emptyTitle')} description={t('emptyText')} action={<Link href="/" className="tactile-btn">{t('emptyAction')}</Link>} headingLevel={3} />
      ) : (
        <ul className="flex flex-col divide-y divide-varsity-navy/10">
          {contributions.map((row) => (
            <li key={row.id} className="mobile-stack grid gap-2 py-3 md:grid-cols-[1fr_auto] md:items-center">
              <div className="min-w-0">
                <Link href={initiativePath(row.organization.slug, row.initiative.id)} className="inline-flex min-h-11 items-center font-bold text-varsity-navy underline underline-offset-4 hover:text-varsity-emerald">
                  {row.initiative.title}
                </Link>
                <p className="text-sm text-ink-soft">
                  {t('line', { organization: row.organization.name, date: format.dateTime(row.createdAt, DATE), type: t(`type.${contributionKind(row)}`) })}
                </p>
                {row.guaranteeContributionCents > 0 ? <p className="text-sm text-ink-soft">{t('includesGuarantee')}</p> : null}
              </div>
              <div className="flex flex-wrap items-center gap-3 md:justify-end">
                <CurrencyText cents={row.totalChargedCents} className="text-lg font-extrabold text-varsity-navy" />
                <span className="rounded-full bg-varsity-ivory px-3 py-1 text-sm font-bold text-varsity-navy" data-status={row.status}>
                  {t(`status.${row.status}`)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Cómo se nombra cada fila: una compra de vales y una aportación «sin producto» no son «entradas» (Sprint 5.14b). */
function contributionKind(row: AccountOverview['contributions'][number]): 'DONATION' | 'TICKET' | 'VOUCHER' | 'NO_PRODUCT' {
  if (row.voucherNoProduct) return 'NO_PRODUCT';
  if (row.type === 'TICKET' && row.initiative.ticketSubtype === 'VOUCHER') return 'VOUCHER';
  return row.type === 'TICKET' ? 'TICKET' : 'DONATION';
}

type PassRow = AccountOverview['passes'][number] & { href: string };

export function AccountPasses({ passes }: { passes: PassRow[] }) {
  const t = useTranslations('account.passes');
  const format = useFormatter();

  return (
    <section id="passes" aria-labelledby="passes-title" className={sectionClass}>
      <h2 id="passes-title" className={headingClass}>
        {t('title')}
      </h2>
      {passes.length === 0 ? (
        <EmptyState icon="🎟️" title={t('emptyTitle')} description={t('emptyText')} headingLevel={3} />
      ) : (
        <ul className="mobile-stack grid gap-4 md:grid-cols-2">
          {passes.map((pass) => (
            <li key={pass.uuid} className="flex flex-col gap-2 rounded-2xl border-2 border-varsity-navy/15 bg-white p-4" data-pass-kind={pass.subtype}>
              <p className="font-bold text-varsity-navy">{pass.initiative.title}</p>
              {pass.subtype === 'VOUCHER' ? (
                <>
                  <p className="text-sm text-ink-soft">
                    {pass.initiative.voucherValidUntil
                      ? t('voucherWhere', { organization: pass.initiative.organization.name, date: format.dateTime(pass.initiative.voucherValidUntil, DATE) })
                      : pass.initiative.organization.name}
                  </p>
                  <p className="text-sm font-semibold text-varsity-navy">{t('voucherBalance', { balance: Math.max(0, pass.quantity - pass.checkedInCount), total: pass.quantity })}</p>
                </>
              ) : (
                <>
                  <p className="text-sm text-ink-soft">{t('where', { organization: pass.initiative.organization.name, date: format.dateTime(pass.initiative.closesAt, DATE) })}</p>
                  {pass.initiative.ticketVenue ? <p className="text-sm text-ink-soft">{pass.initiative.ticketVenue}</p> : null}
                  <p className="text-sm font-semibold text-varsity-navy">
                    {t('quantity', { count: pass.quantity })}
                  </p>
                </>
              )}
              <p className="font-mono text-sm text-ink-soft">{t('serial', { serial: pass.serialCode })}</p>
              {pass.revokedAt ? (
                <p className="rounded-xl bg-red-50 px-3 py-2 text-sm font-bold text-red-900">{t(pass.subtype === 'VOUCHER' ? 'revokedVouchers' : 'revoked')}</p>
              ) : (
                <Link href={pass.href} className="tactile-btn justify-center">
                  <span aria-hidden="true">{pass.subtype === 'VOUCHER' ? '🧾 ' : '🎟️ '}</span>
                  {t(pass.subtype === 'VOUCHER' ? 'viewVouchers' : 'viewEvent')}
                  {/* El nombre accesible empieza por el texto visible (WCAG 2.5.3) y añade de qué evento es: hay un botón igual por entrada. */}
                  {' '}
                  <span className="sr-only">{`· ${pass.initiative.title}`}</span>
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
