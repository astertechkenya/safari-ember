CREATE TABLE "activities" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(60) NOT NULL,
	"name" varchar(100) NOT NULL,
	"summary" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"price_kes" integer NOT NULL,
	"seats" integer NOT NULL,
	"departure_times" varchar(5)[] NOT NULL,
	"weekdays" integer[] NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activities_price_check" CHECK ("activities"."price_kes" > 0),
	CONSTRAINT "activities_seats_check" CHECK ("activities"."seats" between 1 and 100),
	CONSTRAINT "activities_duration_check" CHECK ("activities"."duration_minutes" between 15 and 1440)
);
--> statement-breakpoint
CREATE TABLE "booking_activities" (
	"id" serial PRIMARY KEY NOT NULL,
	"booking_id" integer NOT NULL,
	"activity_id" integer NOT NULL,
	"day" date NOT NULL,
	"departs" varchar(5) NOT NULL,
	"people" integer NOT NULL,
	"price_kes" integer NOT NULL,
	CONSTRAINT "booking_activities_people_check" CHECK ("booking_activities"."people" between 1 and 100),
	CONSTRAINT "booking_activities_price_check" CHECK ("booking_activities"."price_kes" > 0),
	CONSTRAINT "booking_activities_departs_check" CHECK ("booking_activities"."departs" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);
--> statement-breakpoint
CREATE TABLE "booking_rooms" (
	"booking_id" integer NOT NULL,
	"room_type_id" integer NOT NULL,
	"units" integer NOT NULL,
	CONSTRAINT "booking_rooms_booking_id_room_type_id_pk" PRIMARY KEY("booking_id","room_type_id"),
	CONSTRAINT "booking_rooms_units_check" CHECK ("booking_rooms"."units" between 1 and 20)
);
--> statement-breakpoint
-- Hand-edited (Oct 2026): drizzle-kit's version dropped bookings.room_type_id without moving it,
-- and added booking_nights.room_type_id as NOT NULL to a table that already has rows. Instead:
-- every existing booking becomes one room of its old type, and its nights get that type too.
INSERT INTO "booking_rooms" ("booking_id", "room_type_id", "units")
  SELECT "id", "room_type_id", 1 FROM "bookings";--> statement-breakpoint
ALTER TABLE "booking_nights" ADD COLUMN "room_type_id" integer;--> statement-breakpoint
UPDATE "booking_nights" bn SET "room_type_id" = b."room_type_id" FROM "bookings" b WHERE b."id" = bn."booking_id";--> statement-breakpoint
ALTER TABLE "booking_nights" ALTER COLUMN "room_type_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_nights" DROP CONSTRAINT "booking_nights_booking_id_night_pk";--> statement-breakpoint
ALTER TABLE "booking_nights" ADD CONSTRAINT "booking_nights_booking_id_room_type_id_night_pk" PRIMARY KEY("booking_id","room_type_id","night");--> statement-breakpoint
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_room_type_id_room_types_id_fk";
--> statement-breakpoint
DROP INDEX "bookings_room_dates_idx";--> statement-breakpoint
ALTER TABLE "booking_activities" ADD CONSTRAINT "booking_activities_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_activities" ADD CONSTRAINT "booking_activities_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_rooms" ADD CONSTRAINT "booking_rooms_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_rooms" ADD CONSTRAINT "booking_rooms_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "public"."room_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "activities_slug_key" ON "activities" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_activities_once_key" ON "booking_activities" USING btree ("booking_id","activity_id","day","departs");--> statement-breakpoint
CREATE INDEX "booking_activities_departure_idx" ON "booking_activities" USING btree ("activity_id","day","departs");--> statement-breakpoint
CREATE INDEX "booking_rooms_room_idx" ON "booking_rooms" USING btree ("room_type_id");--> statement-breakpoint
ALTER TABLE "booking_nights" ADD CONSTRAINT "booking_nights_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "public"."room_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bookings_dates_idx" ON "bookings" USING btree ("check_in","check_out");--> statement-breakpoint
ALTER TABLE "bookings" DROP COLUMN "room_type_id";