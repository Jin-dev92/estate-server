-- DropIndex
DROP INDEX "OutboxEvent_status_createdAt_idx";

-- AlterTable
ALTER TABLE "OutboxEvent" ADD COLUMN     "failedAt" TIMESTAMP(3),
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "OutboxEvent_status_nextAttemptAt_idx" ON "OutboxEvent"("status", "nextAttemptAt");
