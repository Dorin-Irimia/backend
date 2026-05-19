-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN "clientId" TEXT;

-- AlterTable
ALTER TABLE "Document" ADD COLUMN "clientId" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN "clientId" TEXT;

-- AlterTable
ALTER TABLE "Reminder" ADD COLUMN "clientId" TEXT;

-- AlterTable
ALTER TABLE "FuelLog" ADD COLUMN "clientId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_userId_clientId_key" ON "Vehicle"("userId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "Document_userId_clientId_key" ON "Document"("userId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_userId_clientId_key" ON "Invoice"("userId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "Reminder_userId_clientId_key" ON "Reminder"("userId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "FuelLog_userId_clientId_key" ON "FuelLog"("userId", "clientId");
