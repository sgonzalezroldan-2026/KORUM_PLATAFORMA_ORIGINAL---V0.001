-- =============================================================================
-- KORUM · Cierre de la auditoría financiera del Sprint 1.2
-- 1. Un asiento ya confirmado no admite apuntes nuevos (ni siquiera cuadrados).
-- 2. Los apuntes solo pueden señalar entidades, iniciativas, familias o comercios que existen.
-- 3. Instantánea de los cupos reservados por cada iniciativa y curso de los cupos de la entidad.
-- =============================================================================

-- AlterTable
ALTER TABLE "Initiative" ADD COLUMN     "quotaReservedExemptCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "quotaReservedMaintCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "quotaReservedMedalCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "quotaReservedPeriod" TEXT;

-- AlterTable
ALTER TABLE "LedgerJournal" ADD COLUMN     "postedTxId" BIGINT NOT NULL DEFAULT txid_current();

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "quotaPeriod" TEXT;

-- AddForeignKey
ALTER TABLE "EscrowLedgerEntry" ADD CONSTRAINT "EscrowLedgerEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscrowLedgerEntry" ADD CONSTRAINT "EscrowLedgerEntry_initiativeId_fkey" FOREIGN KEY ("initiativeId") REFERENCES "Initiative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscrowLedgerEntry" ADD CONSTRAINT "EscrowLedgerEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscrowLedgerEntry" ADD CONSTRAINT "EscrowLedgerEntry_sponsorId_fkey" FOREIGN KEY ("sponsorId") REFERENCES "Sponsor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Los asientos los sella siempre la transacción que los crea (aunque alguien intente fijar otro valor).
CREATE OR REPLACE FUNCTION korum_stamp_journal_tx() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."postedTxId" := txid_current();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "LedgerJournal_stamp_tx"
  BEFORE INSERT ON "LedgerJournal"
  FOR EACH ROW EXECUTE FUNCTION korum_stamp_journal_tx();

-- Un apunte solo puede añadirse a un asiento creado en la misma transacción.
CREATE OR REPLACE FUNCTION korum_entry_same_transaction() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_posted_tx bigint;
BEGIN
  EXECUTE format('SELECT "postedTxId" FROM %I."LedgerJournal" WHERE "id" = $1', TG_TABLE_SCHEMA)
    INTO v_posted_tx
    USING NEW."journalId";

  IF v_posted_tx IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'KORUM_IMMUTABLE: el asiento % ya está registrado y no admite apuntes nuevos; registra otro asiento', NEW."journalId"
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "EscrowLedgerEntry_same_transaction"
  BEFORE INSERT ON "EscrowLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION korum_entry_same_transaction();
