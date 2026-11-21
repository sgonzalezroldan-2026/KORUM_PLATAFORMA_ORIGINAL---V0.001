-- =============================================================================
-- KORUM · Sprint 5.10b · La cuenta y los derechos de la persona
--
-- 1. Autoría de cada consulta de soporte (`L-053`): la cuenta que la escribió, para que no dependa del email, que ahora se puede cambiar.
-- 2. Aviso de un cambio importante de la política de privacidad (política §13): la versión lo marca y una fila por versión reparte el email por lotes.
-- 3. Auditoría: además de vaciar la IP y el navegador, admite **desvincular a la persona** cuando vence su plazo (nunca antes de 12 meses) (tabla de plazos §3.10: los rastros de
--    seguridad a los 12 meses y el resto a los 6 años desde el cierre del ejercicio). Solo quita: la cuenta de quien actuó, la cuenta a la que se refiere
--    (`targetType = 'User'`, que pasa a `desvinculado`) y las claves de `metadataJson` que guardan identificadores de cuentas. Nada más se puede cambiar.
-- 4. Factura de proveedor adjunta a una liquidación: 6 años desde el cierre del ejercicio en que se adjuntó (antes, 6 años justos).
-- =============================================================================

-- 1. Autoría de las consultas ------------------------------------------------------------------------------------------------------------------
ALTER TABLE "SupportTicket" ADD COLUMN "senderUserId" TEXT;
CREATE INDEX "SupportTicket_senderUserId_createdAt_idx" ON "SupportTicket"("senderUserId", "createdAt");
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Las anteriores: la cuenta que tiene hoy ese email, solo si está verificado y sin suprimir (como ya las buscaban la bandeja, la copia y la supresión).
UPDATE "SupportTicket" AS t
   SET "senderUserId" = u."id"
  FROM "User" AS u
 WHERE t."senderEmail" IS NOT NULL
   AND t."senderUserId" IS NULL
   AND u."email" = t."senderEmail"
   AND u."emailVerified" = true
   AND u."gdprAnonymizedAt" IS NULL;

-- 2. Cambio importante de la política de privacidad ---------------------------------------------------------------------------------------------
-- La tabla del archivo solo admite altas; añadir una columna con valor por defecto no reescribe filas ni dispara su guarda.
ALTER TABLE "LegalDocumentVersion" ADD COLUMN "importantChange" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "LegalDocumentVersion" ADD CONSTRAINT "LegalDocumentVersion_important_check" CHECK (NOT "importantChange" OR "document" = 'privacidad');

