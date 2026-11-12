import type { BiInitiativeRow } from '@/core/finance/bi-aggregate';
import { fixHasEffect, type NegativeReturnFixPlan } from '@/core/finance/self-boost';
import type { Db } from '@/lib/db';
import { getSetting } from '@/services/settings/settings.service';
import { loadBiSnapshot } from './bi-snapshot';
import { previewNegativeReturnFix } from './self-boost.service';

/**
 * Ficha ejecutiva de una iniciativa para el Super-Admin (Sprint 5.2, `sa-init-popup-modal`): los mismos números que la tabla (salen de la misma fila
 * del BI, así que no pueden diferir), su enlace público, los comercios que participan, lo que ya aportó KORUM y lo que se puede hacer ahora.
 * Quien llama ya pasó `authorizeSuperadmin`. Nada de aquí lleva datos de personas: solo importes, estados y nombres de comercio.
 */

export interface PopupSponsor {
  id: number;
  name: string;
  categoryLevel: 'ORO' | 'PLATA' | 'BRONCE';
  status: string;
  amountCents: number;
  feeCents: number;
  isMatchingPool: boolean;
}

export interface PopupBoost {
  /** Lo que falta para la meta y se puede aportar ahora (0 si la campaña ya no recauda, ya venció o está completa). */
  availableCents: number;
  defaultDisclosure: 'SHOW' | 'HIDE';
  previous: Array<{ amountCents: number; publiclyDisclosed: boolean; createdAt: string }>;
}

export interface PopupFix {
  /** El botón cambia algo (tarifas propias de la entidad por debajo de las globales, o cobertura de pasarela en un borrador). */
  available: boolean;
  /** Hay cobertura de pasarela en una campaña ya publicada: no se toca (decisión del promotor, 2026-11-11). */
  publishedLeftUntouched: boolean;
}

export interface InitiativePopupView {
  row: BiInitiativeRow;
  /** Ruta pública de la ficha (sin idioma: la pantalla la localiza). */
  publicPath: string;
  sponsors: PopupSponsor[];
  boost: PopupBoost;
  fix: PopupFix | null;
}

function fixView(plan: NegativeReturnFixPlan | null): PopupFix {
  return { available: plan !== null && fixHasEffect(plan), publishedLeftUntouched: plan?.publishedLeftUntouched ?? false };
}

export async function loadInitiativePopup(db: Db, initiativeId: number, now: Date = new Date()): Promise<InitiativePopupView | null> {
  const snapshot = await loadBiSnapshot(db, {});
  const row = snapshot.initiatives.find((candidate) => candidate.id === initiativeId);
  if (!row) return null;
  const [sponsors, previous, defaultDisclosure, plan] = await Promise.all([
    db.sponsor.findMany({
      where: { initiativeId },
      orderBy: [{ tierRank: 'desc' }, { id: 'asc' }],
      select: { id: true, name: true, categoryLevel: true, status: true, amountCents: true, feeGeneratedCents: true, isMatchingPool: true }
    }),
    db.contribution.findMany({ where: { initiativeId, type: 'SELF_BOOST', status: 'COMPLETED' }, orderBy: { id: 'asc' }, select: { amountCents: true, publiclyDisclosed: true, createdAt: true } }),
    getSetting(db, 'autoBoost.publicDisclosureDefault'),
    row.isNegativeReturnAlert ? previewNegativeReturnFix(db, initiativeId) : Promise.resolve(null)
  ]);
  const open = row.status === 'FUNDRAISING' && new Date(row.closesAt).getTime() > now.getTime();
  return {
    row,
    publicPath: `/${row.organizationSlug}/iniciativas/${row.id}`,
    sponsors: sponsors.map((sponsor) => ({ id: sponsor.id, name: sponsor.name, categoryLevel: sponsor.categoryLevel, status: sponsor.status, amountCents: sponsor.amountCents, feeCents: sponsor.feeGeneratedCents, isMatchingPool: sponsor.isMatchingPool })),
    boost: { availableCents: open ? row.missingTo100Cents : 0, defaultDisclosure: defaultDisclosure === 'HIDE' ? 'HIDE' : 'SHOW', previous: previous.map((boost) => ({ amountCents: boost.amountCents, publiclyDisclosed: boost.publiclyDisclosed, createdAt: boost.createdAt.toISOString() })) },
    fix: row.isNegativeReturnAlert ? fixView(plan) : null
  };
}
