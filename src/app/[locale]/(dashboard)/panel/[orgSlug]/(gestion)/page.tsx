import { getTranslations, setRequestLocale } from 'next-intl/server';
import { DashboardBoard } from '@/components/panel/dashboard-board';
import { MedalKit } from '@/components/panel/medal-kit';
import { Model182Card } from '@/components/panel/model182-card';
import { medalLevels } from '@/core/medals/medal-kit';
import type { DashboardInitiative } from '@/core/panel/dashboard';
import { normalizeContactPhone } from '@/core/tax/contact-phone';
import { model182Years } from '@/core/tax/model182-years';
import type { Locale } from '@/i18n/routing';
import { requirePanelAccess } from '@/lib/auth/guards';
import { loadPanelOverview } from '@/lib/panel/overview';
import { getPrisma } from '@/lib/prisma';
import { getDashboardData } from '@/repositories/panel.repository';

/**
 * Cuadro de mandos de la entidad (Sprint 4.1, `sch-sub-dashboard`): el kit de medallas, los indicadores con sus filtros ocultos, la línea de
 * 6 estados de cada iniciativa con su hucha y, si la Ley 49/2002 está verificada, la descarga del Modelo 182. La guardia del `layout` ya
 * exige firmante con segundo factor; cada lectura vuelve a comprobarlo para esta entidad. Dinámica: depende de la sesión.
 */
export const dynamic = 'force-dynamic';

export default async function PanelHomePage({ params }: { params: Promise<{ locale: Locale; orgSlug: string }> }) {
  const { locale, orgSlug } = await params;
  setRequestLocale(locale);
  const { actor, organization } = await requirePanelAccess(locale, orgSlug);
  const now = new Date();
  const [overview, data, t] = await Promise.all([loadPanelOverview(actor, organization.id), getDashboardData(getPrisma(), actor, organization.id, now), getTranslations({ locale, namespace: 'panel' })]);
  const { organization: org, signers, tiers } = overview;

  const initiatives: DashboardInitiative[] = data.initiatives.map((item) => ({
    id: item.id,
    walletEscrowId: item.walletEscrowId,
    title: item.title,
    category: item.category,
    academicYear: item.academicYear,
    format: item.format,
    status: item.status,
    stepIndex: item.stepIndex,
    raisedCents: item.raisedCents,
    goalCents: item.goalCents,
    closesAt: item.closesAt.toISOString(),
    totalContributions: item.totalContributions
  }));
  const levels = medalLevels(tiers, org.medalRank, org.completedThisYear);
  const { years, defaultYear } = model182Years(now);
  const memberships = actor.memberships.filter((membership) => membership.organizationId === org.id);
  // El Modelo 182 es de las personas que firman por la entidad: el Super-Admin entra al panel, pero no extrae los NIF de las familias.
  const isSigner = memberships.length > 0;
  // El teléfono de la entidad (Ajustes) se precarga a las dos personas firmantes; si aún no lo hay, a quien dirige su propio móvil del alta
  // (`contactPhone` es de esa persona: nunca se le enseña a la cofirma).
  const isDirector = memberships.some((membership) => membership.role === 'DIRECTOR');
  const defaultPhone = normalizeContactPhone(org.phone ?? (isDirector ? (org.contactPhone ?? '') : ''));

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-joy text-3xl font-bold text-varsity-navy">{t('welcome', { name: organization.name })}</h1>
        <p className="max-w-3xl text-ink-soft">{t('intro')}</p>
      </header>

      <MedalKit orgSlug={org.slug} entityName={org.name} vertical={org.vertical} period={org.quotaPeriod ?? ''} levels={levels} />

      <DashboardBoard
        orgSlug={org.slug}
        initiatives={initiatives}
        activeSponsors={data.activeSponsors}
        readySigners={signers.filter((signer) => signer.status === 'ACTIVE').length}
        kybStatus={org.kybStatus}
      />

      {isSigner ? <Model182Card orgSlug={org.slug} verified={org.ley49 && org.ley49VerifiedAt !== null} years={years} defaultYear={defaultYear} defaultPhone={defaultPhone} /> : null}
    </div>
  );
}