CREATE TABLE "PrivacyPolicyNotice" (
    "id" SERIAL NOT NULL,
    "locale" "Locale" NOT NULL,
    "version" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cursorUserId" TEXT NOT NULL DEFAULT '',
    "queuedCount" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "PrivacyPolicyNotice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PrivacyPolicyNotice_locale_version_key" ON "PrivacyPolicyNotice"("locale", "version");
CREATE INDEX "PrivacyPolicyNotice_completedAt_id_idx" ON "PrivacyPolicyNotice"("completedAt", "id");

-- 3. Auditoría inmutable, salvo quitar lo personal cuando vence su plazo ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION korum_audit_log_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  -- Claves de `metadataJson` que guardan el identificador de una cuenta (`src/core/privacy/retention-unlink.ts`, `AUDIT_PERSON_KEYS`).
  v_person_keys text[] := ARRAY['by', 'signerUserId', 'removedCosignerUserId', 'triggeredByUserId', 'outgoingUserId'];
  -- ¿Quita a la persona? Solo se admite en anotaciones de más de 12 meses: ningún plazo de la tabla desvincula antes (auditoría de seguridad del 5.10b).
  v_unlinks boolean;
BEGIN
  v_unlinks := TG_OP = 'UPDATE' AND (NEW."actorUserId" IS DISTINCT FROM OLD."actorUserId" OR NEW."targetId" IS DISTINCT FROM OLD."targetId" OR NEW."metadataJson" IS DISTINCT FROM OLD."metadataJson");
  IF TG_OP = 'UPDATE'
     AND (NOT v_unlinks OR OLD."occurredAt" < now() - interval '365 days')
     AND NEW."id" = OLD."id"
     AND NEW."occurredAt" = OLD."occurredAt"
     AND NEW."actorType" = OLD."actorType"
     AND NEW."organizationId" IS NOT DISTINCT FROM OLD."organizationId"
     AND NEW."action" = OLD."action"
     AND NEW."targetType" = OLD."targetType"
     -- IP y navegador: o siguen igual, o se vacían los dos a la vez (12 meses).
     AND ((NEW."ipHash" IS NOT DISTINCT FROM OLD."ipHash" AND NEW."userAgent" IS NOT DISTINCT FROM OLD."userAgent") OR (NEW."ipHash" IS NULL AND NEW."userAgent" IS NULL))
     -- Quién actuó: igual o vacío.
     AND (NEW."actorUserId" IS NOT DISTINCT FROM OLD."actorUserId" OR NEW."actorUserId" IS NULL)
     -- A qué se refiere: igual, o «desvinculado» si era una cuenta.
     AND (NEW."targetId" = OLD."targetId" OR (OLD."targetType" = 'User' AND NEW."targetId" = 'desvinculado'))
     -- Los detalles: iguales, o sin las claves que guardan cuentas.
     AND (NEW."metadataJson" IS NOT DISTINCT FROM OLD."metadataJson"
          OR (jsonb_typeof(OLD."metadataJson") = 'object' AND NEW."metadataJson" = (OLD."metadataJson" - v_person_keys)))
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'KORUM_IMMUTABLE: % no está permitido en "%"; la auditoría solo admite altas y quitar lo personal (IP, navegador y cuentas) al vencer su plazo', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE OR REPLACE TRIGGER "AuditLog_immutable"
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION korum_audit_log_guard();

-- `search_path` explícito, como el resto de las guardas (endurecimiento del Sprint 1.3).
DO $$
DECLARE
  v_schema   text := current_schema();
  v_function text;
BEGIN
  FOREACH v_function IN ARRAY ARRAY['korum_audit_log_guard()']
  LOOP
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path = %I, pg_catalog, pg_temp', v_schema, v_function, v_schema);
  END LOOP;
END
$$;

-- 4. Factura de proveedor adjunta: 6 años desde el cierre del ejercicio en que se adjuntó -----------------------------------------------------------
-- Antes se guardaba «adjuntada + 6 años»: el 1 de enero siguiente a esa fecha es «cierre del ejercicio de la adjunción + 6 años».
UPDATE "FileAsset"
   SET "retainUntil" = date_trunc('year', "retainUntil") + interval '1 year'
 WHERE "purpose" = 'PROVIDER_INVOICE'
   AND "deletedAt" IS NULL
   AND "retainUntil" IS NOT NULL
   AND "id" IN (SELECT "providerInvoiceFileId" FROM "EscrowPayout" WHERE "providerInvoiceFileId" IS NOT NULL)
   AND "retainUntil" <> date_trunc('year', "retainUntil");

-- 5. Votación de redimensionamiento: quien la lanzó se desvincula a los 6 años desde el cierre del ejercicio (tabla de plazos §3.7) ---------------
-- La guarda sigue igual; lo único nuevo es que admite vaciar `createdById` sin cambiar nada más, también con la votación cerrada.
CREATE OR REPLACE FUNCTION "resize_poll_keep_history"() RETURNS trigger AS $$
DECLARE
  v_same "ResizePoll"%ROWTYPE;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'Las votaciones de redimensionamiento no se vacían.';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Una votación de redimensionamiento no se borra (ResizePoll %).', OLD."id";
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' OR NOT EXISTS (SELECT 1 FROM "Initiative" i WHERE i."id" = NEW."initiativeId" AND i."status" = 'EXPIRED' AND i."format" = 'BUDGET') THEN
      RAISE EXCEPTION 'Solo se vota sobre una campaña de presupuesto vencida (iniciativa %).', NEW."initiativeId";
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.*) IS NOT DISTINCT FROM ROW(OLD.*) THEN
    RETURN NEW;
  END IF;
  IF NEW."createdById" IS NULL AND OLD."createdById" IS NOT NULL THEN
    v_same := NEW;
    v_same."createdById" := OLD."createdById";
    IF ROW(v_same.*) IS NOT DISTINCT FROM ROW(OLD.*) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NEW."initiativeId" IS DISTINCT FROM OLD."initiativeId" OR NEW."optionsJson"::text IS DISTINCT FROM OLD."optionsJson"::text OR NEW."closesAt" IS DISTINCT FROM OLD."closesAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."originalGoalCents" IS DISTINCT FROM OLD."originalGoalCents" OR NEW."raisedAtLaunchCents" IS DISTINCT FROM OLD."raisedAtLaunchCents"
     OR (OLD."talliedAt" IS NOT NULL AND NEW."talliedAt" IS DISTINCT FROM OLD."talliedAt") THEN
    RAISE EXCEPTION 'Las opciones, el plazo y los datos de lanzamiento de la votación % no cambian.', OLD."id";
  END IF;
  IF OLD."status" <> 'OPEN' THEN
    RAISE EXCEPTION 'La votación % ya está cerrada.', OLD."id";
  END IF;
  -- Abierta → abierta: solo el recuento, una vez. Después, la opción ganadora no cambia (salvo quedarse sin ninguna si al final no queda dinero).
  IF NEW."status" = 'OPEN' AND (OLD."talliedAt" IS NOT NULL OR NEW."talliedAt" IS NULL) THEN
    RAISE EXCEPTION 'La votación % solo cambia con su recuento (una vez) o al cerrarse.', OLD."id";
  END IF;
  IF OLD."talliedAt" IS NOT NULL AND NEW."winningOptionIndex" IS NOT NULL AND NEW."winningOptionIndex" IS DISTINCT FROM OLD."winningOptionIndex" THEN
    RAISE EXCEPTION 'La opción ganadora de la votación % ya no cambia.', OLD."id";
  END IF;
  IF NEW."winningOptionIndex" IS NOT NULL AND NEW."winningOptionIndex" >= jsonb_array_length(NEW."optionsJson") THEN
    RAISE EXCEPTION 'La opción ganadora de la votación % no es una de sus opciones.', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 6. Historial de relevos: se desvincula de las cuentas a los 6 años desde el cierre del ejercicio (tabla de plazos §3.9) ---------------------------------
