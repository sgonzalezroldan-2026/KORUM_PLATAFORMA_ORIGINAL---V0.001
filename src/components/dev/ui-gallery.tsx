'use client';

import { KorumLogo } from '@/components/brand/korum-logo';
import { KorumMark } from '@/components/brand/korum-mark';
import { CurrencyText } from '@/components/ui/currency-text';
import { DelayedTooltip } from '@/components/ui/delayed-tooltip';
import { EmptyState } from '@/components/ui/empty-state';
import { SortableTh } from '@/components/ui/sortable-th';
import { LoadingRegion, Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { useToast } from '@/components/ui/toast-provider';
import { TrustBadge } from '@/components/ui/trust-badge';
import { useSortableRows } from '@/lib/use-sortable-rows';
import type { InitiativeStatus } from '@/types/korum.types';

const STATUSES: InitiativeStatus[] = [
  'BUDGETING',
  'FUNDRAISING',
  'GOAL_REACHED',
  'CLOSED',
  'EXPIRED',
  'RESIZE_VOTING',
  'REFUNDING',
  'REFUNDED',
  'CANCELLED'
];

const ROWS = [
  { name: '18 ventiladores para las aulas', contributions: 41, raisedCents: 187_400 },
  { name: 'Toldos para el patio', contributions: 128, raisedCents: 640_000 },
  { name: 'Marcador de la pista', contributions: 9, raisedCents: 35_100 }
];
const ACCESSORS = {
  name: (row: (typeof ROWS)[number]) => row.name,
  contributions: (row: (typeof ROWS)[number]) => row.contributions,
  raisedCents: (row: (typeof ROWS)[number]) => row.raisedCents
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4 rounded-2xl border border-patio-rule-strong bg-white p-5">
      <h2 className="font-corp text-lg font-extrabold text-varsity-navy">{title}</h2>
      {children}
    </section>
  );
}

/** Galería interna (solo desarrollo y demostración): permite comprobar cada primitiva a 1440 px y a 430 px. */
export function UiGallery() {
  const { toast } = useToast();
  const { rows, sort, toggle } = useSortableRows(ROWS, ACCESSORS);

  return (
    // Los textos de muestra están en castellano en los tres idiomas: se declara para los lectores de pantalla (WCAG 3.1.2).
    <div lang="es" className="mx-auto w-full max-w-5xl space-y-6 px-4 py-8">
      <h1 className="font-joy text-3xl font-bold text-varsity-navy">Galería de componentes</h1>

      <Section title="Marca">
        <div className="flex flex-wrap items-center gap-6">
          <KorumMark size={96} />
          <KorumMark size={48} />
          <KorumMark size={24} />
          <KorumLogo size={44} />
          <div className="rounded-xl bg-varsity-navy p-4">
            <KorumLogo size={44} tone="dark" />
          </div>
        </div>
      </Section>

      <Section title="Importes">
        <ul className="flex flex-wrap gap-4 text-lg">
          {[0, 34, 2_500, 100_000, 12_345_678, -34].map((cents) => (
            <li key={cents}>
              <CurrencyText cents={cents} />
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Estados de iniciativa">
        <ul className="flex flex-wrap gap-2">
          {STATUSES.map((status) => (
            <li key={status}>
              <StatusBadge status={status} />
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Etiquetas de confianza, sellos y pegatinas">
        <div className="flex flex-wrap items-center gap-3">
          <TrustBadge icon="🛡️" tone="emerald">
            Devolución del 100 % si no se llega
          </TrustBadge>
          <TrustBadge icon="🤝">Proveedor libre</TrustBadge>
          <span className="korum-stamp-badge">¡CONSEGUIDO!</span>
          <span className="die-cut-sticker">
            <span aria-hidden="true">⚡</span>
            Matching 2x
          </span>
        </div>
      </Section>

      <Section title="Tooltip diferido (1000 ms) y avisos">
        <div className="flex flex-wrap items-center gap-3">
          <DelayedTooltip content="Esta ayuda aparece a los 1000 ms con el ratón y al instante con el teclado.">
            <button type="button" className="tactile-btn">
              Pasa el ratón por aquí
            </button>
          </DelayedTooltip>
          <button type="button" className="rounded-lg border-2 border-varsity-emerald px-4 py-2 font-bold" onClick={() => toast({ tone: 'success', title: 'Aportación recibida', description: 'Te hemos enviado el recibo por email.' })}>
            Aviso de éxito
          </button>
          <button type="button" className="rounded-lg border-2 border-varsity-navy px-4 py-2 font-bold" onClick={() => toast({ tone: 'info', title: 'Guardado como borrador' })}>
            Aviso informativo
          </button>
          <button type="button" className="rounded-lg border-2 border-red-700 px-4 py-2 font-bold" onClick={() => toast({ tone: 'error', title: 'Bizum no ha confirmado el pago', description: 'No se te ha cobrado nada.' })}>
            Aviso de error
          </button>
        </div>
      </Section>

      <Section title="Tabla ordenable">
        {/* Zona con desplazamiento horizontal: enfocable con teclado y con nombre (axe: scrollable-region-focusable). */}
        <div tabIndex={0} role="region" aria-label="Tabla de iniciativas, desplazable" className="overflow-x-auto">
          <table className="w-full text-start">
            <caption className="sr-only">Iniciativas de ejemplo</caption>
            <thead>
              <tr className="border-b-2 border-varsity-navy/20">
                <SortableTh label="Iniciativa" sortKey="name" sort={sort} onToggle={toggle} />
                <SortableTh label="💛 Aportaciones" columnName="Aportaciones" sortKey="contributions" sort={sort} onToggle={toggle} align="end" />
                <SortableTh label="Recaudado" sortKey="raisedCents" sort={sort} onToggle={toggle} align="end" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.name} className="border-b border-patio-rule">
                  <td className="px-3 py-2">{row.name}</td>
                  <td className="px-3 py-2 text-end tabular-nums">{row.contributions}</td>
                  <td className="px-3 py-2 text-end">
                    <CurrencyText cents={row.raisedCents} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Una sola columna en móvil (.mobile-stack)">
        <div className="mobile-stack grid grid-cols-3 gap-3">
          {['Uno', 'Dos', 'Tres'].map((label) => (
            <div key={label} className="korum-notebook-sheet">
              {label}
            </div>
          ))}
        </div>
      </Section>

      <Section title="Estado vacío y carga">
        <EmptyState
          icon="💡"
          title="Todavía no hay campañas abiertas"
          description="¿Tienes una idea para el cole? Propónla en el Buzón."
          headingLevel={3}
          playful
          action={
            <button type="button" className="tactile-btn">
              Proponer idea
            </button>
          }
        />
        <LoadingRegion className="space-y-3">
          <Skeleton className="h-8 w-1/2" />
          <SkeletonText lines={3} />
        </LoadingRegion>
      </Section>
    </div>
  );
}
