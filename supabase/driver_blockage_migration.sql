-- FRIGARO driver blockage upgrade
-- Existing schema already contains disruptions; this migration adds useful
-- validation/indexes without changing the UI or existing tables.
create index if not exists disruptions_active_route_idx
  on disruptions(route_id, active, reported_at desc);

create index if not exists reroute_suggestions_load_status_idx
  on reroute_suggestions(load_id, status, created_at desc);

-- Optional audit metadata can be added later without changing the API/UI.
