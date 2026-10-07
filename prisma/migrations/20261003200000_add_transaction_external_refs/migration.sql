-- CreateTable
CREATE TABLE "transaction_external_refs" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "ref" VARCHAR(120) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transaction_external_refs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "transaction_external_refs_transaction_id_idx" ON "transaction_external_refs"("transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_external_refs_household_id_ref_key" ON "transaction_external_refs"("household_id", "ref");

-- AddForeignKey
ALTER TABLE "transaction_external_refs" ADD CONSTRAINT "transaction_external_refs_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
