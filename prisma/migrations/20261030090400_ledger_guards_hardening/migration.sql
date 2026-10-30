-- =============================================================================
-- KORUM · Endurecimiento del libro mayor tras la auditoría financiera del Sprint 1.3
--
-- La migración `ledger_trigger_performance` retiró el trigger de cuadre por apunte creyéndolo redundante y dejó las funciones
-- sin un `search_path` explícito. La auditoría reprodujo tres ataques que entraban:
--   1. `SET CONSTRAINTS ALL IMMEDIATE` + un apunte descuadrado después de comprobar el asiento.
--   2. Una tabla temporal "EscrowLedgerEntry": PostgreSQL busca `pg_temp` primero si no figura en el `search_path`, así que
--      la comprobación de cuadre leía apuntes falsos.
--   3. Una tabla temporal "LedgerJournal": la comprobación de «misma transacción» leía un asiento falso y se podían añadir
--      apuntes a un asiento ya cerrado.
-- Esta migración (a) restaura el trigger de cuadre por apunte, que sí hace falta, (b) fija el `search_path` de TODAS las
-- funciones con `pg_temp` al final, y (c) permite únicamente la anonimización de `ipHash` y `userAgent` en la auditoría
-- (retención limitada, RGPD) sin abrir ninguna otra modificación.
-- =============================================================================

-- (a) Cuadre del asiento al que pertenece cada apunte nuevo, evaluado en cada apunte (incluso tras SET CONSTRAINTS IMMEDIATE).
CREATE OR REPLACE FUNCTION korum_check_entry_journal_balanced() RETURNS trigger
LANGUAGE plpgsql
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
   WHERE "journalId" = NEW."journalId";

  IF v_lines < 2 OR v_debit <> v_credit THEN
    RAISE EXCEPTION 'KORUM_UNBALANCED: el asiento % no cuadra (debe % · haber % · % apuntes)', NEW."journalId", v_debit, v_credit, v_lines
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "EscrowLedgerEntry_balanced"
  AFTER INSERT ON "EscrowLedgerEntry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION korum_check_entry_journal_balanced();

-- (c) Auditoría inmutable, salvo la anonimización de IP (HMAC) y navegador cuando vence su plazo de conservación.
CREATE OR REPLACE FUNCTION korum_audit_log_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."ipHash" IS NULL
     AND NEW."userAgent" IS NULL
     AND NEW."id" = OLD."id"
     AND NEW."occurredAt" = OLD."occurredAt"
     AND NEW."actorType" = OLD."actorType"
     AND NEW."actorUserId" IS NOT DISTINCT FROM OLD."actorUserId"
     AND NEW."organizationId" IS NOT DISTINCT FROM OLD."organizationId"
     AND NEW."action" = OLD."action"
     AND NEW."targetType" = OLD."targetType"
     AND NEW."targetId" = OLD."targetId"
     AND NEW."metadataJson" IS NOT DISTINCT FROM OLD."metadataJson"
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'KORUM_IMMUTABLE: % no está permitido en "%"; la auditoría solo admite altas y la anonimización de IP y navegador', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE OR REPLACE TRIGGER "AuditLog_immutable"
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION korum_audit_log_guard();

-- (b) `search_path` explícito en todas las funciones: el esquema de la propia base, el catálogo y, al final, pg_temp.
DO $$
DECLARE
  v_schema   text := current_schema();
  v_function text;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    'korum_forbid_mutation()',
    'korum_stamp_journal_tx()',
    'korum_check_journal_balanced()',
    'korum_check_entry_journal_balanced()',
    'korum_entry_same_transaction()',
    'korum_audit_log_guard()'
  ]
  LOOP
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path = %I, pg_catalog, pg_temp', v_schema, v_function, v_schema);
  END LOOP;
END
$$;
