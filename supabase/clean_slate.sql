-- FRIGARO — Clean Slate for Demo / Deploy
-- Run this once in Supabase → SQL Editor.
-- Wipes all in-transit/delivered cargo, alerts, and reroute suggestions —
-- keeps your products, cold boxes, routes and disruptions exactly as they are,
-- so the app still fully works, it just starts with zero shipments/alerts.

-- Order matters: children before parents (foreign keys point to loads).
delete from reroute_suggestions;
delete from alerts;
delete from loads;

-- Optional: also clear any active disruption reports (landslide/convoy/etc.)
-- so Route Status starts purely on live weather with no manual disruptions.
-- Uncomment the next line if you want that too:
-- delete from disruptions;

-- Cold boxes are NOT deleted — they keep existing, so "Register Cargo" still
-- has real cold boxes to assign to new shipments. Their live temp/humidity
-- readings will keep drifting normally from the background tick.
