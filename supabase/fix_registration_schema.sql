-- FRIGARO Cargo Registration Schema Fix
-- Run this ONCE in Supabase -> SQL Editor -> New Query -> Run
-- Safe for an existing project: every statement uses IF NOT EXISTS.

alter table public.loads add column if not exists owner_name text;
alter table public.loads add column if not exists phone text;
alter table public.loads add column if not exists origin text;
alter table public.loads add column if not exists destination text;
alter table public.loads add column if not exists expected_duration_hours numeric;
alter table public.loads add column if not exists quantity_boxes integer;
alter table public.loads add column if not exists weight_per_box_kg numeric;
alter table public.loads add column if not exists pricing_method text;
alter table public.loads add column if not exists unit_price numeric;
alter table public.loads add column if not exists total_cargo_value numeric;

-- Ask PostgREST/Supabase to refresh its schema metadata.
NOTIFY pgrst, 'reload schema';
