/** Año y número de un código de trimestre (`2026-Q4`), para el texto `admin.quarterLabel`; `null` si no tiene esa forma. */
export function quarterParts(code: string): { year: string; quarter: string } | null {
  const match = /^(\d{4})-Q([1-4])$/.exec(code);
  return match ? { year: match[1]!, quarter: match[2]! } : null;
}
