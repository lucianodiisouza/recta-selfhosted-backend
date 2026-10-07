-- CreateEnum
CREATE TYPE "ShareDirection" AS ENUM ('THEY_OWE_ME', 'I_OWE_THEM');

-- CreateEnum
CREATE TYPE "SettlementDirection" AS ENUM ('RECEIVED', 'PAID');

-- CreateTable
CREATE TABLE "people" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "user_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "people_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "person_aliases" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "is_name" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "person_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction_shares" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "direction" "ShareDirection" NOT NULL,
    "source" VARCHAR(10) NOT NULL DEFAULT 'manual',
    "note" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transaction_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlements" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "direction" "SettlementDirection" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "date" DATE NOT NULL,
    "transaction_id" UUID,
    "note" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "people_household_id_idx" ON "people"("household_id");

-- CreateIndex
CREATE INDEX "person_aliases_person_id_idx" ON "person_aliases"("person_id");

-- CreateIndex
CREATE UNIQUE INDEX "person_aliases_household_id_key_key" ON "person_aliases"("household_id", "key");

-- CreateIndex
CREATE INDEX "transaction_shares_household_id_person_id_idx" ON "transaction_shares"("household_id", "person_id");

-- CreateIndex
CREATE INDEX "transaction_shares_transaction_id_idx" ON "transaction_shares"("transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_shares_transaction_id_person_id_direction_key" ON "transaction_shares"("transaction_id", "person_id", "direction");

-- CreateIndex
CREATE UNIQUE INDEX "settlements_transaction_id_key" ON "settlements"("transaction_id");

-- CreateIndex
CREATE INDEX "settlements_household_id_person_id_idx" ON "settlements"("household_id", "person_id");

-- AddForeignKey
ALTER TABLE "people" ADD CONSTRAINT "people_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "people" ADD CONSTRAINT "people_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person_aliases" ADD CONSTRAINT "person_aliases_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_shares" ADD CONSTRAINT "transaction_shares_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_shares" ADD CONSTRAINT "transaction_shares_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;



-- Amounts are always positive: the direction carries the sign
ALTER TABLE "transaction_shares" ADD CONSTRAINT "transaction_shares_amount_positive" CHECK ("amount" > 0);

ALTER TABLE "settlements" ADD CONSTRAINT "settlements_amount_positive" CHECK ("amount" > 0);
