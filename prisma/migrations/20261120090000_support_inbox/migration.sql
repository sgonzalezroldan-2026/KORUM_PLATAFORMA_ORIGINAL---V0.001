-- Sprint 4.4c · Bandeja de soporte del centro. Las consultas de las familias a su entidad ya existían (`target = ORGANIZATION`); ahora la entidad las
-- contesta desde su panel y escribe a KORUM por un buzón propio.
--  · `fromOrganization`: la consulta la abre la propia entidad (hacia KORUM). Sin esta marca, una consulta de una familia dirigida a KORUM (`PAYMENT`,
--    `ACCOUNT`…) guarda también el `organizationId` del centro y no habría forma de distinguirla de una escrita por el centro.
--  · `repliedAt`: cuándo contestó el centro (una sola respuesta por consulta).
--  · `resolvedAt`: cuándo se cerró; el plazo de conservación de 2 años cuenta desde aquí y no desde `updatedAt` (que cambia con cualquier retoque).

ALTER TABLE "SupportTicket" ADD COLUMN "fromOrganization" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SupportTicket" ADD COLUMN "repliedAt" TIMESTAMP(3);
ALTER TABLE "SupportTicket" ADD COLUMN "resolvedAt" TIMESTAMP(3);

-- Lo ya resuelto: se cierra en la última fecha conocida. Lo ya contestado: idem.
UPDATE "SupportTicket" SET "resolvedAt" = "updatedAt" WHERE "status" = 'RESOLVED';
UPDATE "SupportTicket" SET "repliedAt" = "updatedAt" WHERE "replyMessage" IS NOT NULL;

ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_resolved_matches_status" CHECK (("status" = 'RESOLVED') = ("resolvedAt" IS NOT NULL));
-- Una consulta de la entidad siempre va a KORUM y tiene entidad: la bandeja del centro nunca la lista como suya.
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_from_organization_target" CHECK (NOT "fromOrganization" OR "target" = 'SUPERADMIN');

CREATE INDEX "SupportTicket_organizationId_target_fromOrganization_status_idx" ON "SupportTicket"("organizationId", "target", "fromOrganization", "status");
