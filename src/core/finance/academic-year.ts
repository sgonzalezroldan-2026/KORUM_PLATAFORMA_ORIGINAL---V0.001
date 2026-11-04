/**
 * Curso de los cupos de una entidad (`Organization.quotaPeriod`, `Initiative.academicYear`): `AAAA-AAAA`, p. ej. `2026-2027`.
 * El curso nuevo empieza el **22 de agosto** (UTC): el corte debe ser posterior al 21 de agosto para que las campañas del curso anterior
 * que aún reparten fondos dentro de la ventana de 90 días de Paycomet sigan abonando a los cupos que reservaron (bitácora del 2.1).
 */
export const ACADEMIC_YEAR_START = { month: 8, day: 22 } as const;

export function academicYearFor(date: Date): string {
  const month = date.getUTCMonth() + 1;
  const startsNewCourse = month > ACADEMIC_YEAR_START.month || (month === ACADEMIC_YEAR_START.month && date.getUTCDate() >= ACADEMIC_YEAR_START.day);
  const startYear = startsNewCourse ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
  return `${startYear}-${startYear + 1}`;
}

/** `true` si `candidate` es un curso posterior a `current` (los cursos `AAAA-AAAA` se ordenan como texto). */
export function isLaterAcademicYear(candidate: string, current: string | null): boolean {
  return current === null || candidate > current;
}
