-- Sprint 5.2 · Baja de un puesto de firma con revisión pendiente.
-- Tras dar de baja a una de las dos personas que firman, la entidad queda marcada hasta que el Super-Admin confirma a las dos personas que firman:
-- mientras tanto no se paga a proveedores desde esa entidad (solo a su cuenta en Paycomet).

ALTER TABLE "Organization" ADD COLUMN "seatReviewPendingAt" TIMESTAMP(3);
