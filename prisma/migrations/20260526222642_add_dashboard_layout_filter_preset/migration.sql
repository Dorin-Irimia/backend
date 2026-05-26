-- DashboardLayout: layout personalizat de widget-uri pentru dashboard-ul web.
CREATE TABLE "DashboardLayout" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL DEFAULT 'Implicit',
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "layout" JSONB NOT NULL DEFAULT '[]',
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DashboardLayout_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DashboardLayout_userId_idx" ON "DashboardLayout"("userId");

ALTER TABLE "DashboardLayout"
  ADD CONSTRAINT "DashboardLayout_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- FilterPreset: rapoarte salvate (criterii, coloane, sortare) per entitate.
CREATE TABLE "FilterPreset" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "entity" TEXT NOT NULL,
  "config" JSONB NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FilterPreset_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FilterPreset_userId_entity_idx" ON "FilterPreset"("userId", "entity");

ALTER TABLE "FilterPreset"
  ADD CONSTRAINT "FilterPreset_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
