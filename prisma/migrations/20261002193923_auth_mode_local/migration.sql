-- AlterTable
ALTER TABLE "users" ADD COLUMN     "password_hash" TEXT,
ALTER COLUMN "firebase_uid" DROP NOT NULL;
