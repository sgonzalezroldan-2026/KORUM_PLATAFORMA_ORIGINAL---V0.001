-- Sprint 2.6 · Bandeja de salida y emails transaccionales.

-- Alerta de operación: la bandeja no puede enviar (proveedor sin configurar, plantilla desconocida o reintentos agotados).
ALTER TYPE "OpsAlertType" ADD VALUE 'EMAIL_DELIVERY_FAILED';
