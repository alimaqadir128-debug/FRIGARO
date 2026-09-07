
## IMPORTANT: Existing Supabase database migration
If cargo registration shows a missing column/schema cache error, run `supabase/fix_registration_schema.sql` once in Supabase SQL Editor. This adds the new registration fields to an older `loads` table without deleting existing data.


## Important when replacing the project ZIP
The `.env` file is intentionally **not included** in downloadable ZIP files because it can contain your Supabase service key. If you replace the entire FRIGARO folder, copy your existing `.env` into the new project folder before running `npm start`.

Your `.env` must contain:
```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key
PORT=3000
```

# FRIGARO — Cold Chain Command Center (Full-Stack, Multi-Product)

A real, working cold-chain logistics platform for Jammu, Kashmir & Ladakh —
not a mockup. Every number on screen is computed from a real Postgres
database via Supabase, with route status optionally driven by live weather.
Built by Alima Qadir, SSM College of Engineering.

## What's real here

- **Database:** Supabase Postgres. `supabase/schema.sql` and `supabase/seed.sql`
  were run against a real Postgres instance while building this — not just
  written and hoped to work.
- **Weather:** Open-Meteo current-conditions API — free, and needs no API
  key or signup. Route status (open/caution/blocked) is derived from real
  weather at each corridor's checkpoint, layered under any manually
  reported disruption.
- **Products, not just apples:** ten real product types — apples (two
  varieties), cherries, pears, walnuts, saffron, fresh trout, paneer/dairy,
  cold-chain vaccines, and tomatoes — each with its own ideal temperature/
  humidity band and spoilage sensitivity pulled from the `products` table.
  Vaccines escalate risk fast (safety-critical); walnuts barely react
  (naturally tolerant); tomatoes correctly flag *chilling injury* if kept
  too cold, not just too warm.
- **Cargo registration:** A user can register their own shipment with name, phone, origin, destination, transit duration, product, box count, weight per box and price. FRIGARO automatically calculates total weight and declared cargo value, shows a full review screen, and only writes to Supabase after explicit confirmation.
- **All panels are backed by the database** — Control Room Overview, Cold
  Box Health, Cooling & Airflow, Spoilage Risk, Alerts, Route Status,
  Disruption Events, Reroute Assistant, Loads in Transit, and Waste & Impact.
  I ran every endpoint against a live database before shipping this,
  including approving and applying a real reroute (which actually moves a
  load to a different route in the database) and inserting a fresh load on
  a blocked route to confirm the reroute-suggestion engine computes real
  hours-saved and tonnage figures.

## What's still simulated (and why)

There's no physical hardware — no real solar cold-box, no physical
temperature sensor — because that's outside the scope of a software
prototype. The backend simulates each cold box's sensor reading with a
server-side model that drifts toward its configured target (influenced by
real ambient weather at that box's coordinates) rather than a client-side
random number, so it behaves like a live telemetry feed even without
physical hardware.

## 1. Set up Supabase (5 minutes)

1. Create a free project at [supabase.com](https://supabase.com).
2. In your project, go to **SQL Editor → New query**, paste the contents of
   `supabase/schema.sql`, and run it.
3. New query again, paste `supabase/seed.sql`, run it. This gives you 10
   products, 6 cold boxes, 6 routes, 4 disruptions, and 6 loads to start with. The schema also includes safe `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` migration lines for the cargo-registration metadata, so run the updated schema even if you already created the earlier tables.
4. Go to **Project Settings → API** and copy:
   - **Project URL** → `SUPABASE_URL`
   - **service_role key** (not the anon key — the backend needs full access) → `SUPABASE_SERVICE_KEY`
5. (Optional but recommended) In **Table Editor**, confirm Row Level
   Security is OFF for each table — this backend authenticates with the
   service role key directly, so RLS isn't needed for this prototype.

## 2. Configure and run

No weather API key needed — Open-Meteo is free and keyless.

```
cp .env.example .env
# edit .env and paste in your SUPABASE_URL and SUPABASE_SERVICE_KEY

npm install
npm start
```

Open **http://localhost:3000**.

## API reference

| Method | Path | Does |
|---|---|---|
| GET | `/api/health` | Checks Supabase connectivity |
| GET | `/api/overview` | Control-room KPIs |
| GET | `/api/products` | The 10-product catalog |
| GET | `/api/cold-boxes` | All boxes + live risk |
| POST | `/api/cold-boxes/:id/control` | Set target temp/humidity/fan/cooling |
| GET | `/api/spoilage-risk` | Risk per box and per in-transit load |
| GET / POST(resolve) / DELETE | `/api/alerts` | Alert feed |
| GET | `/api/routes` | Corridor status + weather summary |
| POST | `/api/routes/:id/override` \| `/clear-override` | Manual block/open toggle |
| GET / POST / POST(resolve) | `/api/disruptions` | Report or clear a disruption |
| GET / POST(approve) / POST(apply) | `/api/reroute-suggestions` | Reroute engine |
| POST | `/api/cargo/register` | Validate, calculate and save a user-registered cargo shipment |
| GET | `/api/loads` | Every truck, product, box, route, risk |
| GET | `/api/waste-impact` | 7-day saved/waste/CO₂ stats + daily series |
| POST | `/api/tick` | Force an immediate recompute (handy for a live demo) |

## Notes for the pitch

- The "Force Update" button in the top bar triggers an immediate recompute
  instead of waiting for the 20-second auto-poll — use it live on stage.
- The reroute assistant correctly reports **"no viable alternate"** for the
  Srinagar–Leh highway (Zoji La) when it's blocked, because there genuinely
  isn't a winter alternate — that's a real constraint of the region, not a
  bug.
- CO₂-avoided is computed from a documented assumption (0.4 kg CO₂e per kg
  of produce saved from avoided spoilage/re-transport) — swap in your own
  figure in `server.js` (`/api/waste-impact`) if you have a better source.

## Latest FRIGARO update
- Cargo registration no longer asks for a predicted blocked duration. Unexpected delays belong in **Disruption Events**, where they can be reported when they actually occur.
- Route Status uses a labelled road-first map focused and bounded to **Jammu, Kashmir and Ladakh**.
- Cargo product/pricing dropdown options have explicit readable contrast on Windows/Chrome.
- The cargo registration API no longer sends or requires `blocked_duration_hours`, fixing the Supabase schema-cache error caused by that field.

## Driver blockage deterministic upgrade

This repair keeps the frontend/UI unchanged and adds backend endpoint:

`POST /api/driver/report-blockage`

Example body:

```json
{
  "load_id": "FRG-2026-ABCDE",
  "type": "landslide",
  "location": "Zojila Pass",
  "severity": "high",
  "estimated_delay_hours": 6
}
```

A high-severity driver blockage immediately blocks the route, runs rerouting, and projects temperature/humidity toward live ambient conditions using an exponential Newton-style model. During an active reported blockage, cold-box temperature/humidity updates do not use random noise.

Run `supabase/driver_blockage_migration.sql` in Supabase SQL Editor (safe for existing data), then restart the Node server.
