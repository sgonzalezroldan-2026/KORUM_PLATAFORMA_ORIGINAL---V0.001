-- Sprint 5.5b · Aviso a los buscadores con IndexNow y recordatorio escalado de las campañas vencidas sin decidir.
-- `indexNowStatus` guarda el estado de la iniciativa en el último aviso aceptado: la tarea diaria y la publicación avisan solo de lo que ha cambiado.
-- Las iniciativas que ya existían empiezan sin aviso (`NULL`): el primer barrido con la clave configurada avisa de todas las públicas una vez.

ALTER TABLE "Initiative" ADD COLUMN "indexNowStatus" "InitiativeStatus";

-- Alerta de la consola para una campaña vencida que sigue sin decisión cerca del final de la ventana de 90 días.
ALTER TYPE "OpsAlertType" ADD VALUE 'EXPIRED_DECISION_PENDING';
