-- Sprint 5.10a · Textos legales publicados, archivo de versiones y aceptaciones (P17, L-057, L-020).
-- Cada versión que se publica desde la consola queda archivada tal como se publicó, con su huella y sus fechas, y no se puede reescribir ni borrar: lo que
-- aceptó cada persona o cada entidad se puede enseñar siempre. Cada aceptación apunta a una versión archivada (clave foránea), así que no se puede registrar
-- la aceptación de una versión que no se ha publicado.

CREATE TABLE "LegalDocumentVersion" (
    "id" SERIAL NOT NULL,
    "document" TEXT NOT NULL,
    "locale" "Locale" NOT NULL,
    "version" TEXT NOT NULL,
    "markdown" TEXT NOT NULL,
    "contentSha256" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "changeSummary" TEXT,
    CONSTRAINT "LegalDocumentVersion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LegalDocumentVersion_document_check" CHECK ("document" IN ('terminos', 'privacidad', 'cookies', 'aviso-legal', 'condiciones-entradas-y-vales', 'condiciones-aportacion-mensual', 'condiciones-entidades', 'condiciones-comercios', 'contrato-de-encargo')),
    CONSTRAINT "LegalDocumentVersion_version_check" CHECK ("version" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[1-9][0-9]{0,2})?$'),
    CONSTRAINT "LegalDocumentVersion_sha256_check" CHECK ("contentSha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "LegalDocumentVersion_markdown_check" CHECK (length("markdown") BETWEEN 1 AND 200000),
    CONSTRAINT "LegalDocumentVersion_effective_check" CHECK ("effectiveAt" >= "publishedAt"),
    CONSTRAINT "LegalDocumentVersion_summary_check" CHECK ("changeSummary" IS NULL OR length("changeSummary") BETWEEN 1 AND 500)
);

CREATE UNIQUE INDEX "LegalDocumentVersion_document_locale_version_key" ON "LegalDocumentVersion"("document", "locale", "version");
CREATE INDEX "LegalDocumentVersion_document_locale_publishedAt_idx" ON "LegalDocumentVersion"("document", "locale", "publishedAt");

CREATE TABLE "LegalAcceptance" (
    "id" SERIAL NOT NULL,
    "userId" TEXT,
    "organizationId" TEXT,
    "document" TEXT NOT NULL,
    "locale" "Locale" NOT NULL,
    "version" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LegalAcceptance_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LegalAcceptance_source_check" CHECK ("source" IN ('alta', 'cuenta', 'hucha'))
);

CREATE INDEX "LegalAcceptance_userId_idx" ON "LegalAcceptance"("userId");
CREATE INDEX "LegalAcceptance_organizationId_document_idx" ON "LegalAcceptance"("organizationId", "document");

ALTER TABLE "LegalAcceptance" ADD CONSTRAINT "LegalAcceptance_document_locale_version_fkey" FOREIGN KEY ("document", "locale", "version") REFERENCES "LegalDocumentVersion"("document", "locale", "version") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LegalAcceptance" ADD CONSTRAINT "LegalAcceptance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LegalAcceptance" ADD CONSTRAINT "LegalAcceptance_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- El archivo no se reescribe ni se borra, tampoco en bloque: es la prueba de lo que se publicó y de lo que aceptó cada persona.
CREATE OR REPLACE FUNCTION "legal_document_version_keep_history"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'KORUM_IMMUTABLE: % no está permitido en el archivo de textos legales; se publica una versión nueva', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql SET search_path FROM CURRENT;

CREATE TRIGGER "LegalDocumentVersion_keep_history"
  BEFORE UPDATE OR DELETE ON "LegalDocumentVersion"
  FOR EACH ROW EXECUTE FUNCTION "legal_document_version_keep_history"();

CREATE TRIGGER "LegalDocumentVersion_no_truncate"
  BEFORE TRUNCATE ON "LegalDocumentVersion"
  FOR EACH STATEMENT EXECUTE FUNCTION "legal_document_version_keep_history"();

-- Una aceptación no se reescribe. Lo único que admite es quedar sin cuenta detrás cuando la cuenta se borra (`ON DELETE SET NULL`).
CREATE OR REPLACE FUNCTION "legal_acceptance_keep_history"() RETURNS trigger AS $$
BEGIN
  IF NEW."userId" IS NULL
     AND NEW."id" = OLD."id"
     AND NEW."organizationId" IS NOT DISTINCT FROM OLD."organizationId"
     AND NEW."document" = OLD."document"
     AND NEW."locale" = OLD."locale"
     AND NEW."version" = OLD."version"
     AND NEW."source" = OLD."source"
     AND NEW."acceptedAt" = OLD."acceptedAt"
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'KORUM_IMMUTABLE: una aceptación de un texto legal no se reescribe (LegalAcceptance %)', OLD."id" USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql SET search_path FROM CURRENT;

CREATE TRIGGER "LegalAcceptance_keep_history"
  BEFORE UPDATE ON "LegalAcceptance"
  FOR EACH ROW EXECUTE FUNCTION "legal_acceptance_keep_history"();

-- Cada consentimiento guarda también el idioma del texto de la política que se aceptó: con la versión, identifica el texto archivado.
ALTER TABLE "ConsentRecord" ADD COLUMN "policyLocale" "Locale";

-- El ajuste `privacy.policyVersion` deja de existir: la versión de la política que guarda cada consentimiento sale ahora del archivo.
DELETE FROM "PlatformSetting" WHERE "key" = 'privacy.policyVersion';
