-- Sprint 3.9 · FAQ y soporte: el tema de la consulta (para enrutarla y para abrir la solicitud RGPD de rectificación) y el índice con el que
-- una persona ve sus consultas por el email verificado de su cuenta.
CREATE TYPE "SupportTopic" AS ENUM ('INITIATIVE', 'PAYMENT', 'ACCOUNT', 'RECTIFICATION', 'OTHER');

ALTER TABLE "SupportTicket" ADD COLUMN "topic" "SupportTopic" NOT NULL DEFAULT 'OTHER';

CREATE INDEX "SupportTicket_senderEmail_createdAt_idx" ON "SupportTicket"("senderEmail", "createdAt");
