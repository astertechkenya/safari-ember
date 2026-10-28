-- Refunds (Oct 2026): a wrong-amount payment the lodge sent back becomes REFUNDED.
-- Clean-up, deliberately destructive: closures are handled physically by the lodge (nothing in
-- the admin ever created one), and every trip runs daily, so the weekdays column goes too.
ALTER TYPE "public"."payment_status" ADD VALUE 'REFUNDED';--> statement-breakpoint
DROP TABLE "closures" CASCADE;--> statement-breakpoint
ALTER TABLE "activities" DROP COLUMN "weekdays";