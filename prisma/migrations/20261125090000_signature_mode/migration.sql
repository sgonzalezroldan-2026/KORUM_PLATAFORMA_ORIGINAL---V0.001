-- Sprint 5.2 · Firma única opcional y fin de la revisión de puestos por el Super-Admin (decisión del promotor, 2026-11-12).
-- Cada entidad elige cuántas firmas exige: DOUBLE (Dirección y Cofirma, por defecto) o SINGLE (solo Dirección, bajo su responsabilidad).
-- Los cambios de firmantes los resuelve la propia entidad, sin confirmación del Super-Admin: desaparece la marca de revisión pendiente.

CREATE TYPE "SignatureMode" AS ENUM ('DOUBLE', 'SINGLE');

ALTER TABLE "Organization" ADD COLUMN "signatureMode" "SignatureMode" NOT NULL DEFAULT 'DOUBLE';
ALTER TABLE "Organization" DROP COLUMN "seatReviewPendingAt";
