-- Cash vs card tracking + linking expenses back to a specific income.
-- All columns are nullable so existing rows remain valid; the mobile UI treats
-- missing values as "not specified".

ALTER TABLE "HouseholdExpense" ADD COLUMN "paymentMethod" TEXT;
ALTER TABLE "HouseholdExpense" ADD COLUMN "fromIncomeId" TEXT;

ALTER TABLE "HouseholdIncome" ADD COLUMN "paymentMethod" TEXT;

CREATE INDEX "HouseholdExpense_fromIncomeId_idx" ON "HouseholdExpense"("fromIncomeId");

ALTER TABLE "HouseholdExpense"
  ADD CONSTRAINT "HouseholdExpense_fromIncomeId_fkey"
  FOREIGN KEY ("fromIncomeId") REFERENCES "HouseholdIncome"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
