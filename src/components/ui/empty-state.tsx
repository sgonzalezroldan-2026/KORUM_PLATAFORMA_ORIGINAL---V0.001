import clsx from 'clsx';
import type { ReactNode, Ref } from 'react';

export interface EmptyStateProps {
  /** Emoji o ilustración decorativa. */
  icon?: string;
  title: string;
  description: string;
  /** Siguiente acción (botón o enlace). */
  action?: ReactNode;
  /** `1` para páginas completas (404, error): cada página necesita un único `h1`. */
  headingLevel?: 1 | 2 | 3;
  /** Titular con la voz de patio (`Fredoka`). Solo para contextos de comunidad; por defecto, tipografía institucional. */
  playful?: boolean;
  /** `alert` para errores: los lectores de pantalla lo anuncian al aparecer. */
  role?: 'alert' | 'status';
  /** Permite mover el foco al titular (p. ej. en la página de error). Si se pasa, el titular admite foco programático. */
  headingRef?: Ref<HTMLHeadingElement>;
  className?: string;
}

/** Estado vacío: explica qué falta y ofrece la siguiente acción (EXPERIENCIA_DE_PRODUCTO §5). */
export function EmptyState({ icon, title, description, action, headingLevel = 2, playful = false, role, headingRef, className }: EmptyStateProps) {
  const Heading = headingLevel === 1 ? 'h1' : headingLevel === 2 ? 'h2' : 'h3';

  return (
    <div role={role} className={clsx('rounded-2xl border-2 border-dashed border-patio-rule-strong bg-white/80 p-8 text-center', className)}>
      {icon ? (
        <div aria-hidden="true" className="text-4xl">
          {icon}
        </div>
      ) : null}
      <Heading
        ref={headingRef}
        tabIndex={headingRef ? -1 : undefined}
        className={clsx('mt-2 text-xl font-bold text-varsity-navy', playful ? 'font-joy' : 'font-corp')}
      >
        {title}
      </Heading>
      <p className="mx-auto mt-2 max-w-prose text-ink-soft">{description}</p>
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  );
}
