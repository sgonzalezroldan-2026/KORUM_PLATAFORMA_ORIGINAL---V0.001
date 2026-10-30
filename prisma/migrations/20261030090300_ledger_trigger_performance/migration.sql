-- =============================================================================
-- KORUM · Triggers del libro mayor más baratos, con las mismas garantías (Sprint 1.3)
--
-- 1. Las dos funciones pasan de SQL dinámico (`EXECUTE format(...)`, que se replanifica en cada fila) a SQL estático
--    con `SET search_path FROM CURRENT`: la función queda atada al esquema donde se crea (public en producción, el del
--    esquema de pruebas en los tests) y PostgreSQL reutiliza su plan. La carga de una semilla de 3.000 asientos pasa de
--    minutos a segundos.
-- 2. Se elimina el trigger de cuadre por apunte (`EscrowLedgerEntry_balanced`): es redundante. Un apunte solo puede
--    nacer en la misma transacción que su asiento (`EscrowLedgerEntry_same_transaction`), y el trigger diferido del
--    asiento (`LedgerJournal_balanced`) comprueba el cuadre completo al confirmar esa transacción.
-- =============================================================================

DROP TRIGGER IF EXISTS "EscrowLedgerEntry_balanced" ON "EscrowLedgerEntry";

-- Cuadre de un asiento (solo se dispara desde "LedgerJournal", al confirmar la transacción).
CREATE OR REPLACE FUNCTION korum_check_journal_balanced() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  v_debit  bigint;
  v_credit bigint;
  v_lines  integer;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN "direction" = 'DEBIT' THEN "amountCents" ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN "direction" = 'CREDIT' THEN "amountCents" ELSE 0 END), 0),
         COUNT(*)
    INTO v_debit, v_credit, v_lines
    FROM "EscrowLedgerEntry"
   WHERE "journalId" = NEW."id";

  IF v_lines < 2 OR v_debit <> v_credit THEN
    RAISE EXCEPTION 'KORUM_UNBALANCED: el asiento % no cuadra (debe % · haber % · % apuntes)', NEW."id", v_debit, v_credit, v_lines
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

-- Un apunte solo puede añadirse a un asiento creado en la misma transacción.
CREATE OR REPLACE FUNCTION korum_entry_same_transaction() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  v_posted_tx bigint;
BEGIN
  SELECT "postedTxId" INTO v_posted_tx FROM "LedgerJournal" WHERE "id" = NEW."journalId";

  IF v_posted_tx IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'KORUM_IMMUTABLE: el asiento % ya está registrado y no admite apuntes nuevos; registra otro asiento', NEW."journalId"
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
