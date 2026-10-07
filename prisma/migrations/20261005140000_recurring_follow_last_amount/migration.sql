-- Recurrences can follow the last real value: editing the most recent occurrence updates the recurrence amount.
-- Additive only; existing recurrences keep the old behaviour (false).
ALTER TABLE "recurring_transactions" ADD COLUMN "follow_last_amount" BOOLEAN NOT NULL DEFAULT false;
