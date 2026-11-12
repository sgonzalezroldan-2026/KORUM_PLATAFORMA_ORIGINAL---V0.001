-- Sprint 5.2 · Pop-up ejecutivo y ficha 360º de la consola.
-- Alerta para el relevo de una persona firmante que caduca sin cerrarse (heredado del Sprint 4.2e): la lleva soporte con el Super-Admin.

ALTER TYPE "OpsAlertType" ADD VALUE 'SIGNER_HANDOVER_EXPIRED';
