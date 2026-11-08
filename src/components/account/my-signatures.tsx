import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { ideasPath } from '@/lib/seo/portal-routes';
import type { MyIdeaView } from '@/services/ideas/my-ideas-data';

/**
 * «Mis firmas»: las ideas que la persona ha firmado, de todas sus comunidades, con su avance (`listIdeaIdsSignedBy`, heredado del 3.6). Solo lo
 * que ya es público de la idea; nunca si la firma quedó en revisión.
 */
export async function MySignatures({ signed }: { signed: Array<MyIdeaView & { signedAt: string }> }) {
  const t = await getTranslations('account.proposals');
  const format = await getFormatter();

  return (
    <section id="signatures" aria-labelledby="signatures-title" className="flex scroll-mt-4 flex-col gap-3">
      <h2 id="signatures-title" className="font-corp text-2xl font-extrabold text-varsity-navy">
        {t('signatures.title')}
      </h2>
      {signed.length === 0 ? (
        <p className="rounded-2xl border-2 border-dashed border-patio-rule-strong bg-white p-4 text-ink-soft" data-testid="signatures-empty">
          {t('signatures.empty')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="signatures-list">
          {signed.map((idea) => (
            <li key={idea.id} className="flex flex-col gap-1 rounded-2xl border-2 border-stone-200 bg-white p-4">
              <p className="break-words font-extrabold text-varsity-navy">
                {idea.alias}
                <span className="font-semibold text-ink-soft">{` · ${idea.title}`}</span>
              </p>
              <p className="text-sm text-ink-soft">
                {t('signatures.line', { entity: idea.organizationName, phase: t(`phases.${idea.phase}`), votes: idea.verifiedVotes, needed: idea.needed, date: format.dateTime(new Date(idea.signedAt), { dateStyle: 'medium', timeZone: 'Europe/Madrid' }) })}
              </p>
              <Link href={ideasPath(idea.organizationSlug)} className="inline-flex min-h-11 items-center self-start font-bold text-varsity-navy underline">
                {t('signatures.open', { entity: idea.organizationName })}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
