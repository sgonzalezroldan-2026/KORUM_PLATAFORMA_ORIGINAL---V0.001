/**
 * La regla de los 14 días (Regla 02 §12): cuando alguien que debe decidir calla, o cuando una persona se arrepiente de un pago que no es una donación, el
 * plazo es siempre el mismo y la devolución es automática, sin el Super-Admin. Es **un valor único** para toda la plataforma: si Paycomet responde que un
 * cobro solo se puede devolver durante menos tiempo, se acorta aquí y vale para todos los casos (cambio de fecha de un evento desde el Sprint 5.13; vales,
 * aportación voluntaria, Mi Hucha, comercios y campañas vencidas en sus sprints).
 */
export const FOURTEEN_DAY_RULE_DAYS = 14;

const DAY_MS = 86_400_000;

/** Final del plazo que empieza en `from`. */
export function fourteenDayDeadline(from: Date): Date {
  return new Date(from.getTime() + FOURTEEN_DAY_RULE_DAYS * DAY_MS);
}
