-- Sprint 3.2 · Alta autónoma de entidades: municipio y código postal para el buscador de la portada.
ALTER TABLE "Organization" ADD COLUMN "city" TEXT;
ALTER TABLE "Organization" ADD COLUMN "postalCode" TEXT;

-- Better Auth 1.7 · doble factor: el secreto solo cuenta tras el primer código correcto, y los fallos seguidos bloquean un tiempo.
ALTER TABLE "TwoFactor" ADD COLUMN "verified" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "TwoFactor" ADD COLUMN "failedVerificationCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TwoFactor" ADD COLUMN "lockedUntil" TIMESTAMP(3);
