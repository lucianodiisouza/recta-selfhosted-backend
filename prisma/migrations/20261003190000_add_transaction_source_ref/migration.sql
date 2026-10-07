-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "source_ref" VARCHAR(120);

-- CreateIndex
CREATE UNIQUE INDEX "transactions_household_id_source_ref_key" ON "transactions"("household_id", "source_ref");
