-- Sprint 2.4 · Operación: tareas programadas, alertas de operación y envío de facturas.

-- Nuevos tipos de tarea.
ALTER TYPE "JobType" ADD VALUE 'QUOTA_RENEWAL';
ALTER TYPE "JobType" ADD VALUE 'TICKET_HOLD_RELEASE';
ALTER TYPE "JobType" ADD VALUE 'INVOICE_SUBMIT';
ALTER TYPE "JobType" ADD VALUE 'OPS_HOUSEKEEPING';

-- CreateEnum
CREATE TYPE "OpsAlertType" AS ENUM ('JOB_FAILED', 'REFUND_REJECTED', 'REFUND_STUCK', 'SPLIT_WINDOW_EXPIRING', 'RECONCILIATION_MISMATCH', 'CHARGEBACK_UNCONFIRMED', 'INVOICE_STUCK', 'SPONSOR_RENEWAL_DUE', 'CREDIT_POOL_EXPIRED', 'MONTHLY_TOPUP_DUE');

-- CreateEnum
CREATE TYPE "OpsAlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "OpsAlertStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateTable
CREATE TABLE "OpsAlert" (
    "id" TEXT NOT NULL,
    "type" "OpsAlertType" NOT NULL,
    "severity" "OpsAlertSeverity" NOT NULL,
    "status" "OpsAlertStatus" NOT NULL DEFAULT 'OPEN',
    "dedupeKey" TEXT NOT NULL,
    "organizationId" TEXT,
    "targetType" TEXT,
    "targetId" TEXT,
    "detailJson" JSONB NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "OpsAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OpsAlert_dedupeKey_key" ON "OpsAlert"("dedupeKey");

-- CreateIndex
CREATE INDEX "OpsAlert_status_severity_lastSeenAt_idx" ON "OpsAlert"("status", "severity", "lastSeenAt");

-- CreateIndex
CREATE INDEX "OpsAlert_organizationId_idx" ON "OpsAlert"("organizationId");

-- AddForeignKey
ALTER TABLE "OpsAlert" ADD CONSTRAINT "OpsAlert_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Momento en que una factura pasó a `SENT`: permite avisar de los envíos de resultado desconocido.
ALTER TABLE "Invoice" ADD COLUMN "sentAt" TIMESTAMP(3);

-- Índices para las purgas y los barridos de las tareas programadas.
CREATE INDEX "RateLimit_lastRequest_idx" ON "RateLimit"("lastRequest");
CREATE INDEX "DoubleCheckChallenge_expiresAt_idx" ON "DoubleCheckChallenge"("expiresAt");
CREATE INDEX "Contribution_status_refundSendingAt_idx" ON "Contribution"("status", "refundSendingAt");
