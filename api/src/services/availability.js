// availability.js: how many units of a room type are free for EVERY night of a stay.
//
// For each night of the stay, per room type:
//     free = units − units held by bookings that night
// (a booking can hold several units of a type: booking_rooms.units)
// and a stay is possible only if the SMALLEST of those is at least 1: one fully booked night
// in the middle blocks the whole stay.
//
// "Holding a unit" = CONFIRMED, or HELD with a hold that hasn't run out yet. A hold past its
// expiry stops counting at that very second, whether or not the expiry job (jobs/index.js) has
// tidied it into EXPIRED yet. So availability never waits on a timer.
//
// A booking occupies the nights check_in ≤ night < check_out: the check-out day is free for the
// next guest. (Closing rooms is handled physically by the lodge, not here: decided Oct 2026.
// To stop selling a room type, untick "Bookable" or lower its units in the admin.)
//
// One query does the whole calculation inside Postgres, for one room type or all of them.
// `executor` is the database or a transaction: booking creation (services/bookings.js) runs it
// inside its transaction, after locking the room type, so the count it sees can't go stale.
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

/**
 * @returns Map roomTypeId → units free on every night of [checkIn, checkOut)  (never below 0)
 */
export async function freeUnits({ checkIn, checkOut, roomTypeId = null, executor = db }) {
  const { rows } = await executor.execute(sql`
    with nights as (
      select generate_series(${checkIn}::date, ${checkOut}::date - 1, interval '1 day')::date as night
    )
    select rt.id as room_type_id,
           min(greatest(0, rt.units - taken.n))::int as free
      from room_types rt
     cross join nights
     cross join lateral (
            select coalesce(sum(br.units), 0)::int as n
              from booking_rooms br
              join bookings b on b.id = br.booking_id
             where br.room_type_id = rt.id
               and b.check_in <= nights.night and b.check_out > nights.night
               and (b.status = 'CONFIRMED' or (b.status = 'HELD' and b.hold_expires_at > now()))
          ) taken
     where rt.active
       and (${roomTypeId}::int is null or rt.id = ${roomTypeId}::int)
     group by rt.id`);
  return new Map(rows.map((r) => [Number(r.room_type_id), Number(r.free)]));
}
