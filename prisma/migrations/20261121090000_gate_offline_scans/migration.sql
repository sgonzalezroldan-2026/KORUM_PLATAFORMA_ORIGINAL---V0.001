-- Sprint 4.5 · Portería sin cobertura. Un voluntario sin red valida contra la lista descargada y guarda las lecturas en una cola local; al volver la
-- conexión las envía. Para que reenviar la cola (un corte a mitad, un doble toque, dos pestañas) no deje entrar dos veces al mismo pase:
--  · `clientScanId`: lo genera el móvil por cada lectura; único por sesión de portería. El servidor lo mira dentro de la transacción que bloquea el pase.
--  · `offline`: la lectura se hizo sin red; la entidad puede distinguirla de una en directo en caso de conflicto.

ALTER TABLE "TicketCheckIn" ADD COLUMN "offline" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "TicketCheckIn" ADD COLUMN "clientScanId" TEXT;
ALTER TABLE "TicketCheckIn" ADD CONSTRAINT "TicketCheckIn_clientScanId_length" CHECK ("clientScanId" IS NULL OR char_length("clientScanId") BETWEEN 8 AND 64);

-- La búsqueda de una lectura repetida se hace por `clientScanId` en todas las sesiones del evento (cambiar el PIN abre una sesión nueva y reenvía la cola).
CREATE INDEX "TicketCheckIn_clientScanId_idx" ON "TicketCheckIn"("clientScanId");
CREATE UNIQUE INDEX "TicketCheckIn_gateSessionId_clientScanId_key" ON "TicketCheckIn"("gateSessionId", "clientScanId");
