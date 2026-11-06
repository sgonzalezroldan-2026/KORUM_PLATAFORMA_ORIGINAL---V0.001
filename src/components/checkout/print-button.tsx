'use client';

/** Botón «Imprimir o guardar en PDF» de un documento. No sale al imprimir. */
export function PrintButton({ label }: { label: string }) {
  return (
    <button type="button" onClick={() => window.print()} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-varsity-navy px-4 font-extrabold text-white hover:bg-varsity-navy-deep print:hidden">
      <span aria-hidden="true">{'🖨️'}</span>
      {label}
    </button>
  );
}
