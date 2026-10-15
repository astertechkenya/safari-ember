CREATE TYPE "public"."payment_provider" AS ENUM('DARAJA', 'PAYSTACK');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('PENDING', 'PAID', 'FAILED', 'FLAGGED');--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" integer NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"status" "payment_status" DEFAULT 'PENDING' NOT NULL,
	"amount_kes" integer NOT NULL,
	"received_kes" integer,
	"phone" varchar(20),
	"provider_ref" varchar(100),
	"receipt" varchar(60),
	"result_code" varchar(30),
	"failure_reason" text,
	"raw" jsonb,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_check" CHECK ("payments"."amount_kes" > 0)
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "refund_due" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_ref_key" ON "payments" USING btree ("provider_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_one_pending_key" ON "payments" USING btree ("booking_id") WHERE "payments"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "payments_booking_idx" ON "payments" USING btree ("booking_id","created_at");--> statement-breakpoint
CREATE INDEX "payments_open_idx" ON "payments" USING btree ("status","provider","created_at");--> statement-breakpoint
CREATE INDEX "payments_phone_idx" ON "payments" USING btree ("phone","created_at");