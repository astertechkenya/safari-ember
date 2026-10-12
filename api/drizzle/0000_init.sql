CREATE TYPE "public"."booking_status" AS ENUM('HELD', 'CONFIRMED', 'EXPIRED', 'CANCELLED', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."enquiry_status" AS ENUM('NEW', 'REPLIED', 'CLOSED');--> statement-breakpoint
CREATE TABLE "booking_nights" (
	"booking_id" integer NOT NULL,
	"night" date NOT NULL,
	"rate_kes" integer NOT NULL,
	CONSTRAINT "booking_nights_booking_id_night_pk" PRIMARY KEY("booking_id","night"),
	CONSTRAINT "booking_nights_rate_check" CHECK ("booking_nights"."rate_kes" > 0)
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" varchar(12) NOT NULL,
	"room_type_id" integer NOT NULL,
	"check_in" date NOT NULL,
	"check_out" date NOT NULL,
	"nights" integer NOT NULL,
	"guests" integer NOT NULL,
	"total_kes" integer NOT NULL,
	"deposit_kes" integer NOT NULL,
	"status" "booking_status" DEFAULT 'HELD' NOT NULL,
	"hold_expires_at" timestamp with time zone,
	"first_name" varchar(60) NOT NULL,
	"last_name" varchar(60) NOT NULL,
	"email" varchar(254) NOT NULL,
	"phone" varchar(20) NOT NULL,
	"requests" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "bookings_dates_check" CHECK ("bookings"."check_out" > "bookings"."check_in"),
	CONSTRAINT "bookings_nights_check" CHECK ("bookings"."nights" = "bookings"."check_out" - "bookings"."check_in"),
	CONSTRAINT "bookings_guests_check" CHECK ("bookings"."guests" between 1 and 20),
	CONSTRAINT "bookings_money_check" CHECK ("bookings"."total_kes" > 0 and "bookings"."deposit_kes" > 0 and "bookings"."deposit_kes" <= "bookings"."total_kes"),
	CONSTRAINT "bookings_hold_check" CHECK ("bookings"."status" <> 'HELD' or "bookings"."hold_expires_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "closures" (
	"id" serial PRIMARY KEY NOT NULL,
	"room_type_id" integer,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"units" integer,
	"reason" varchar(200) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "closures_dates_check" CHECK ("closures"."ends_on" > "closures"."starts_on"),
	CONSTRAINT "closures_units_check" CHECK ("closures"."units" is null or "closures"."units" > 0)
);
--> statement-breakpoint
CREATE TABLE "enquiries" (
	"id" serial PRIMARY KEY NOT NULL,
	"first_name" varchar(60) NOT NULL,
	"last_name" varchar(60) NOT NULL,
	"email" varchar(254) NOT NULL,
	"phone" varchar(20),
	"subject" varchar(120),
	"message" text NOT NULL,
	"check_in" date,
	"check_out" date,
	"guests" integer,
	"status" "enquiry_status" DEFAULT 'NEW' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enquiries_dates_check" CHECK ("enquiries"."check_in" is null or "enquiries"."check_out" is null or "enquiries"."check_out" > "enquiries"."check_in")
);
--> statement-breakpoint
CREATE TABLE "room_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(60) NOT NULL,
	"name" varchar(100) NOT NULL,
	"kind" varchar(40) NOT NULL,
	"description" text NOT NULL,
	"sleeps" integer NOT NULL,
	"units" integer NOT NULL,
	"base_rate_kes" integer NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_types_sleeps_check" CHECK ("room_types"."sleeps" between 1 and 20),
	CONSTRAINT "room_types_units_check" CHECK ("room_types"."units" >= 0),
	CONSTRAINT "room_types_rate_check" CHECK ("room_types"."base_rate_kes" > 0)
);
--> statement-breakpoint
CREATE TABLE "seasonal_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"room_type_id" integer NOT NULL,
	"label" varchar(80) NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"nightly_rate_kes" integer NOT NULL,
	CONSTRAINT "seasonal_rates_dates_check" CHECK ("seasonal_rates"."ends_on" > "seasonal_rates"."starts_on"),
	CONSTRAINT "seasonal_rates_rate_check" CHECK ("seasonal_rates"."nightly_rate_kes" > 0)
);
--> statement-breakpoint
ALTER TABLE "booking_nights" ADD CONSTRAINT "booking_nights_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "public"."room_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "closures" ADD CONSTRAINT "closures_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "public"."room_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seasonal_rates" ADD CONSTRAINT "seasonal_rates_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "public"."room_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_ref_key" ON "bookings" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "bookings_room_dates_idx" ON "bookings" USING btree ("room_type_id","check_in","check_out");--> statement-breakpoint
CREATE INDEX "bookings_status_idx" ON "bookings" USING btree ("status","hold_expires_at");--> statement-breakpoint
CREATE INDEX "closures_dates_idx" ON "closures" USING btree ("starts_on","ends_on");--> statement-breakpoint
CREATE INDEX "enquiries_status_idx" ON "enquiries" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "room_types_slug_key" ON "room_types" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "seasonal_rates_room_idx" ON "seasonal_rates" USING btree ("room_type_id","starts_on");