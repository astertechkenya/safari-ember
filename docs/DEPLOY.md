# Deploying Safari Ember

Three services, set up in this order. Each step depends on the one before it.

| | What | Where |
|---|---|---|
| 1 | The production database (`ember_prod`) | Neon |
| 2 | The booking API (`api/`) | Render |
| 3 | The site (`frontend/`), passing `/api/*` on to Render | Netlify |

Never paste passwords, connection strings or keys into chats or commits. They live only in Neon,
Render, Netlify and your own `api/.env`.

---

## 1. Neon: the production database

**1a. The database and its two logins.** In the Neon console, Safari Ember project:

- **Databases:** create `ember_prod` (the API refuses any database not named `ember_…`).
- **Roles:** create `ember_app` and copy its password somewhere safe. This is the limited login the
  live API uses: it can read and write rows, never change tables.
- If you haven't yet: **reset the owner's password** (`neondb_owner`). It was exposed once.

**1b. Migrations, as the owner, from your computer.** Open a **new** PowerShell window (so no old
`DATABASE_URL` lingers), then:

```powershell
cd C:\dev\safari-ember\api
$env:DATABASE_URL = "<ember_prod connection string for neondb_owner, ending ?sslmode=require>"
npm run db:migrate
```

It should finish with every migration through `0006_refunds_cleanup`. Close the window afterwards.

**1c. Seed the rooms and experiences, once.** Still as the owner, in a new window:
`npm run db:seed`. **Only on a fresh `ember_prod`**: never again once real bookings exist.

**1d. What `ember_app` may do.** Neon console → SQL Editor → database `ember_prod` → run:

```sql
GRANT USAGE ON SCHEMA public TO ember_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ember_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ember_app;
-- the API checks at startup that every migration has run
GRANT USAGE ON SCHEMA drizzle TO ember_app;
GRANT SELECT ON drizzle.__drizzle_migrations TO ember_app;
-- tables added by future migrations get the same rights automatically
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ember_app;
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ember_app;
```

(This is SQL: it goes in Neon's SQL Editor, not PowerShell.)

---

## 2. Render: the API

New → Web Service → your GitHub repository (`safari-ember`).

| Setting | Value |
|---|---|
| Name | `safari-ember-api` (gives `https://safari-ember-api.onrender.com`; if taken, update `netlify.toml`) |
| Region | Frankfurt (closest to Neon's eu-central) |
| Root Directory | `api` |
| Build Command | `npm ci` |
| Start Command | `npm start` |
| Health Check Path | `/api/ping` |

**Environment variables.** Generate each secret fresh (never reuse your laptop's):
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

| Name | Value |
|---|---|
| `NODE_ENV` | `production` |
| `NODE_VERSION` | `22` |
| `DATABASE_URL` | `ember_prod` as **ember_app**, ending **`?sslmode=verify-full`** (the API refuses `require` and refuses the owner) |
| `SITE_URL` | your Netlify address, e.g. `https://safari-ember.netlify.app` (no trailing slash) |
| `SESSION_SECRET` | new random value |
| `NETLIFY_PROXY_SECRET` | new random value: the **same** one goes on Netlify |
| `PUBLIC_API_URL` | `https://safari-ember-api.onrender.com` |
| `DARAJA_ENV`, `DARAJA_CONSUMER_KEY`, `DARAJA_CONSUMER_SECRET`, `DARAJA_SHORTCODE`, `DARAJA_PASSKEY` | your sandbox values (as in `api/.env`) |
| `MPESA_CALLBACK_SECRET` | new random value |
| `PAYSTACK_SECRET_KEY` | your `sk_test_…` key |
| `RESEND_API_KEY`, `MAIL_FROM`, `MAIL_ONLY_TO`, `LODGE_EMAIL` | as in `api/.env` |

Deploy, then open `https://safari-ember-api.onrender.com/api/health`: `{"ok":true}` means the API
reached the database. If the deploy fails, Render's log names the variable or migration at fault.

**Paystack:** dashboard → Settings → API Keys & Webhooks → Test Webhook URL:
`https://safari-ember-api.onrender.com/api/payments/paystack/webhook`. (M-Pesa needs nothing in
Daraja's dashboard: the API sends Safaricom its callback address with each prompt.)

---

## 3. Netlify: the site

Add new site → Import from Git → `safari-ember`. `netlify.toml` (repository root) already says:
publish `frontend`, no build, and pass `/api/*` to Render, signed.

- **Site name:** the one you put in Render's `SITE_URL` (Site configuration → Change site name).
- **Environment variables:** `NETLIFY_PROXY_SECRET` = the same value as on Render, with the
  **Runtime** scope ticked (signed proxies only see Runtime variables). Then redeploy.

Check: `https://<your-site>.netlify.app/api/health` → `{"ok":true}` through the proxy.

---

## 4. The first admin account

New PowerShell window, `ember_prod` as **ember_app** (verify-full):

```powershell
cd C:\dev\safari-ember\api
$env:DATABASE_URL = "<ember_prod as ember_app, ?sslmode=verify-full>"
npm run create-admin -- --email you@example.com --name "Your Name"
```

Scan the authenticator key it prints, once. Close the window.

---

## Free-plan behaviour to know about

- **Render's free plan sleeps after 15 minutes without requests** and takes about a minute to
  wake. **Netlify stops waiting for a proxied request after 26 seconds**, so the first availability
  search after a quiet spell can fail with a 502. Trying again a minute later works. The fix is a
  free uptime monitor (e.g. UptimeRobot) calling `https://safari-ember-api.onrender.com/api/ping`
  every 10 minutes. `/api/ping` doesn't touch the database, so it doesn't keep Neon awake.
- Free Render hours are shared per account (750 a month). One always-awake service fits; NURA's API
  on the same account would also need them, so both would sometimes sleep.
- Holds still expire on time while the API sleeps: expiry is judged by the database's clock.
