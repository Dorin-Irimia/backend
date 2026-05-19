-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "isAvailable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "lastEffectiveState" TEXT,
ADD COLUMN     "purchaseDate" TEXT,
ADD COLUMN     "purchaseKm" INTEGER,
ADD COLUMN     "unavailableFrom" TEXT,
ADD COLUMN     "unavailableReason" TEXT,
ADD COLUMN     "unavailableUntil" TEXT;
