/* ============================================================
   FRIGARO — api.js
   Thin wrapper around the real backend REST API.
   ============================================================ */

async function jsonFetch(url, opts = {}) {
  const r = await fetch(url, opts);

  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;

    try {
      const body = await r.json();
      if (body.error) msg = body.error;
    } catch (e) {
      // Ignore JSON parsing errors and use status text.
    }

    throw new Error(msg);
  }

  return r.json();
}

const API = {

  /* ============================================================
     SYSTEM
     ============================================================ */

  health: () => jsonFetch('/api/health'),

  tick: () =>
    jsonFetch('/api/tick', {
      method: 'POST',
    }),


  /* ============================================================
     OVERVIEW
     ============================================================ */

  overview: () => jsonFetch('/api/overview'),

  products: () => jsonFetch('/api/products'),


  /* ============================================================
     COLD BOXES
     ============================================================ */

  coldBoxes: () => jsonFetch('/api/cold-boxes'),

  controlBox: (id, patch) =>
    jsonFetch(`/api/cold-boxes/${id}/control`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(patch),
    }),


  /* ============================================================
     SPOILAGE RISK
     ============================================================ */

  spoilageRisk: () => jsonFetch('/api/spoilage-risk'),


  /* ============================================================
     ALERTS
     ============================================================ */

  alerts: () => jsonFetch('/api/alerts'),

  resolveAlert: (id) =>
    jsonFetch(`/api/alerts/${id}/resolve`, {
      method: 'POST',
    }),

  clearAlerts: () =>
    jsonFetch('/api/alerts', {
      method: 'DELETE',
    }),


  /* ============================================================
     ROUTES
     ============================================================ */

  routes: () => jsonFetch('/api/routes'),

  overrideRoute: (id) =>
    jsonFetch(`/api/routes/${id}/override`, {
      method: 'POST',
    }),

  clearOverride: (id) =>
    jsonFetch(`/api/routes/${id}/clear-override`, {
      method: 'POST',
    }),


  /* ============================================================
     DISRUPTIONS
     ============================================================ */

  disruptions: () => jsonFetch('/api/disruptions'),

  createDisruption: (body) =>
    jsonFetch('/api/disruptions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),

  resolveDisruption: (id) =>
    jsonFetch(`/api/disruptions/${id}/resolve`, {
      method: 'POST',
    }),


  /* ============================================================
     REROUTE ASSISTANT
     ============================================================ */

  rerouteSuggestions: () =>
    jsonFetch('/api/reroute-suggestions'),

  approveReroute: (id) =>
    jsonFetch(`/api/reroute-suggestions/${id}/approve`, {
      method: 'POST',
    }),

  applyReroute: (id) =>
    jsonFetch(`/api/reroute-suggestions/${id}/apply`, {
      method: 'POST',
    }),


  /* ============================================================
     CARGO REGISTRATION
     ============================================================ */

  registerCargo: (body) =>
    jsonFetch('/api/cargo/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),


  /* ============================================================
     LOADS
     ============================================================ */

  loads: () => jsonFetch('/api/loads'),


  /* ============================================================
     DRIVER DELAY / BLOCKAGE ANALYSIS

     Backend endpoint:
     POST /api/loads/:id/report-delay

     Required backend body:
     {
       hours_stopped: Number,
       reason: String
     }
     ============================================================ */

  reportDelay: (body) => {

    const loadId = body.load_id || body.loadId || body.id;

    if (!loadId) {
      throw new Error('Load ID is required for delay analysis.');
    }

    const hoursStopped = Number(
      body.hours_stopped ??
      body.estimated_delay_hours ??
      body.delay_hours ??
      body.hours ??
      0
    );

    return jsonFetch(`/api/loads/${encodeURIComponent(loadId)}/report-delay`, {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json',
      },

      body: JSON.stringify({
        hours_stopped: hoursStopped,

        reason:
          body.reason ||
          body.type ||
          'Driver-reported delay',
      }),
    });
  },


  /* ============================================================
     WASTE & IMPACT
     ============================================================ */

  wasteImpact: () => jsonFetch('/api/waste-impact'),
};