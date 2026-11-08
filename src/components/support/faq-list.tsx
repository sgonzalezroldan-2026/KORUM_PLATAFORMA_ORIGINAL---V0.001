export interface FaqItem {
  id: string;
  question: string;
  answer: string;
}

/**
 * Preguntas frecuentes (`fview-faq`). Cada una es un `<details>` nativo: se abre con teclado, se anuncia como desplegable y funciona sin JavaScript.
 * La primera va abierta, como en el prototipo.
 */
export function FaqList({ items, label }: { items: FaqItem[]; label: string }) {
  return (
    <div className="flex flex-col gap-3" role="group" aria-label={label}>
      {items.map((item, index) => (
        <details key={item.id} open={index === 0} className="rounded-2xl border-2 border-stone-200 bg-white p-4" data-testid="faq-item">
          <summary className="min-h-11 cursor-pointer font-extrabold text-varsity-navy">{item.question}</summary>
          <p className="mt-2 leading-relaxed text-ink-soft">{item.answer}</p>
        </details>
      ))}
    </div>
  );
}
