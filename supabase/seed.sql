-- ============================================================
-- FRIGARO — seed data
-- Run this in the Supabase SQL Editor AFTER schema.sql.
-- Safe to re-run (uses ON CONFLICT DO NOTHING).
-- ============================================================

-- ---------- Products: a real mix, not just apples ----------
insert into products (id, name, category, ideal_temp_min, ideal_temp_max, ideal_humidity_min, ideal_humidity_max, shelf_life_days, spoilage_sensitivity, chill_sensitive, critical) values
  ('apple_delicious', 'Apple (Delicious)', 'Fruit', 2, 8, 85, 95, 30, 1.0, false, false),
  ('apple_ambri',      'Apple (Ambri)',     'Fruit', 1, 4, 90, 95, 25, 1.1, false, false),
  ('cherry',           'Cherry',            'Fruit', 0, 2, 90, 95, 10, 1.8, false, false),
  ('pear',             'Pear',              'Fruit', 0, 1, 90, 95, 20, 1.3, false, false),
  ('walnut',           'Walnut (dried)',    'Dry Good', 15, 20, 30, 45, 180, 0.2, false, false),
  ('saffron',          'Saffron',           'Dry Good', 10, 18, 30, 40, 730, 0.1, false, false),
  ('trout',            'Fresh Trout',       'Seafood', 0, 4, 85, 95, 3, 3.0, false, false),
  ('paneer',           'Paneer / Dairy',    'Dairy', 2, 4, 80, 90, 5, 2.5, false, false),
  ('vaccine',          'Vaccines (Cold Chain)', 'Medical', 2, 8, 40, 60, 90, 2.5, false, true),
  ('tomato',           'Tomato',            'Vegetable', 10, 13, 85, 90, 14, 1.2, true, false)
on conflict (id) do nothing;

-- ---------- Routes: real J&K + Ladakh corridors, each with a weather checkpoint ----------
insert into routes (id, name, status, weather_lat, weather_lng, weather_label, coords, distance_km, avg_speed_kmph) values
  ('nh44', 'NH-44 · Jammu–Srinagar', 'open', 33.2333, 75.2333, 'Ramban',
    '[[32.7266,74.8570],[32.9159,75.1416],[33.2333,75.2333],[33.5333,75.1988],[34.0837,74.7973]]', 270, 40),
  ('mughal', 'Mughal Road · Shopian–Poonch', 'open', 33.8300, 74.6500, 'Peer Ki Gali',
    '[[33.7178,74.8319],[33.83,74.65],[33.8608,74.5806],[33.7717,74.0913]]', 84, 25),
  ('sopore', 'Srinagar–Sopore Corridor', 'open', 34.2098, 74.3436, 'Baramulla',
    '[[34.0837,74.7973],[34.2098,74.3436],[34.2996,74.4726]]', 50, 45),
  ('leh', 'NH-1 · Srinagar–Leh (Zoji La)', 'open', 34.2757, 75.4694, 'Zoji La Pass',
    '[[34.0837,74.7973],[34.3033,75.2926],[34.2757,75.4694],[34.4356,75.7574],[34.5539,76.1349],[34.1526,77.5771]]', 434, 35),
  ('gurez', 'Bandipora–Gurez Valley Road', 'open', 34.5500, 74.7500, 'Razdan Pass',
    '[[34.4185,74.6398],[34.55,74.75],[34.6280,74.8180]]', 86, 20),
  ('pampore', 'Pampore–Srinagar Mandi Route', 'open', 34.0837, 74.7973, 'Srinagar (Parimpora Mandi)',
    '[[33.9962,74.9092],[34.0837,74.7973]]', 15, 40)
on conflict (id) do nothing;

-- ---------- Realistic alternates (only where a real alternate road exists) ----------
insert into route_alternatives (route_id, alt_route_id) values
  ('nh44', 'mughal'),
  ('mughal', 'nh44')
on conflict do nothing;
-- Note: 'leh' (Zoji La) has no real winter alternate — this is intentional.
-- The Reroute Assistant will correctly report "no viable alternate" for it.

-- ---------- Cold boxes: one per product family, spread across routes ----------
insert into cold_boxes (id, name, location, lat, lng, product_id, route_id, target_temp, target_humidity, fan_speed, current_temp, current_humidity, current_airflow, battery, solar_input, cooling_on) values
  ('CB-01', 'Sopore Orchard Box',     'Sopore',   34.2996, 74.4726, 'apple_delicious', 'sopore', 4,  90, 70, 3.4, 89, 82, 94, 71, true),
  ('CB-02', 'Shopian Packhouse Box',  'Shopian',  33.7178, 74.8319, 'cherry',          'mughal', 1,  92, 75, 6.9, 78, 65, 41, 38, true),
  ('CB-03', 'Pampore Transit Box',    'Pampore',  33.9962, 74.9092, 'tomato',          'pampore', 11, 87, 60, 11.5, 84, 88, 92, 66, true),
  ('CB-04', 'Leh Highway Cold Point', 'Sonamarg', 34.3033, 75.2926, 'vaccine',         'leh', 5,  50, 65, 4.8, 47, 90, 96, 55, true),
  ('CB-05', 'Gurez Dairy Box',        'Bandipora',34.4185, 74.6398, 'paneer',          'gurez', 3,  85, 70, 3.1, 83, 79, 27, 20, true),
  ('CB-06', 'Jammu Gateway Box',      'Jammu',    32.7266, 74.8570, 'walnut',          'nh44', 17, 38, 40, 17.8, 39, 85, 88, 60, false)
on conflict (id) do nothing;

-- ---------- Active disruptions (matches real corridor pain points) ----------
insert into disruptions (route_id, type, severity, location, active) values
  ('nh44', 'landslide', 'high', 'NH-44, Ramban', true),
  ('mughal', 'snowfall', 'medium', 'Mughal Road, Peer Ki Gali', true),
  ('gurez', 'convoy_hold', 'medium', 'Gurez Link Road', true),
  ('pampore', 'market_strike', 'low', 'Parimpora Mandi', true)
on conflict do nothing;

-- ---------- Loads in transit: six trucks, six different products ----------
insert into loads (id, product_id, weight_kg, cold_box_id, route_id, status, departed_at, eta) values
  ('TRK-118', 'apple_delicious', 8200, 'CB-01', 'sopore', 'in_transit', now() - interval '3 hours', now() + interval '2 hours'),
  ('TRK-204', 'cherry',          3500, 'CB-02', 'mughal', 'in_transit', now() - interval '5 hours', now() + interval '4 hours'),
  ('TRK-311', 'vaccine',          600, 'CB-04', 'leh',    'in_transit', now() - interval '8 hours', now() + interval '10 hours'),
  ('TRK-402', 'paneer',          2100, 'CB-05', 'gurez',  'in_transit', now() - interval '2 hours', now() + interval '3 hours'),
  ('TRK-501', 'walnut',          6000, 'CB-06', 'nh44',   'in_transit', now() - interval '4 hours', now() + interval '5 hours'),
  ('TRK-602', 'tomato',          4400, 'CB-03', 'pampore','in_transit', now() - interval '1 hours', now() + interval '1 hours')
on conflict (id) do nothing;
