/**
 * Cuándo se ha cumplido la meta de una iniciativa. En taquilla también al agotar el aforo: con los gastos incluidos en el precio (`INC`) la hucha
 * recibe menos que la meta, y aun así no queda nada más que vender. Una sola definición para abrir, cerrar y liquidar.
 */
export function isGoalMet(initiative: { format: string; raisedCents: number; goalCents: number; ticketsSold: number; ticketMax: number | null }): boolean {
  if (initiative.raisedCents >= initiative.goalCents) return true;
  return initiative.format === 'TICKETING' && initiative.ticketMax !== null && initiative.ticketsSold >= initiative.ticketMax;
}
