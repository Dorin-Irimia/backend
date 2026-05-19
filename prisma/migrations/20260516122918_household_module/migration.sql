-- AlterTable
ALTER TABLE "Attachment" ADD COLUMN     "householdExpenseId" TEXT;

-- CreateTable
CREATE TABLE "Household" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "photo" TEXT,
    "type" TEXT NOT NULL DEFAULT 'apartament',
    "rooms" INTEGER,
    "surface" DOUBLE PRECISION,
    "monthlyBudget" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Household_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HouseholdMember" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "addedById" TEXT,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HouseholdMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HouseholdExpense" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "userId" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RON',
    "category" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "time" TEXT,
    "merchant" TEXT,
    "location" TEXT,
    "notes" TEXT,
    "customFields" JSONB,
    "splitMode" TEXT DEFAULT 'single',
    "splitShares" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HouseholdExpense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HouseholdIncome" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "userId" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RON',
    "category" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "source" TEXT,
    "recurring" TEXT NOT NULL DEFAULT 'none',
    "notes" TEXT,
    "customFields" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HouseholdIncome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HouseholdEvent" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "userId" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "startDate" TEXT NOT NULL,
    "startTime" TEXT,
    "endDate" TEXT,
    "endTime" TEXT,
    "location" TEXT,
    "notes" TEXT,
    "isDone" BOOLEAN NOT NULL DEFAULT false,
    "reminderMinutes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HouseholdEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Household_userId_clientId_key" ON "Household"("userId", "clientId");

-- CreateIndex
CREATE INDEX "HouseholdMember_userId_idx" ON "HouseholdMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "HouseholdMember_householdId_userId_key" ON "HouseholdMember"("householdId", "userId");

-- CreateIndex
CREATE INDEX "HouseholdExpense_householdId_idx" ON "HouseholdExpense"("householdId");

-- CreateIndex
CREATE UNIQUE INDEX "HouseholdExpense_userId_clientId_key" ON "HouseholdExpense"("userId", "clientId");

-- CreateIndex
CREATE INDEX "HouseholdIncome_householdId_idx" ON "HouseholdIncome"("householdId");

-- CreateIndex
CREATE UNIQUE INDEX "HouseholdIncome_userId_clientId_key" ON "HouseholdIncome"("userId", "clientId");

-- CreateIndex
CREATE INDEX "HouseholdEvent_householdId_idx" ON "HouseholdEvent"("householdId");

-- CreateIndex
CREATE UNIQUE INDEX "HouseholdEvent_userId_clientId_key" ON "HouseholdEvent"("userId", "clientId");

-- CreateIndex
CREATE INDEX "Attachment_householdExpenseId_idx" ON "Attachment"("householdExpenseId");

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_householdExpenseId_fkey" FOREIGN KEY ("householdExpenseId") REFERENCES "HouseholdExpense"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Household" ADD CONSTRAINT "Household_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HouseholdMember" ADD CONSTRAINT "HouseholdMember_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HouseholdMember" ADD CONSTRAINT "HouseholdMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HouseholdMember" ADD CONSTRAINT "HouseholdMember_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HouseholdExpense" ADD CONSTRAINT "HouseholdExpense_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HouseholdExpense" ADD CONSTRAINT "HouseholdExpense_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HouseholdIncome" ADD CONSTRAINT "HouseholdIncome_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HouseholdIncome" ADD CONSTRAINT "HouseholdIncome_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HouseholdEvent" ADD CONSTRAINT "HouseholdEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HouseholdEvent" ADD CONSTRAINT "HouseholdEvent_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
