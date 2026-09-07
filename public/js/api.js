/* ============================================================
   FRIGARO — api.js
   Thin wrapper around the real backend REST API.
   ============================================================ */

async function jsonFetch(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { const body = await r.json(); if (body.error) msg = body.error; } catch (e) {}
    throw new Error(msg);
  }
  return r.json();
}

const API = {
  health: () => jsonFetch('/api/health'),
  tick: () => jsonFetch('/api/tick', { method: 'POST' }),

  overview: () => jsonFetch('/api/overview'),
  products: () => jsonFetch('/api/products'),

  coldBoxes: () => jsonFetch('/api/cold-boxes'),
  controlBox: (id, patch) => jsonFetch(`/api/cold-boxes/${id}/control`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  }),

  spoilageRisk: () => jsonFetch('/api/spoilage-risk'),

  alerts: () => jsonFetch('/api/alerts'),
  resolveAlert: (id) => jsonFetch(`/api/alerts/${id}/resolve`, { method: 'POST' }),
  clearAlerts: () => jsonFetch('/api/alerts', { method: 'DELETE' }),

  routes: () => jsonFetch('/api/routes'),
  overrideRoute: (id) => jsonFetch(`/api/routes/${id}/override`, { method: 'POST' }),
  clearOverride: (id) => jsonFetch(`/api/routes/${id}/clear-override`, { method: 'POST' }),

  disruptions: () => jsonFetch('/api/disruptions'),
  createDisruption: (body) => jsonFetch('/api/disruptions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }),
  resolveDisruption: (id) => jsonFetch(`/api/disruptions/${id}/resolve`, { method: 'POST' }),

  rerouteSuggestions: () => jsonFetch('/api/reroute-suggestions'),
  approveReroute: (id) => jsonFetch(`/api/reroute-suggestions/${id}/approve`, { method: 'POST' }),
  applyReroute: (id) => jsonFetch(`/api/reroute-suggestions/${id}/apply`, { method: 'POST' }),

  registerCargo: (body) => jsonFetch('/api/cargo/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),

  loads: () => jsonFetch('/api/loads'),
  wasteImpact: () => jsonFetch('/api/waste-impact'),
};
