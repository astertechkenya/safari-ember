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

**Prices.** Each night costs the room type's base rate: one price all year, set in the admin.
(Seasonal rates existed until Oct 2026 and were removed, migration 0004: a base-rate change that
a season silently overrode looked like a bug, and one price is easier for staff and guests.)
The total is the sum of the nights; each night's price is still stored on its own.
All money is whole Kenyan shillings, stored as integers. No floating point anywhere.

**Deposit.** 30% of the total, rounded up to the next shilling, paid online to confirm. The
balance is paid at the lodge. (Setting: `DEPOSIT_PERCENT`.)

**Holds.** Starting a booking *holds* its rooms for 15 minutes while the guest pays. Paid in
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

**Closures.** Handled physically by the lodge, not in the admin (decided Oct 2026): there is no
Closures screen. The `closures` table and its rule stay in the booking engine (a row blocks units
for its dates and they count as taken), but nothing in the admin creates or shows them.

**Booking reference.** Guests see a short reference like `SE-7K3QXM` (no 0/O or 1/I to misread
on the phone), never the database id. Their confirmation link is signed, like NURA's order
links, so nobody can open someone else's booking by guessing.

## Data model

```
room_types       id, slug, name, kind, description, sleeps, units, base_rate_kes, sort, active
closures         id, room_type_id (null = every type), starts_on, ends_on (exclusive), units, reason
bookings         id, ref, check_in, check_out, guests, nights, total_kes, deposit_kes,
                 status, hold_expires_at, first_name, last_name, email, phone, requests,
                 created_at, confirmed_at, cancelled_at, refund_due
booking_rooms    booking_id, room_type_id, units    (which rooms, how many of each)
booking_nights   booking_id, room_type_id, night, rate_kes   (price of one unit that night, frozen)
activities       id, slug, name, summary, duration_minutes, price_kes (per person), seats (one vehicle, for staff: not a limit),
                 departure_times (HH:MM[]), weekdays (1 = Mon … 7 = Sun), sort, active
booking_activities id, booking_id, activity_id, day, departs, people, price_kes (frozen)
payments         id, booking_id, provider (DARAJA | PAYSTACK), status, amount_kes, received_kes,
                 phone, provider_ref, receipt, result_code, failure_reason, raw, checked_at, created_at
enquiries        id, first_name, last_name, email, phone, subject, message, check_in, check_out,
                 guests, status, created_at
admins           id, email (unique, any case), name, role (ADMIN | DEMO_ADMIN), password_hash
                 (argon2id), totp_secret, created_at, updated_at
sessions         sid, sess, expire (connect-pg-simple, as NURA)
admin_events     id, admin_id, action, booking_id, detail, created_at (every staff change)
booking_emails   booking_id, kind, status, created_at (one row per email kind per booking)
```

Booking statuses: `HELD` → `CONFIRMED` (deposit paid) → `COMPLETED` (stayed), or `HELD` →
`EXPIRED`, or `CONFIRMED` → `CANCELLED`. Checking in sets `checked_in_at` (shown as "In house"); checking
out sets `COMPLETED` and `checked_out_at`. A booking takes a unit while it is `HELD` (and not
past its hold) or `CONFIRMED`.

`booking_nights` freezes each night's price when the guest books, so changing a rate later
never changes what an existing guest owes.

## API

