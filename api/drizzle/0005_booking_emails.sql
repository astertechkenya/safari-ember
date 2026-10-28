CREATE TABLE "booking_emails" (
	"booking_id" integer NOT NULL,
	"kind" varchar(30) NOT NULL,
	"status" varchar(10) DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_emails_booking_id_kind_pk" PRIMARY KEY("booking_id","kind")
);
--> statement-breakpoint
ALTER TABLE "booking_emails" ADD CONSTRAINT "booking_emails_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;