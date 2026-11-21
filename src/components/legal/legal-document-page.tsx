import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { JsonLd } from '@/components/seo/json-ld';
import { legalPathOf, type LegalDocument } from '@/core/legal/legal-catalog';
import { parseLegalMarkdownCached, plainText } from '@/core/legal/legal-markdown';
import { Link } from '@/i18n/navigation';
import { isLocale } from '@/i18n/routing';
import { getPrisma } from '@/lib/prisma';
import { breadcrumbJsonLd } from '@/lib/seo/json-ld';
import { buildPageMetadata } from '@/lib/seo/metadata';
import { localizedPath } from '@/lib/seo/marketing-routes';
import { loadLegalPage } from '@/services/legal/legal-page-data';
import { Blocks } from './legal-markdown';

/**
 * Página pública de un texto legal (Sprint 5.10a, `QA-LEG01`): la versión vigente en el idioma de la página o, si aún no está traducida (o su traducción se ha
 * quedado atrás), la del castellano con un aviso (decisión 85); su versión, su fecha, qué cambia y su huella; y el archivo de versiones (`?version=`), que no se
 * indexa. El texto archivado ya lleva los datos de la empresa con los que se publicó: se enseña tal cual se aceptó.
 */

export type LegalPageProps = { params: Promise<{ locale: string }>; searchParams: Promise<{ version?: string | string[] }> };

const versionOf = (value: string | string[] | undefined): string | undefined => (typeof value === 'string' && value.length <= 20 ? value : undefined);

export async function legalPageMetadata(document: LegalDocument, { params, searchParams }: LegalPageProps): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const [t, marketing, query] = await Promise.all([getTranslations({ locale, namespace: 'legal' }), getTranslations({ locale, namespace: 'marketing' }), searchParams]);
  return buildPageMetadata({
    locale,
    path: legalPathOf(document),
    title: t(`titles.${document}`),
    description: t(`descriptions.${document}`),
    imageAlt: marketing('ogAlt'),
    // Una versión anterior es un archivo, no una página que tenga que salir en los buscadores.
    noindex: query.version !== undefined
  });
}

