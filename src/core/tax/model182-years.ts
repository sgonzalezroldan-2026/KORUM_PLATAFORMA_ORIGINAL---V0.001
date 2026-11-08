/** Primer ejercicio que KORUM sabe declarar (escala vigente del Real Decreto-ley 6/2023). Antes de él la plataforma no existía. */
export const MODEL182_FIRST_YEAR = 2024;

export interface Model182Years {
  /** Del más reciente al más antiguo; el ejercicio en curso incluido (sirve para ver cómo va, aunque aún no se presente). */
  years: number[];
  /** El último ejercicio completo: el que se presenta en enero. */
  defaultYear: number;
}

/** Ejercicios que se pueden descargar, con el año según la hora de España (el 31 de diciembre por la noche ya es otro año en UTC). */
export function model182Years(now: Date): Model182Years {
  const current = Number(new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone: 'Europe/Madrid' }).format(now));
  const last = Math.max(current, MODEL182_FIRST_YEAR);
  return {
    years: Array.from({ length: last - MODEL182_FIRST_YEAR + 1 }, (_, index) => last - index),
    defaultYear: Math.max(MODEL182_FIRST_YEAR, current - 1)
  };
}
