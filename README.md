# Safari Ember

A luxury safari lodge site with a real booking engine: live availability, seasonal prices,
holds that can't double-book, deposits by M-Pesa or card (sandbox), and an admin area.
`docs/BLUEPRINT.md` is the plan and the rules; read it first.

```
frontend/   the site (what Netlify serves)
api/        the booking API (what Render runs): Node, Express, Drizzle, Postgres
docs/       blueprint, later the case study
server.py   local preview: the site + the API on one address, phones included
```

Status: **Phase 1 done** (API foundation and booking engine, 67 tests). The site doesn't call
the API yet; that's Phase 2.

## Run it on your laptop

Two terminals, both from `C:\dev\safari-ember`. Never run npm as Administrator.

### One-time setup

1. **Databases (Neon).** Create a new project called `safari-ember`. In it, create two
   databases: `ember_dev` (your data while building) and `ember_test` (the tests wipe and
   rebuild it on every run). Copy each one's connection string.
2. **Settings.** In `api`, copy `.env.example` to `.env` and fill in `DATABASE_URL`
   (ember_dev), `TEST_DATABASE_URL` (ember_test) and `SESSION_SECRET` (the file shows the
   command that makes one). `.env` is git-ignored: never paste its contents anywhere.
3. **Install, build the tables, add the rooms:**
   ```powershell
   cd api
   npm install
   npm run db:migrate
   npm run db:seed
   npm test
   ```
   All tests should pass.

### Every time

Terminal 1, the API:
```powershell
cd api
npm run dev
```

Terminal 2, the site (and the API through it, as Netlify will do):
```powershell
python server.py
```

Then open http://localhost:8000. To see the API working before Phase 2 wires up the site, open:

- http://localhost:8000/api/rooms
- http://localhost:8000/api/availability?checkIn=2027-08-01&checkOut=2027-08-04&guests=2

On your phone (same Wi-Fi), use the "Phone" address `server.py` prints.

## Changing the database

Edit `api/src/db/schema.js`, then `npm run db:generate` (writes a new file in `api/drizzle/`,
which you commit) and `npm run db:migrate`.
