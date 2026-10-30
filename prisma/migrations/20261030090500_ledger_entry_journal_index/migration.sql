-- Índice por asiento en los apuntes del libro mayor (hallazgo de la auditoría de QA del Sprint 1.3).
--
-- Los dos triggers de cuadre (`LedgerJournal_balanced` por asiento y `EscrowLedgerEntry_balanced` por apunte), la búsqueda de
-- un asiento por su clave (`findByKey`) y los contra-asientos (`reverseJournal`) leen los apuntes con `WHERE "journalId" = …`.
-- PostgreSQL no crea un índice por una clave foránea, así que sin esto cada cobro recorría la tabla entera al confirmar. Con la
-- semilla (6.550 apuntes) no se nota; con millones de apuntes frenaría el checkout y los webhooks.
-- Crear un índice no ejecuta triggers ni modifica apuntes: el libro mayor sigue siendo de solo añadir.

CREATE INDEX "EscrowLedgerEntry_journalId_idx" ON "EscrowLedgerEntry"("journalId");