| Method & path | What it does |
|---|---|
| `GET /api/rooms` | Room types with their "from" price |
| `GET /api/availability?checkIn=…&checkOut=…&guests=…` | Each room type: available or not, units left (when few), nightly prices, total, deposit |
| `GET /api/activities?checkIn=…&checkOut=…` | Trips that can be added to that stay, with their departures (no seat counts) |
| `POST /api/bookings` | Hold rooms (`rooms: [{ room, units }]`) plus optional trips (`activities: [{ activity, day, time, people }]`), dates, guests, guest details → reference, amount due, hold expiry, signed link |
| `GET /api/bookings/:ref` (signed link) | The booking's status, for the confirmation page |
| `POST /api/bookings/:ref/pay` (signed link) | Start the deposit payment: `{ method: 'mpesa', phone? }` sends a prompt; `{ method: 'card' }` returns Paystack's page address |
| `POST /api/payments/mpesa/callback/:secret` | Safaricom's result (a hint: we then ask Safaricom ourselves) |
| `POST /api/payments/paystack/webhook` | Paystack's signed events (a hint: we then ask Paystack ourselves) |
| `POST /api/enquiries` | The "Get in touch" form (`name` or `firstName` + `lastName`, `email`, `message`, optional extras), saved for the admin inbox and (Phase 4) emailed to the lodge |
| `/api/admin/*` (Phase 5) | The admin: see "Launch scope" for the nineteen routes |

## Deposits (Phase 3)

**Nothing is paid on anyone's word.** Safaricom's callback, Paystack's webhook and the booking
page asking "is it paid yet?" all lead to the same step: the API asks the provider itself
(M-Pesa STK query, Paystack verify) with our own credentials, and records what it says. A
forged callback can't confirm a booking.

