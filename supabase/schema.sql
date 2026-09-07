-- ============================================================
-- FRIGARO — Supabase schema
-- Run this once in your Supabase project's SQL Editor
-- (Project -> SQL Editor -> New query -> paste -> Run)
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- Products (different perishable types, not just apples) ----------
create table if not exists products (
  id text primary key,
  name text not null,
  category text not null,
  ideal_temp_min numeric not null,
  ideal_temp_max numeric not null,
  ideal_humidity_min numeric not null,
  ideal_humidity_max numeric not null,
  shelf_life_days integer not null,
  spoilage_sensitivity numeric not null default 1.0,   -- higher = spoils faster outside range
  chill_sensitive boolean not null default false,       -- true if storing too COLD also damages it (e.g. tomato)
  critical boolean not null default false                -- true if breach is a safety issue, not just quality (e.g. vaccines)
);

-- ---------- Routes (real J&K + Ladakh corridors) ----------
create table if not exists routes (
  id text primary key,
  name text not null,
  status text not null default 'open',          -- open | caution | blocked
  manual_override boolean not null default false,
  weather_lat numeric not null,
  weather_lng numeric not null,
  weather_label text not null,                  -- human label for the weather checkpoint used
  coords jsonb not null,                        -- [[lat,lng], ...] real waypoints
  distance_km numeric not null,
  avg_speed_kmph numeric not null,
  weather_checked_at timestamptz,
  weather_summary text
);

-- ---------- Which routes can substitute for which ----------
create table if not exists route_alternatives (
  route_id text not null references routes(id) on delete cascade,
  alt_route_id text not null references routes(id) on delete cascade,
  primary key (route_id, alt_route_id)
);

-- ---------- Cold boxes (physical/simulated units, each holding one product) ----------
create table if not exists cold_boxes (
  id text primary key,
  name text not null,
  location text not null,
  lat numeric not null,
  lng numeric not null,
  product_id text not null references products(id),
  route_id text references routes(id),
  target_temp numeric not null,
  target_humidity numeric not null,
  fan_speed numeric not null default 70,
  current_temp numeric not null,
  current_humidity numeric not null,
  current_airflow numeric not null default 80,
  battery numeric not null default 95,
  solar_input numeric not null default 60,
  cooling_on boolean not null default true,
  updated_at timestamptz not null default now()
);

-- ---------- Disruption events on routes ----------
create table if not exists disruptions (
  id uuid primary key default gen_random_uuid(),
  route_id text not null references routes(id),
  type text not null,             -- landslide | snowfall | convoy_hold | market_strike | weather
  severity text not null,         -- low | medium | high
  location text not null,
  reported_at timestamptz not null default now(),
  active boolean not null default true
);

-- ---------- Loads / trucks in transit ----------
create table if not exists loads (
  id text primary key,                          -- e.g. TRK-118
  product_id text not null references products(id),
  weight_kg numeric not null,
  cold_box_id text references cold_boxes(id),
  route_id text references routes(id),
  status text not null default 'in_transit',    -- in_transit | delivered | rerouted | spoiled
  departed_at timestamptz not null default now(),
  eta timestamptz not null,
  produce_saved_kg numeric not null default 0,
  waste_kg numeric not null default 0
);

-- ---------- Alerts ----------
create table if not exists alerts (
  id uuid primary key default gen_random_uuid(),
  cold_box_id text references cold_boxes(id),
  load_id text references loads(id),
  severity text not null,          -- info | warning | severe
  title text not null,
  dedupe_key text not null,        -- prevents duplicate alerts for the same ongoing condition
  created_at timestamptz not null default now(),
  resolved boolean not null default false
);
create unique index if not exists alerts_active_dedupe
  on alerts (dedupe_key) where resolved = false;

-- ---------- Reroute suggestions ----------
create table if not exists reroute_suggestions (
  id uuid primary key default gen_random_uuid(),
  load_id text not null references loads(id),
  from_route_id text not null references routes(id),
  to_route_id text references routes(id),        -- null = "no viable alternate"
  reason text not null,
  hours_saved numeric,
  tonnage_protected numeric,
  status text not null default 'pending',        -- pending | approved | applied | rejected
  created_at timestamptz not null default now()
);

-- ============================================================
-- Notes:
-- - This prototype's backend connects with the Supabase SERVICE ROLE key,
--   so Row Level Security can stay OFF for these tables (Table Editor ->
--   select table -> RLS toggle). Do not expose the service key client-side.
-- ============================================================

-- ---------- Cargo registration metadata (safe for existing projects) ----------
alter table loads add column if not exists owner_name text;
alter table loads add column if not exists phone text;
alter table loads add column if not exists origin text;
alter table loads add column if not exists destination text;
alter table loads add column if not exists expected_duration_hours numeric;
alter table loads add column if not exists quantity_boxes integer;
alter table loads add column if not exists weight_per_box_kg numeric;
alter table loads add column if not exists pricing_method text;
alter table loads add column if not exists unit_price numeric;
alter table loads add column if not exists total_cargo_value numeric;
