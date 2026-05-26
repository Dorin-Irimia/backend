-- CustomCategory: categorii personalizate per utilizator, sincronizate
-- cross-device. Acoperă atât expense, cât și income (vezi coloana `type`).

CREATE TABLE "CustomCategory" (
  "id" TEXT NOT NULL,
  "clientId" TEXT,
  "userId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "icon" TEXT NOT NULL DEFAULT '📌',
  "color" TEXT NOT NULL DEFAULT '#6B7280',
  "type" TEXT NOT NULL DEFAULT 'expense',
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomCategory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomCategory_userId_key_key" ON "CustomCategory"("userId", "key");
CREATE UNIQUE INDEX "CustomCategory_userId_clientId_key" ON "CustomCategory"("userId", "clientId");
CREATE INDEX "CustomCategory_userId_idx" ON "CustomCategory"("userId");

ALTER TABLE "CustomCategory"
  ADD CONSTRAINT "CustomCategory_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
