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

**Limits.** 1 to 30 nights. Check-in from today (Nairobi) up to 18 months ahead. Up to 6 rooms
in one booking (`MAX_ROOMS`), mixing types freely; the rooms chosen must sleep the whole party.
Larger groups send an enquiry.

**Prices.** Each night costs the room type's base rate, unless a *seasonal rate* covers that
night (for example the migration season, July to October). The total is the sum of the
nights, so a stay that crosses into peak season is priced night by night, correctly.
All money is whole Kenyan shillings, stored as integers. No floating point anywhere.

**Deposit.** 30% of the total, rounded up to the next shilling, paid online to confirm. The
balance is paid at the lodge. (Setting: `DEPOSIT_PERCENT`.)

**Holds.** Starting a booking *holds* its rooms (and trip seats) for 15 minutes while the guest pays. Paid in
time: the booking is confirmed. Not paid: the hold expires and the unit is free again.
A held unit counts as taken, so two guests can never pay for the same last room.

**One clock decides holds: the database's.** Holds are created, counted, expired and checked
with Postgres's `now()`, never the API server's clock. Render and Neon are two machines whose
clocks drift apart; if the API judged "has this hold run out?" by its own slow clock, a late
deposit could confirm a hold whose room the database had already given to someone else. Tests
run the API's clock five minutes slow to prove it (`withHoldRunning` in `services/capacity.js`).

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
bookings         id, ref, check_in, check_out, guests, nights, total_kes, deposit_kes,
                 status, hold_expires_at, first_name, last_name, email, phone, requests,
                 created_at, confirmed_at, cancelled_at, refund_due
booking_rooms    booking_id, room_type_id, units    (which rooms, how many of each)
booking_nights   booking_id, room_type_id, night, rate_kes   (price of one unit that night, frozen)
activities       id, slug, name, summary, duration_minutes, price_kes (per person), seats,
                 departure_times (HH:MM[]), weekdays (1 = Mon … 7 = Sun), sort, active
booking_activities id, booking_id, activity_id, day, departs, people, price_kes (frozen)
payments         id, booking_id, provider (DARAJA | PAYSTACK), status, amount_kes, received_kes,
                 phone, provider_ref, receipt, result_code, failure_reason, raw, checked_at, created_at
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
| `GET /api/activities?checkIn=…&checkOut=…` | Trips that can be added to that stay, each departure with seats left |
| `POST /api/bookings` | Hold rooms (`rooms: [{ room, units }]`) plus optional trips (`activities: [{ activity, day, time, people }]`), dates, guests, guest details → reference, amount due, hold expiry, signed link |
| `GET /api/bookings/:ref` (signed link) | The booking's status, for the confirmation page |
| `POST /api/bookings/:ref/pay` (signed link) | Start the deposit payment: `{ method: 'mpesa', phone? }` sends a prompt; `{ method: 'card' }` returns Paystack's page address |
| `POST /api/payments/mpesa/callback/:secret` | Safaricom's result (a hint: we then ask Safaricom ourselves) |
| `POST /api/payments/paystack/webhook` | Paystack's signed events (a hint: we then ask Paystack ourselves) |
| `POST /api/enquiries` | The "Get in touch" form, saved and (Phase 4) emailed to the lodge |
| `/api/admin/*` (Phase 5) | Bookings, calendar, rooms, rates, closures, enquiries |

## Deposits (Phase 3)

**Nothing is paid on anyone's word.** Safaricom's callback, Paystack's webhook and the booking
page asking "is it paid yet?" all lead to the same step: the API asks the provider itself
(M-Pesa STK query, Paystack verify) with our own credentials, and records what it says. A
forged callback can't confirm a booking.