**One attempt at a time.** A booking has at most one `PENDING` payment (a unique index, so two
quick taps can't make two). Six attempts per booking, five M-Pesa prompts per number per hour.
Switching from an unfinished card page to M-Pesa first checks the card wasn't paid after all.

**Settles once.** Every status change is a conditional update (`… where status = 'PENDING'`)
under a row lock, taken in a fixed order (payment → booking → room types by id, see
`services/capacity.js`), so racing answers can't settle a payment twice or deadlock.

**Only a final "no" fails a payment** (fixed Oct 2026, after a real sandbox payment showed as
failed). M-Pesa fails only on Safaricom's final codes (`FINAL_FAILURES` in `services/daraja.js`:
no balance, cancelled, wrong PIN, timed out, unreachable, expired, couldn't send). Any other
non-zero answer, such as 4999 "still under processing", means keep waiting. With no final answer
after 3 minutes the minute job marks it `NO_ANSWER` and tells the guest not to pay again but to
contact the lodge. **Proof of payment overrides a failure:** if Safaricom or Paystack later
confirms a `FAILED` payment was paid, it becomes `PAID` and the table below applies.

**What a paid deposit does:**

| Booking when the money arrives | Result |
|---|---|
| `HELD`, hold still running | `CONFIRMED` |
| Hold ran out, rooms still free | `CONFIRMED` (re-checked under the same locks as a new booking) |
| Hold ran out, a room taken meanwhile | `EXPIRED` with `refund_due`; the guest's page says a refund is coming |
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
on set weekdays (Nairobi time). Rules:

- Any day from check-in to check-out *inclusive* (a morning drive before an 11:00 check-out).
- Bookable until `ACTIVITY_CUTOFF_MINUTES` (default 120) before it leaves.
- People per trip: 1 up to the party size. Priced per person, frozen at booking time.
- **No seat limit, and no seat counts shown** (decided Oct 2026). Guests pick a time and how many
  people; if a departure outgrows one vehicle (`seats`, kept for staff), the lodge adds a vehicle
  or offers another time and staff tell the guest. The booking page says the lodge will confirm
  the arrangements before arrival.
- Gate and entry fees are paid at the gate, not to the lodge; the summaries say so.

**Deadlocks.** A booking now locks several rows, so every path takes them in one order:
payment → booking → room types (by id). Activities take no lock, having no limit to protect.
Tests fire two bookings that want the same two room types in opposite orders.

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
   Netlify Forms. (Done for real in Oct 2026: until then the homepage form showed "Thank you"
   but sent nothing. It now says thank you only once the API has saved the message.)
3. **Deposits.** M-Pesa and card, adapted from NURA: paying confirms the booking; a payment
   that arrives after the hold expired is handled safely (re-hold if still free, otherwise
   flagged for a refund). **3b:** several rooms per booking, and experiences as add-ons.
4. **Emails (built Oct 2026, from NURA's mail.js / emails.js).** Guests: booking confirmed,
   booking cancelled (with the lodge's reason), hold ended. The lodge (`LODGE_EMAIL`): a new
   confirmed booking, a new enquiry. Each at most once (`booking_emails`, migration 0005), sent
   after the change commits, never blocking or failing it; Reply on a guest's email goes to the
   lodge. Lodge alerts carry no guest contact details. Until a domain is verified in Resend,
   only the account owner's address receives mail (`MAIL_ONLY_TO`), so guests' emails are
   logged as "held" and the private booking link stays their confirmation. Each booking's
   history in the admin shows what was emailed and whether it went out.
5. **Admin.** Sign-in with two-factor (as NURA), Today
   (check in / out), the bookings list and a booking (cancel), the calendar, rooms and rates
   (one price per night), Experiences, and the enquiries inbox. No Closures (handled physically).
6. **Ship it.** Neon production database with a least-privilege app login, Render, Netlify
   proxy, uptime monitor, Sentry, and the case study.

## Launch scope (decided Oct 2026)

To ship sooner, the admin launches without the screens it can manage without (decided Oct 2026,
then widened the same week to include Calendar and Rooms & rates).
Closures was later dropped from the admin altogether (handled physically), so the `LAUNCH` /
`LATER` switch that hid it is gone too.

**At launch (built Oct 2026).** Nineteen admin routes. Login and logout are open; every other one
requires a signed-in admin with two-factor done (`me` and `login/code` also answer mid-sign-in):

| Route | For |
|---|---|
| `POST /api/admin/login`, `POST /api/admin/login/code`, `POST /api/admin/logout`, `GET /api/admin/me` | Sign-in with password then authenticator code (as NURA) |
| `GET /api/admin/today` | Arrivals, departures, in house, tonight's occupancy, holds, new-enquiry count |
| `GET /api/admin/bookings?q=&status=&room=` | Search and filter |
| `GET /api/admin/bookings/:ref` | One booking: rooms, experiences, frozen prices, payments, history |
| `POST /api/admin/bookings/:ref/check-in`, `/check-out`, `/cancel` | The daily actions (cancel takes a reason) |
| `GET /api/admin/bookings/:ref/link` | The guest's private booking link, to copy and send by hand (not for the demo account) |
| `GET /api/admin/calendar?from=` | Three weeks: rooms free per type per night, closed units |
| `GET /api/admin/calendar/night?date=&room=` | Who is staying in a room type that night |
| `GET /api/admin/rooms`, `PATCH /api/admin/rooms/:id` | Room types: base rate, units, bookable |
| `GET /api/admin/experiences?from=`, `PATCH /api/admin/experiences/:id` | Two weeks of departures (who's going, people, vehicles) and each trip's price, seats, times, on/off (every trip runs daily) |
| `GET /api/admin/enquiries`, `POST /api/admin/enquiries/:id/status` | Inbox; mark handled / new |

**Rules for Experiences.** A price change applies to new bookings only (each booking froze its
price per person). Seats are one vehicle's seats, for staff planning: never a limit for guests.
Every trip runs daily (decided Oct 2026), so days aren't editable. Removing a time, or switching a trip off, never touches existing bookings: they keep
their slot and still show in the departures list, and the admin is told how many are affected
so staff can contact those guests. Logged in `admin_events` as `activity.update`.

**Rules for Rooms & rates.** A price change applies to new bookings at once, for every date
(booked nights keep their frozen price). Units can't be lowered below the rooms already booked
on any future night (the API refuses with the night and the count). Every change is logged in
`admin_events`.

**After launch, and the stand-in meanwhile.**

| Later | Meanwhile |
|---|---|
| Guest emails delivered | Built; held until a domain is verified in Resend. Meanwhile the private booking link is the confirmation |

**Still non-negotiable at launch.** Server-side sign-in checks on every `/api/admin/*` route
(the hidden admin page is not protection), the least-privilege production database login,
migrations 0002 to 0005 run on production before the code that needs them, and tests for check-in,
check-out, cancel and the units rule.

## Admin (Phase 5, built Oct 2026)

`frontend/admin/index.html`, one page, talking only to `/api/admin/*` with the session cookie.
It hides buttons the signed-in account can't use, but every rule is enforced by the API.

**Decisions.** The site's warm black and ember with square corners. Data sits on sand (dark ink,
like paper): Today's arrivals and departures, the bookings list, a booking's details, the
calendar, the inbox. Alerts (holds, enquiries, a guest's request) are dark with an ember edge,
and counts are round. Panel titles use the site's headline tag. Plain sans-serif for data, no
decorative motion, all text at least 4.5:1 contrast. Desktop first for the reception
computer, but every screen works on a phone (drawer menu, bookings as cards, scrolling calendar).
Not linked from the site and marked `noindex`.

| Screen | At launch? | What it does |
|---|---|---|
| Sign-in | yes | Email + password, then a 6-digit authenticator code; a lost phone is reset by the manager (`create-admin --reset-2fa`) |
| Today | yes | Arrivals (check in), departures (check out), in house, tonight's occupancy, holds with live countdown, new enquiries |
| Bookings | yes | Search by name, reference, email or phone; filter by status and room type |
| Booking | yes | Rooms, experiences, guest, frozen nightly prices, deposit and balance due, history, check in / out, cancel (with reason), copy guest link. ("Resend confirmation email" waits for guest emails.) |
| Enquiries | yes | Inbox with unread marks, reply by email, mark as handled |
| Calendar | yes | Rooms free per night, three weeks a page, any date back or forward (bookings are never deleted; guests book up to 18 months ahead). Past nights count completed stays up to the day the guest left. A night lists who stayed or is staying, with each guest's room count on the right |
| Experiences | yes | Departures for two weeks by day: trip, time, who's going (held ones marked), people and vehicles needed (people ÷ a vehicle's seats). Each trip (all run daily): price per person, seats per vehicle, departure times, offered or not |
| Rooms & rates | yes | Price per night, units and "bookable" per room type |

**As built (migration 0003).** `bookings` gained `checked_in_at`, `checked_out_at` and
`cancel_reason` (up to 300 characters, shown on the guest's booking page); new tables `admins`,
`sessions` and `admin_events`. Sign-in ported from NURA: argon2id passwords, a new session ID on
every sign-in, cookie `se.sid` (httpOnly, SameSite=Lax, Secure in production, 12 h), signed out
after 8 h idle, and the admin re-read on every request so a removed account stops at once.
Two-factor (TOTP) is required for `ADMIN` accounts. Login is limited to 5 tries per 15 minutes
per connection and email (20 wrong per connection); codes to 5 wrong per account.

**Demo account.** `DEMO_ADMIN` (for the case study / portfolio visitors): can open every screen,
can change nothing (the API refuses anything but reading), and guests' details are masked by the
API before they leave the server ("Amina O.", "a•••@example.com", "+254 7•• ••• 100"). It
can't fetch guest links. No two-factor, so give it a password you're happy to publish.

**Accounts.** `npm run create-admin -- --email … --name …` (asks for the password twice, at least
12 characters, and prints the authenticator key once). `--role DEMO_ADMIN` for the demo account,
`--reset-2fa` for a lost phone. Running it again for an existing email can set a new password
(Enter keeps the current one) and signs that admin out everywhere.

**Production database.** The least-privilege app login needs `SELECT, INSERT, UPDATE, DELETE` on
`admins`, `sessions` and `admin_events` (and `USAGE` on the `admin_events` id sequence), the same
as the other tables; migrations stay with the owner login.

**Rules carried into the API.** Every `/api/admin/*` route requires a signed-in admin session
with two-factor completed. Cancelling never refunds automatically (refund in M-Pesa/Paystack
per policy). Closing dates never cancels existing bookings. Rate changes affect new bookings
only. Guest-typed text (names, requests, enquiry messages) is always escaped when displayed.
