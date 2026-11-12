-- Sprint 5.2 · Ya no hay visto bueno de quien sale (decisión del promotor, 2026-11-12): los relevos que esperaban uno se cierran. La entidad puede proponerlos de nuevo y la invitación sale al momento.
UPDATE "SignerHandover" SET "status" = 'CANCELLED', "closedAt" = now() WHERE "status" = 'AWAITING_CONSENT';