**One attempt at a time.** A booking has at most one `PENDING` payment (a unique index, so two
quick taps can't make two). Six attempts per booking, five M-Pesa prompts per number per hour.
Switching from an unfinished card page to M-Pesa first checks the card wasn't paid after all.

**Settles once.** Every status change is a conditional update (`… where status = 'PENDING'`)
under a row lock, taken in a fixed order (payment → booking → room types by id → activities
by id, see `services/capacity.js`), so racing answers can't settle a payment twice or deadlock.

**What a paid deposit does:**

| Booking when the money arrives | Result |
|---|---|
| `HELD`, hold still running | `CONFIRMED` |
| Hold ran out, rooms and seats still free | `CONFIRMED` (re-checked under the same locks as a new booking) |
| Hold ran out, a room or seat taken meanwhile | `EXPIRED` with `refund_due`; the guest's page says a refund is coming |
| Already `CONFIRMED` or `CANCELLED` | `refund_due` (a duplicate or late deposit) |
| Different amount or currency | Payment `FLAGGED`, booking unchanged: a person decides |

**Grace.** Starting a payment extends the hold to at least 5 minutes from then
(`PAYMENT_GRACE_MINUTES`), so a guest typing their PIN in the last seconds isn't cut off. An
expired booking can start paying again only if its room is still free.

**Who notices.** The booking page polls while a payment is pending (the API asks the provider
at most every 4 seconds however often it's asked). The minute job checks M-Pesa payments with
no callback after a minute and card payments after two, and gives up on card pages left open
for an hour. On a laptop Safaricom can't reach the callback, so the page's polling settles.

**Sandbox.** In Daraja's sandbox the prompt asks for KES 1 (`DARAJA_SANDBOX_AMOUNT_KES`); the
page says so. Paystack test keys take Paystack's test cards. Production refuses to start with a
Paystack test key alongside live Daraja.

**Refunds are manual for now.** `refund_due` bookings and `FLAGGED` payments will be listed in
the admin (Phase 5); until then, they're in the database and the logs (`refund due`, `FLAGGED`).

## Several rooms and experiences (Phase 3b, Oct 2026)

**Several rooms.** A booking lists room types and how many of each (2 Hearthside + 1 Coalbed).
Each type is checked and priced on its own; `booking_nights` holds one row per type per night,
the price of one unit, so the total is units × nights. Search returns, per type, how many the
guest may pick (`maxUnits`) and whether the free rooms can sleep the party at all (`partyFits`).

**Experiences are add-ons.** Trips (Nairobi National Park game drive, Giraffe Centre, Nairobi
Safari Walk) can only be added to a room booking, never booked alone. Each leaves at set times
on set weekdays (Nairobi time), with a fixed number of seats per departure. Rules:

- Any day from check-in to check-out *inclusive* (a morning drive before an 11:00 check-out).
- Bookable until `ACTIVITY_CUTOFF_MINUTES` (default 120) before it leaves.
- People per trip: 1 up to the party size. Priced per person, frozen at booking time.
- Seats count exactly like rooms: taken while `CONFIRMED` or `HELD` with a live hold.
- Gate and entry fees are paid at the gate, not to the lodge; the summaries say so.

**Deadlocks.** A booking now locks several rows, so every path takes them in one order:
payment → booking → room types (by id) → activities (by id). Tests fire two bookings that
want the same two room types in opposite orders, and the last seats from two sides at once.

**Migration `0002_multiroom_activities`** moves each existing booking's room into
`booking_rooms` (1 unit) and stamps its nights with that type before dropping
`bookings.room_type_id`. Rehearsed on a copy of the dev database: every booking, night and
total survived.

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
   flagged for a refund). **3b:** several rooms per booking, and experiences as add-ons.
4. **Emails.** Confirmation with the signed link, hold-expired notice, enquiry received,
   alerts to the lodge.
5. **Admin.** Sign-in with two-factor (as NURA), bookings list and calendar, check-in /
   cancel, rooms and rates, closures, enquiries inbox.
6. **Ship it.** Neon production database with a least-privilege app login, Render, Netlify
   proxy, uptime monitor, Sentry, and the case study.

## Admin design (Phase 5, prototype done Oct 2026)

The admin is designed and clickable before the backend exists: `frontend/admin/index.html`,
running on sample data shaped exactly like the tables above. Phase 5 swaps the sample data
for `/api/admin/*` calls; the screens stay as they are.

**Decisions.** Calm dark ember look (the site's warm black and ember, but plain sans-serif for
data, no decorative motion, all text at least 4.5:1 contrast). Desktop first for the reception
computer, but every screen works on a phone (drawer menu, bookings as cards, scrolling calendar).
Not linked from the site and marked `noindex`.

| Screen | What it does |
|---|---|
| Sign-in | Email + password, then a 6-digit authenticator code; backup codes for a lost phone |
| Today | Arrivals (check in), departures (check out), in house, tonight's occupancy, holds with live countdown, new enquiries |
| Bookings | Search by name, reference, email or phone; filter by status and room type |
| Booking | Stay, guest, frozen nightly prices, deposit and balance due, history, check in / out, cancel (with reason), resend email, copy guest link |
| Calendar | Rooms free per night for three weeks, season band, closures hatched; a night lists who is staying |
| Rooms & rates | Base rate, units and "bookable" per room type; seasonal rates list and add form |
| Closures | List with a warning when confirmed bookings overlap; close dates by room type or whole lodge |
| Enquiries | Inbox with unread marks, reply by email, mark as handled |

**Schema changes the admin needs (Phase 5 migration).**
- `bookings.checked_in_at` (timestamp, null until arrival). "In house" = `CONFIRMED` + checked in.
  Check-out sets `COMPLETED`.
- `bookings.cancel_reason` (text), shown to the guest in the cancellation email.
- Staff actions logged (who checked in / cancelled what, when) in an `admin_events` table.

**Rules carried into the API.** Every `/api/admin/*` route requires a signed-in admin session
with two-factor completed. Cancelling never refunds automatically (refund in M-Pesa/Paystack
per policy). Closing dates never cancels existing bookings. Rate changes affect new bookings
only. Guest-typed text (names, requests, enquiry messages) is always escaped when displayed.
