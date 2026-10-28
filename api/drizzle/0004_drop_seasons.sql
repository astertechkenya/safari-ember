-- Seasonal prices removed (Oct 2026): every night costs the room type's base rate.
-- Deliberately destructive: the seasons themselves are deleted. Existing bookings are untouched,
-- because each booked night's price is frozen in booking_nights.
-- CASCADE only removes the table's own index, checks and its link to room_types; nothing points at it.
DROP TABLE "seasonal_rates" CASCADE;