export async function LegalDocumentPage({ document, params, searchParams }: LegalPageProps & { document: LegalDocument }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);
  const data = await loadLegalPage(getPrisma(), document, locale, versionOf((await searchParams).version));
  if (!data) notFound();
  const [t, marketing] = await Promise.all([getTranslations('legal'), getTranslations('marketing')]);
  const blocks = parseLegalMarkdownCached(data.shown.contentSha256, data.shown.markdown);
  const titleBlock = blocks[0]?.type === 'heading' && blocks[0].level === 1 ? blocks[0] : null;
  const title = titleBlock ? plainText(titleBlock.inline) : t(`titles.${document}`);
  const body = titleBlock ? blocks.slice(1) : blocks;
  const path = legalPathOf(document);
  const date = (value: Date) => new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'Europe/Madrid' }).format(value);
  const notice = 'rounded-xl border-2 border-varsity-navy/20 bg-varsity-navy/5 p-4 text-sm';
  const textLocale = data.shown.locale;
  const pending = data.current.effectiveAt > new Date();
  const linkClass = 'font-semibold underline underline-offset-4';

  return (
    <div className="bg-varsity-ivory">
      <JsonLd data={[breadcrumbJsonLd(locale, [{ name: marketing('breadcrumbHome'), path: '/' }, { name: t(`titles.${document}`), path }])]} />
      <article className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10 sm:py-14" data-testid="legal-page" data-document={document} data-version={data.shown.version}>
        <header className="flex flex-col gap-3">
          <nav aria-label={marketing('breadcrumbLabel')} className="text-sm text-ink-soft">
            <ol className="flex flex-wrap items-center gap-2">
              <li>
                <Link href="/" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg underline underline-offset-4">
                  {marketing('breadcrumbHome')}
                </Link>
              </li>
              <li aria-hidden="true">{'›'}</li>
              <li aria-current="page">{t(`titles.${document}`)}</li>
            </ol>
          </nav>
          <h1 lang={textLocale === locale ? undefined : textLocale} className="font-corp text-3xl font-extrabold leading-tight text-varsity-navy sm:text-4xl">
            {title}
          </h1>
          <p className="font-corp text-sm text-ink-soft tabular-nums" data-testid="legal-version">
            {t('versionLine', { version: data.shown.version, date: date(data.shown.publishedAt) })}
          </p>
          {data.fallback && !data.archived ? (
            <p role="note" className={notice} data-testid="legal-fallback">
              {t(data.fallback === 'STALE' ? 'staleNotice' : 'fallbackNotice')}
            </p>
          ) : null}
          {data.archived ? (
            <p role="note" className={`${notice} border-amber-600/40 bg-amber-50 text-amber-950`} data-testid="legal-archived">
              {data.shownStillApplies && data.stillApplying
                ? t('stillAppliesNotice', { version: data.shown.version, date: date(data.current.effectiveAt) })
                : t('archivedNotice', { version: data.shown.version })}{' '}
              <Link href={path} className={linkClass}>
                {t('archivedCurrentLink', { version: data.current.version })}
              </Link>
            </p>
          ) : null}
          {!data.archived && data.stillApplying ? (
            <p role="note" className={notice} data-testid="legal-effective">
              {t('effectiveNotice', { date: date(data.current.effectiveAt) })}{' '}
              <a href={`${localizedPath(data.stillApplying.locale, path)}?version=${encodeURIComponent(data.stillApplying.version)}`} className={linkClass}>
                {t('effectivePreviousLink', { version: data.stillApplying.version })}
              </a>
            </p>
          ) : null}
          {data.shown.changeSummary ? (
            <div className={notice} data-testid="legal-change-summary">
              <p className="font-semibold text-varsity-navy">{t('changeSummaryTitle')}</p>
              <p lang={textLocale === locale ? undefined : textLocale}>{data.shown.changeSummary}</p>
            </div>
          ) : null}
        </header>

        <div lang={textLocale === locale ? undefined : textLocale}>
          <Blocks blocks={body} locale={locale} tableLabel={t('tableLabel')} />
        </div>

        <footer className="flex flex-col gap-3 border-t-2 border-varsity-navy/10 pt-6 text-sm">
          <h2 className="font-corp text-lg font-extrabold text-varsity-navy">{t('versionsTitle')}</h2>
          <p className="text-ink-soft">{t('versionsIntro')}</p>
          <ul className="flex flex-col gap-1" data-testid="legal-versions">
            {data.versions.map((item) => {
              const isShown = item.version === data.shown.version;
              const isCurrent = item.version === data.current.version && data.current.locale === data.shown.locale;
              return (
                <li key={item.version} className="flex flex-wrap items-center gap-x-2">
                  <Link
                    href={isCurrent ? path : { pathname: path, query: { version: item.version } }}
                    aria-current={isShown ? 'page' : undefined}
                    className={`inline-flex min-h-11 items-center font-corp font-bold tabular-nums underline-offset-4 ${isShown ? '' : 'underline'}`}
                  >
                    {item.version}
                  </Link>
                  <span className="text-ink-soft">{t('versionPublished', { date: date(item.publishedAt) })}</span>
                  {isCurrent ? <span className="font-semibold text-varsity-emerald">{pending ? t('versionCurrentFrom', { date: date(data.current.effectiveAt) }) : t('versionCurrent')}</span> : null}
                </li>
              );
            })}
          </ul>
          <p className="text-ink-soft">
            {t('hashLabel')}{' '}
            <code className="font-mono text-xs wrap-anywhere" data-testid="legal-hash">
              {data.shown.contentSha256}
            </code>
          </p>
        </footer>
      </article>
    </div>
  );
}