-- Las personas de un relevo siguen sin poder cambiarse por otras; lo único nuevo es que un relevo **cerrado** admite cambiar sus tres cuentas por las marcas de
-- desvinculado (`src/core/privacy/retention-unlink.ts`, `UNLINKED_HANDOVER`), con el nombre ya anonimizado, sin tocar nada más.
CREATE OR REPLACE FUNCTION "signer_handover_keep_history"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Un relevo de firmantes no se borra (SignerHandover %).', OLD."id";
  END IF;
  IF OLD."status" NOT IN ('AWAITING_CONSENT', 'INVITED')
     AND NEW."id" = OLD."id"
     AND NEW."outgoingUserId" = 'desvinculado:sale' AND NEW."incomingUserId" = 'desvinculado:entra' AND NEW."proposedByUserId" = 'desvinculado:propone' AND NEW."displayName" = 'anonimizado'
     AND NEW."organizationId" IS NOT DISTINCT FROM OLD."organizationId" AND NEW."role" IS NOT DISTINCT FROM OLD."role" AND NEW."outgoingMemberId" IS NOT DISTINCT FROM OLD."outgoingMemberId"
     AND NEW."createdAt" IS NOT DISTINCT FROM OLD."createdAt" AND NEW."status" IS NOT DISTINCT FROM OLD."status" AND NEW."roleLabel" IS NOT DISTINCT FROM OLD."roleLabel"
     AND NEW."expiresAt" IS NOT DISTINCT FROM OLD."expiresAt" AND NEW."consentedAt" IS NOT DISTINCT FROM OLD."consentedAt" AND NEW."closedAt" IS NOT DISTINCT FROM OLD."closedAt" THEN
    RETURN NEW;
  END IF;
  IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId" OR NEW."role" IS DISTINCT FROM OLD."role" OR NEW."outgoingMemberId" IS DISTINCT FROM OLD."outgoingMemberId"
     OR NEW."outgoingUserId" IS DISTINCT FROM OLD."outgoingUserId" OR NEW."incomingUserId" IS DISTINCT FROM OLD."incomingUserId" OR NEW."proposedByUserId" IS DISTINCT FROM OLD."proposedByUserId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Las personas y el puesto de un relevo no se cambian (SignerHandover %).', OLD."id";
  END IF;
  IF OLD."status" NOT IN ('AWAITING_CONSENT', 'INVITED') AND (NEW."status" IS DISTINCT FROM OLD."status" OR NEW."roleLabel" IS DISTINCT FROM OLD."roleLabel"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" OR NEW."consentedAt" IS DISTINCT FROM OLD."consentedAt" OR NEW."closedAt" IS DISTINCT FROM OLD."closedAt") THEN
    RAISE EXCEPTION 'Un relevo de firmantes cerrado no se modifica (SignerHandover %).', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 7. `search_path` explícito (con pg_temp al final) en las dos guardas redefinidas: una tabla temporal no puede engañarlas (endurecimiento del Sprint 1.3).
DO $$
DECLARE
  v_schema   text := current_schema();
  v_function text;
BEGIN
  FOREACH v_function IN ARRAY ARRAY['resize_poll_keep_history()', 'signer_handover_keep_history()']
  LOOP
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path = %I, pg_catalog, pg_temp', v_schema, v_function, v_schema);
  END LOOP;
END
$$;

-- 8. Aceptaciones de los textos legales: además de no reescribirse, **solo se borra la de un alta que nunca verificó su email** (tabla de plazos §3.3 y §3.9: la purga
-- de los 7 días, y el «No he sido yo» cuando alguien ocupó con un alta sin verificar el email anterior de una cuenta), y la tabla no se vacía. La baja de una entidad (Sprint 5.10d) ampliará esta guarda con su propio plazo.
CREATE OR REPLACE FUNCTION "legal_acceptance_delete_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'KORUM_IMMUTABLE: las aceptaciones de los textos legales no se vacían' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."source" IN ('alta', 'cuenta')
     AND OLD."userId" IS NOT NULL
     AND EXISTS (SELECT 1 FROM "User" u WHERE u."id" = OLD."userId" AND u."emailVerified" = false AND u."gdprAnonymizedAt" IS NULL) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'KORUM_IMMUTABLE: una aceptación de un texto legal solo se borra con el alta sin verificar a la que pertenece (LegalAcceptance %)', OLD."id" USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LegalAcceptance_delete_guard"
  BEFORE DELETE ON "LegalAcceptance"
  FOR EACH ROW EXECUTE FUNCTION "legal_acceptance_delete_guard"();
CREATE TRIGGER "LegalAcceptance_no_truncate"
  BEFORE TRUNCATE ON "LegalAcceptance"
  FOR EACH STATEMENT EXECUTE FUNCTION "legal_acceptance_delete_guard"();

DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION %I.legal_acceptance_delete_guard() SET search_path = %I, pg_catalog, pg_temp', current_schema(), current_schema());
END
$$;
