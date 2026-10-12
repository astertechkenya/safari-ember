# Safari Ember backend blueprint

Safari Ember becomes a working booking site: guests check live availability, pick a room,
pay a deposit (M-Pesa or card, sandbox) and get a confirmation; the lodge runs everything from
an admin area. It reuses NURA's stack and patterns, so every piece is something you have
already built once.

## Stack

| Part | Choice | Same as NURA? |
|---|---|---|
| API | Node 22 + Express 5, ES modules | yes |
| Database | Postgres on Neon, Drizzle ORM, SQL migrations committed in `api/drizzle/` | yes |
| Validation | Zod, on every request body and query | yes |
| Payments | M-Pesa STK push (Daraja) and Paystack cards, both in sandbox/test mode | yes |
| Email | Resend (test mode until there's a domain) | yes |
| Hosting | API on Render, site on Netlify with `/api/*` proxied to Render | yes |
| Tests | Vitest + Supertest against a real, throwaway Postgres database | yes |

## Folder layout (`C:\dev\safari-ember`)

```
frontend/   the site (index.html, videos, images): what Netlify serves
api/        the booking API: what Render runs
docs/       this blueprint, later the case study
server.py   local preview server (phones on your Wi-Fi)
```

## The booking rules

These are decisions, written down so the code and the tests can be checked against them.
Change any of them here first.

**Rooms.** A room *type* (Hearthside Room, Coalbed Suite, Ember Penthouse) has a number of
identical *units*. Guests book a type; the lodge assigns the actual room on arrival. That is
how most hotels sell, and it keeps availability a simple count.

| Room type | Units | Sleeps | Base rate (KES / night) |
|---|---|---|---|
| Hearthside Room | 12 | 2 | 28,000 |
| The Coalbed Suite | 6 | 3 | 45,000 |
| The Ember Penthouse | 1 | 4 | 120,000 |

(Placeholder numbers for the portfolio; the admin area will edit them.)

**Nights.** A stay from 12 to 15 March is the nights of 12, 13 and 14: check-out day is free
for the next guest. All dates are Nairobi dates (`Africa/Nairobi`), stored as plain `date`s,
never timestamps, so no time zone can shift a stay by a day.

**Limits.** 1 to 30 nights. Check-in from today (Nairobi) up to 18 months ahead. Guests from 1
up to the room type's "sleeps". Five or more guests need two rooms: the site will say so and
point to the enquiry form (multi-room booking can come later).

**Prices.** Each night costs the room type's base rate, unless a *seasonal rate* covers that
night (for example the migration season, July to October). The total is the sum of the
nights, so a stay that crosses into peak season is priced night by night, correctly.
All money is whole Kenyan shillings, stored as integers. No floating point anywhere.

**Deposit.** 30% of the total, rounded up to the next shilling, paid online to confirm. The
balance is paid at the lodge. (Setting: `DEPOSIT_PERCENT`.)

**Holds.** Starting a booking *holds* one unit for 15 minutes while the guest pays. Paid in
time: the booking is confirmed. Not paid: the hold expires and the unit is free again.
A held unit counts as taken, so two guests can never pay for the same last room.

**Overbooking protection.** The dangerous moment is two guests booking the last unit in the
same second. Both check, both see "1 left", both book. The fix: creating a booking locks that
room type's row in the database (`SELECT … FOR UPDATE`) inside a transaction, then counts
and inserts. A second booking for the same type waits for the first to finish, then counts
again and sees 0 left. Other room types are not blocked. The tests fire simultaneous bookings
at the last unit to prove only one wins.

**Closures.** The admin can block units for dates (maintenance, a private event, the whole
lodge closed). Blocked units count as taken.

**Booking reference.** Guests see a short reference like `SE-7K3QXM` (no 0/O or 1/I to misread
on the phone), never the database id. Their confirmation link is signed, like NURA's order
links, so nobody can open someone else's booking by guessing.

## Data model

```
room_types       id, slug, name, kind, description, sleeps, units, base_rate_kes, sort, active
seasonal_rates   id, room_type_id, starts_on, ends_on (exclusive), nightly_rate_kes, label
closures         id, room_type_id (null = every type), starts_on, ends_on (exclusive), units, reason
bookings         id, ref, room_type_id, check_in, check_out, guests, nights, total_kes, deposit_kes,
                 status, hold_expires_at, first_name, last_name, email, phone, requests,
                 created_at, confirmed_at, cancelled_at
booking_nights   booking_id, night, rate_kes        (the price of each night, frozen at booking time)
payments         (Phase 3) id, booking_id, provider, amount_kes, status, provider refs
enquiries        id, first_name, last_name, email, phone, subject, message, check_in, check_out,
                 guests, status, created_at
admins, sessions (Phase 5, as NURA)
```

Booking statuses: `HELD` → `CONFIRMED` (deposit paid) → `COMPLETED` (stayed), or `HELD` →
`EXPIRED`, or `CONFIRMED` → `CANCELLED`. A booking takes a unit while it is `HELD` (and not
past its hold) or `CONFIRMED`.

`booking_nights` freezes each night's price when the guest books, so changing a rate later
never changes what an existing guest owes.

## API

| Method & path | What it does |
|---|---|
| `GET /api/rooms` | Room types with their "from" price |
| `GET /api/availability?checkIn=…&checkOut=…&guests=…` | Each room type: available or not, units left (when few), nightly prices, total, deposit |
| `POST /api/bookings` | Hold a unit: room type, dates, guests, guest details → reference, amount due, hold expiry, signed link |
| `GET /api/bookings/:ref` (signed link) | The booking's status, for the confirmation page |
| `POST /api/bookings/:ref/pay` (Phase 3) | Start the deposit payment: M-Pesa prompt or Paystack page |
| `POST /api/enquiries` | The "Get in touch" form, saved and (Phase 4) emailed to the lodge |
| `/api/admin/*` (Phase 5) | Bookings, calendar, rooms, rates, closures, enquiries |

## Phases

1. **Foundation and booking engine.** The API skeleton (settings checked at startup, logs
   with no personal data, security headers, rate limits, same-origin checks, error format),
   the database, seed data, availability, pricing, holds with overbooking protection, hold
   expiry, enquiries. Tested against a real Postgres.
2. **Wire up the site.** The "Check Availability" bar shows real rooms and prices; guests pick
   one, enter their details and get a hold. The enquiry form posts to the API instead of
   Netlify Forms.
3. **Deposits.** M-Pesa and card, adapted from NURA: paying confirms the booking; a payment
   that arrives after the hold expired is handled safely (re-hold if still free, otherwise
   flagged for a refund).
4. **Emails.** Confirmation with the signed link, hold-expired notice, enquiry received,
   alerts to the lodge.
5. **Admin.** Sign-in with two-factor (as NURA), bookings list and calendar, check-in /
   cancel, rooms and rates, closures, enquiries inbox.
6. **Ship it.** Neon production database with a least-privilege app login, Render, Netlify
   proxy, uptime monitor, Sentry, and the case study.
