-- =============================================================================
-- KORUM · Libro mayor de doble partida e inmutabilidad (Regla 02 §3, QA-C03)
-- La base de datos es la última línea de defensa: aunque alguien salte el código de la aplicación
-- (SQL a mano, otra herramienta), no puede descuadrar ni reescribir la contabilidad.
-- =============================================================================

-- 1. Reglas de forma de cada apunte y de cada asiento -----------------------------

-- Importe siempre positivo: el signo lo da "direction".
ALTER TABLE "EscrowLedgerEntry"
  ADD CONSTRAINT "EscrowLedgerEntry_amountCents_positive" CHECK ("amountCents" > 0);

-- Toda la contabilidad es en euros.
ALTER TABLE "EscrowLedgerEntry"
  ADD CONSTRAINT "EscrowLedgerEntry_currency_eur" CHECK ("currency" = 'EUR');

-- La clave de idempotencia identifica la operación de origen: no puede estar vacía.
ALTER TABLE "LedgerJournal"
  ADD CONSTRAINT "LedgerJournal_idempotencyKey_not_blank" CHECK (length(btrim("idempotencyKey")) > 0);

-- Un contra-asiento (REVERSAL) siempre dice qué asiento corrige, y solo él lo dice.
ALTER TABLE "LedgerJournal"
  ADD CONSTRAINT "LedgerJournal_reversal_link" CHECK (("kind" = 'REVERSAL') = ("reversesJournalId" IS NOT NULL));

-- Un asiento no puede corregirse a sí mismo.
ALTER TABLE "LedgerJournal"
  ADD CONSTRAINT "LedgerJournal_reversal_not_self" CHECK ("reversesJournalId" IS NULL OR "reversesJournalId" <> "id");

-- 2. Inmutabilidad: nada se edita, se borra ni se vacía -------------------------

CREATE OR REPLACE FUNCTION korum_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'KORUM_IMMUTABLE: % no está permitido en "%"; la contabilidad y la auditoría solo admiten altas (los errores se corrigen con un contra-asiento)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "LedgerJournal_immutable"
  BEFORE UPDATE OR DELETE ON "LedgerJournal"
  FOR EACH ROW EXECUTE FUNCTION korum_forbid_mutation();
CREATE TRIGGER "LedgerJournal_no_truncate"
  BEFORE TRUNCATE ON "LedgerJournal"
  FOR EACH STATEMENT EXECUTE FUNCTION korum_forbid_mutation();

CREATE TRIGGER "EscrowLedgerEntry_immutable"
  BEFORE UPDATE OR DELETE ON "EscrowLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION korum_forbid_mutation();
CREATE TRIGGER "EscrowLedgerEntry_no_truncate"
  BEFORE TRUNCATE ON "EscrowLedgerEntry"
  FOR EACH STATEMENT EXECUTE FUNCTION korum_forbid_mutation();

CREATE TRIGGER "AuditLog_immutable"
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION korum_forbid_mutation();
CREATE TRIGGER "AuditLog_no_truncate"
  BEFORE TRUNCATE ON "AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION korum_forbid_mutation();

-- 3. Partida doble comprobada al confirmar la transacción -----------------------
-- Los triggers son diferidos: se evalúan en el COMMIT, cuando el asiento ya tiene todos sus apuntes.
-- Cada asiento necesita al menos 2 apuntes y Σ DEBIT = Σ CREDIT. Si no, la transacción entera se deshace.

CREATE OR REPLACE FUNCTION korum_check_journal_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_journal integer;
  v_debit   bigint;
  v_credit  bigint;
  v_lines   integer;
BEGIN
  IF TG_TABLE_NAME = 'LedgerJournal' THEN
    v_journal := NEW."id";
  ELSE
    v_journal := NEW."journalId";
  END IF;

  -- Se cualifica con el esquema del propio trigger para no depender del search_path de la conexión.
  EXECUTE format(
    'SELECT COALESCE(SUM(CASE WHEN "direction" = ''DEBIT'' THEN "amountCents" ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN "direction" = ''CREDIT'' THEN "amountCents" ELSE 0 END), 0),
            COUNT(*)
       FROM %I."EscrowLedgerEntry"
      WHERE "journalId" = $1',
    TG_TABLE_SCHEMA)
    INTO v_debit, v_credit, v_lines
    USING v_journal;

  IF v_lines < 2 OR v_debit <> v_credit THEN
    RAISE EXCEPTION 'KORUM_UNBALANCED: el asiento % no cuadra (debe % · haber % · % apuntes)', v_journal, v_debit, v_credit, v_lines
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "LedgerJournal_balanced"
  AFTER INSERT ON "LedgerJournal"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION korum_check_journal_balanced();

CREATE CONSTRAINT TRIGGER "EscrowLedgerEntry_balanced"
  AFTER INSERT ON "EscrowLedgerEntry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION korum_check_journal_balanced();
