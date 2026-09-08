/* ============================================================
   FRIGARO — app.js (10-panel, real-backend edition)
   Every panel fetches its own data from the Supabase-backed API
   on activation and on a 20s poll (matching the backend's own
   tick interval). No numbers here are hardcoded.
   ============================================================ */

let activePanel = 'overview';
let map, wasteChart, routeLayers = {}, mapBounds;
let routesCache = [];

/* ---------------- HELPERS ---------------- */
function setText(id, val){ const el = document.getElementById(id); if (el) el.textContent = val; }
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function riskHex(level){ return level === 'HIGH' ? '#e4483c' : level === 'MEDIUM' ? '#e8a23d' : '#31c48d'; }
function statusChipHtml(status){ return `<span class="status-chip ${status}">${status.toUpperCase()}</span>`; }
function timeAgo(iso){
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
function fmtTime(iso){
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
}
function emptyState(msg){ return `<div class="empty-state">${esc(msg)}</div>`; }

/* ---------------- HEALTH ---------------- */
async function checkHealth(){
  try {
    const h = await API.health();
    const banner = document.getElementById('healthBanner');
    if (!h.supabase){
      banner.style.display = 'flex';
      banner.className = 'health-banner warn';
      banner.innerHTML = `<span class="health-dot"></span> Supabase isn't connected yet — check that your .env file still contains SUPABASE_URL and SUPABASE_SERVICE_KEY, then restart npm start. If this is a fresh database, run schema.sql and seed.sql.`;
    } else {
      banner.style.display = 'none';
    }
  } catch (e){
    console.error('Health check failed', e);
  }
}

/* ---------------- 1. OVERVIEW ---------------- */
async function loadOverview(){
  try {
    const ov = await API.overview();
    setText('ovColdBoxes', ov.coldBoxesLive);
    setText('ovColdBoxesSub', ov.boxesNeedingAttention > 0 ? `${ov.boxesNeedingAttention} need attention` : 'All nominal');
    setText('ovLoads', ov.loadsMoving);
    setText('ovLoadsSub', `${ov.tonnageMoving} t of produce`);
    setText('ovRoutesBlocked', ov.routesBlocked);
    setText('ovRoutesBlockedSub', ov.blockedRouteName || 'All clear');
    setText('ovLoss', ov.lossTodayKg + ' kg');
    setText('opActiveLoads', ov.loadsMoving);
    setText('opWeight', ov.tonnageMoving + ' t');
    setText('opCriticalRoutes', ov.routesBlocked);
    setText('opAttention', ov.boxesNeedingAttention);
  } catch (e){
    console.error('Overview load failed:', e);
    setText('ovColdBoxes', '0');
    setText('ovColdBoxesSub', 'Backend unavailable');
    setText('ovLoads', '0');
    setText('ovLoadsSub', 'Check Supabase connection');
    setText('ovRoutesBlocked', '0');
    setText('ovRoutesBlockedSub', 'Check backend');
    setText('ovLoss', '0 kg');
    setText('opActiveLoads', '0');
    setText('opWeight', '0 t');
    setText('opCriticalRoutes', '0');
    setText('opAttention', '0');
  }

  const riskWrap = document.getElementById('ovTopRisk');
  try {
    const { boxRisks } = await API.spoilageRisk();
    const top = [...boxRisks].sort((a,b) => b.risk - a.risk).slice(0, 3);
    riskWrap.innerHTML = top.length ? top.map(b => `
      <div class="ov-mini-row">
        <div class="ov-mini-left"><span class="clay small"><i data-lucide="thermometer"></i></span><span class="name">${esc(b.name)} — ${esc(b.product)}</span></div>
        <span class="status-chip ${b.level === 'HIGH' ? 'blocked' : b.level === 'MEDIUM' ? 'caution' : 'open'}">${b.risk}% ${b.level}</span>
      </div>`).join('') : emptyState('No cold boxes found.');
  } catch (e){
    riskWrap.innerHTML = emptyState('Could not load risk data.');
  }

  const alertsWrap = document.getElementById('ovTopAlerts');
  try {
    const alerts = await API.alerts();
    const top = alerts.slice(0, 3);
    alertsWrap.innerHTML = top.length ? top.map(a => `
      <div class="ov-mini-row">
        <div class="ov-mini-left"><span class="clay small"><i data-lucide="${a.severity === 'severe' ? 'triangle-alert' : 'info'}"></i></span><span class="name">${esc(a.title)}</span></div>
        <span class="alert-time" style="flex-shrink:0;">${timeAgo(a.created_at)}</span>
      </div>`).join('') : emptyState('No active alerts.');
  } catch (e){
    alertsWrap.innerHTML = emptyState('Could not load alerts.');
  }

  lucide.createIcons();
}

/* ---------------- 2. COLD BOX HEALTH ---------------- */
async function loadColdBoxes(){
  const grid = document.getElementById('boxGrid');
  try {
    const boxes = await API.coldBoxes();
    if (!boxes.length){ grid.innerHTML = emptyState('No cold boxes found. Run supabase/seed.sql.'); return; }
    grid.innerHTML = boxes.map(box => {
      const p = box.products;
      const r = box.riskInfo;
      return `
        <div class="box-card glass">
          <div class="box-card-head">
            <div>
              <div class="box-card-title">${esc(box.name)}</div>
              <div class="box-card-loc">${esc(box.location)} · ${esc(box.id)}</div>
            </div>
            <span class="status-chip ${r.level === 'HIGH' ? 'blocked' : r.level === 'MEDIUM' ? 'caution' : 'open'}">${r.level} RISK</span>
          </div>
          <span class="product-badge ${p.critical ? 'critical' : ''}">${esc(p.name)}</span>
          <div class="box-temp-row">
            <span class="clay small"><i data-lucide="thermometer"></i></span>
            <div>
              <div class="box-temp-value">${box.current_temp}°C</div>
              <div class="box-sub">${box.cooling_on ? 'Cooling running' : 'Cooling idle'} · Solar ${box.solar_input}%</div>
            </div>
          </div>
          <div>
            <div class="box-metric"><span>Humidity</span><span>${box.current_humidity}%</span></div>
            <div class="box-bar"><div class="box-bar-fill" style="width:${box.current_humidity}%"></div></div>
            <div class="box-metric"><span>Airflow</span><span>${box.current_airflow}%</span></div>
            <div class="box-bar"><div class="box-bar-fill" style="width:${box.current_airflow}%"></div></div>
            <div class="box-metric"><span>Battery</span><span>${box.battery}%</span></div>
            <div class="box-bar"><div class="box-bar-fill" style="width:${box.battery}%"></div></div>
          </div>
        </div>`;
    }).join('');
    lucide.createIcons();
  } catch (e){
    grid.innerHTML = emptyState('Could not load cold boxes: ' + e.message);
  }
}

/* ---------------- 3. COOLING & AIRFLOW ---------------- */
async function loadCooling(){
  const grid = document.getElementById('controlGrid');
  try {
    const boxes = await API.coldBoxes();
    if (!boxes.length){ grid.innerHTML = emptyState('No cold boxes found.'); return; }
    grid.innerHTML = boxes.map(box => {
      const p = box.products;
      return `
        <div class="control-card glass" data-box-id="${box.id}">
          <div class="control-row-head"><b>${esc(box.name)}</b><span class="product-badge">${esc(p.name)}</span></div>
          <div class="box-sub">Ideal for ${esc(p.name)}: ${p.ideal_temp_min}–${p.ideal_temp_max}°C, ${p.ideal_humidity_min}–${p.ideal_humidity_max}% RH</div>

          <div class="control-row">
            <div class="control-row-head"><span>Target Temperature</span><b class="ctl-temp-val">${box.target_temp}°C</b></div>
            <input type="range" class="clay-slider ctl-temp" min="-5" max="25" step="0.5" value="${box.target_temp}">
          </div>
          <div class="control-row">
            <div class="control-row-head"><span>Target Humidity</span><b class="ctl-hum-val">${box.target_humidity}%</b></div>
            <input type="range" class="clay-slider ctl-hum" min="20" max="99" value="${box.target_humidity}">
          </div>
          <div class="control-row">
            <div class="control-row-head"><span>Fan / Airflow</span><b class="ctl-fan-val">${box.fan_speed}%</b></div>
            <input type="range" class="clay-slider ctl-fan" min="0" max="100" value="${box.fan_speed}">
          </div>
          <div class="control-row-head">
            <span>Cooling System</span>
            <label class="switch"><input type="checkbox" class="ctl-cooling" ${box.cooling_on ? 'checked' : ''}><span class="slider-toggle"></span></label>
          </div>
        </div>`;
    }).join('');

    grid.querySelectorAll('.control-card').forEach(card => {
      const id = card.dataset.boxId;
      let timer;
      const debounceSend = (patch) => {
        clearTimeout(timer);
        timer = setTimeout(() => API.controlBox(id, patch).catch(e => console.error(e)), 250);
      };
      card.querySelector('.ctl-temp').addEventListener('input', e => {
        card.querySelector('.ctl-temp-val').textContent = e.target.value + '°C';
        debounceSend({ target_temp: e.target.value });
      });
      card.querySelector('.ctl-hum').addEventListener('input', e => {
        card.querySelector('.ctl-hum-val').textContent = e.target.value + '%';
        debounceSend({ target_humidity: e.target.value });
      });
      card.querySelector('.ctl-fan').addEventListener('input', e => {
        card.querySelector('.ctl-fan-val').textContent = e.target.value + '%';
        debounceSend({ fan_speed: e.target.value });
      });
      card.querySelector('.ctl-cooling').addEventListener('change', e => {
        API.controlBox(id, { cooling_on: e.target.checked }).catch(err => console.error(err));
      });
    });
  } catch (e){
    grid.innerHTML = emptyState('Could not load controls: ' + e.message);
  }
}

/* ---------------- 4. SPOILAGE RISK ---------------- */
async function loadRisk(){
  const riskGrid = document.getElementById('riskGrid');
  const loadList = document.getElementById('loadRiskList');
  try {
    const { boxRisks, loadRisks } = await API.spoilageRisk();

    riskGrid.innerHTML = boxRisks.length ? boxRisks.map(b => {
      const deg = Math.round(b.risk * 3.6);
      return `
        <div class="risk-mini-card glass">
          <div class="risk-mini-ring" style="background:conic-gradient(${riskHex(b.level)} 0deg ${deg}deg, rgba(255,255,255,0.08) ${deg}deg 360deg)"><span>${b.risk}%</span></div>
          <div class="risk-mini-name">${esc(b.name)}</div>
          <div class="risk-mini-product">${esc(b.product)} · ${b.level}</div>
        </div>`;
    }).join('') : emptyState('No cold boxes found.');

    loadList.innerHTML = loadRisks.length ? loadRisks.map(l => `
      <div class="load-risk-row">
        <span><b>${esc(l.id)}</b> — ${esc(l.product)}${l.route ? ' via ' + esc(l.route) : ''}</span>
        <span class="status-chip ${l.level === 'HIGH' ? 'blocked' : l.level === 'MEDIUM' ? 'caution' : 'open'}">${l.risk}% · ${l.level}</span>
      </div>`).join('') : emptyState('No loads currently in transit.');
  } catch (e){
    riskGrid.innerHTML = emptyState('Could not load risk data: ' + e.message);
  }
}

/* ---------------- 5. ALERTS ---------------- */
async function loadAlerts(){
  const wrap = document.getElementById('alertFeed');
  try {
    const alerts = await API.alerts();
    setText('alertBadge', alerts.length);
    if (!alerts.length){ wrap.innerHTML = `<li class="empty-state">No active alerts. Network is stable.</li>`; return; }
    wrap.innerHTML = alerts.map(a => `
      <li class="alert-item ${a.severity}">
        <span class="alert-icon clay small"><i data-lucide="${a.severity === 'severe' ? 'triangle-alert' : 'info'}"></i></span>
        <div class="alert-body">
          <div class="alert-title">${esc(a.title)}</div>
          <div class="alert-time">${a.cold_boxes ? esc(a.cold_boxes.name) + ' · ' : ''}${timeAgo(a.created_at)}</div>
        </div>
        <button class="alert-dismiss" data-resolve="${a.id}">Resolve</button>
      </li>`).join('');
    lucide.createIcons();
    wrap.querySelectorAll('[data-resolve]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await API.resolveAlert(btn.dataset.resolve);
        loadAlerts();
      });
    });
  } catch (e){
    wrap.innerHTML = `<li class="empty-state">Could not load alerts: ${esc(e.message)}</li>`;
  }
}

async function refreshAlertBadge(){
  try { const alerts = await API.alerts(); setText('alertBadge', alerts.length); } catch (e){}
}

/* ---------------- 6. ROUTE STATUS ---------------- */
function initMap(){
  // Map is non-critical: never allow a tile/CDN issue to stop the entire app.
  if (typeof L === 'undefined') { console.warn('Leaflet unavailable; skipping map initialization.'); return; }
  const mapEl = document.getElementById('map');
  if (!mapEl) { console.warn('Map container not found; skipping map initialization.'); return; }
  // Keep the logistics map intentionally focused on the hackathon geography:
  // Jammu, Kashmir Valley and Ladakh — no distracting regional zoom-out.
  const jkLadakhBounds = L.latLngBounds([[32.15, 73.35], [36.25, 80.65]]);
  mapBounds = jkLadakhBounds;
  map = L.map('map', {
    scrollWheelZoom:true,
    zoomControl:true,
    preferCanvas:true,
    maxBounds: jkLadakhBounds,
    maxBoundsViscosity: 1.0,
    maxZoom: 12 // Regional "GPS" feel — never let it zoom in past district/road level
  });
  map.fitBounds(jkLadakhBounds, { padding:[10,10] });
  // Lock the minimum zoom to whatever level exactly fits the J&K + Ladakh
  // box, so the map can never be zoomed OUT into the wider world or
  // neighboring countries/regions.
  map.setMinZoom(map.getZoom());

  // Standard OpenStreetMap road-map tiles: labelled roads + place names,
  // no API key needed (CARTO's Voyager tiles now require one — that's the
  // "API KEY REQUIRED" watermark you were seeing).
  const streets = L.tileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    {
      attribution: '© OpenStreetMap contributors',
      subdomains: 'abc',
      maxZoom: 19
    }
  );
  streets.on('tileerror', () => {
    console.warn('Map tile failed to load. The map container is working, but the tile provider is unreachable.');
  });
  streets.addTo(map);
  addCityMarkers(map);

  // Leaflet can be initialized while its panel is hidden; force a size
  // refresh and re-lock the zoom bounds once the container's real size is
  // known (fixes phones/small windows where the first size read is off).
  setTimeout(() => {
    map.invalidateSize();
    map.fitBounds(jkLadakhBounds, { padding:[10,10] });
    map.setMinZoom(map.getZoom());
  }, 150);
}

function addCityMarkers(targetMap){
  const cities = [
    {name:'Jammu', ll:[32.7266,74.8570]}, {name:'Srinagar', ll:[34.0837,74.7973]},
    {name:'Sopore', ll:[34.2996,74.4726]}, {name:'Baramulla', ll:[34.2098,74.3436]},
    {name:'Bandipora', ll:[34.4185,74.6398]}, {name:'Gurez', ll:[34.6280,74.8180]},
    {name:'Leh', ll:[34.1526,77.5771]}, {name:'Kargil', ll:[34.5539,76.1349]},
    {name:'Pampore', ll:[33.9962,74.9092]}, {name:'Shopian', ll:[33.7178,74.8319]}, {name:'Anantnag', ll:[33.7311,75.1487]},
    {name:'Sonamarg', ll:[34.3036,75.2933]}, {name:'Drass', ll:[34.4303,75.7572]},
    {name:'Udhampur', ll:[32.9153,75.1416]}, {name:'Ramban', ll:[33.2427,75.2380]},
  ];
  cities.forEach(c => {
    L.circleMarker(c.ll, { radius:4, color:'#f4f8fc', fillColor:'#f4f8fc', fillOpacity:0.9, weight:1 })
      // hover/click only — no permanent label boxes cluttering the map
      .bindTooltip(c.name, { direction:'top' }).addTo(targetMap);
  });
}

const statusColor = { open:'#31c48d', caution:'#e8a23d', blocked:'#e4483c' };

function updateRouteLayers(targetMap, layerStore, routes){
  if (!targetMap || !routes?.length) return;
  const bounds = [];
  routes.forEach(r => {
    if (layerStore[r.id]) targetMap.removeLayer(layerStore[r.id]);
    const coords = Array.isArray(r.coords) ? r.coords : [];
    if (!coords.length) return;
    const line = L.polyline(coords, {
      color: statusColor[r.status] || '#9fb3c8', weight:7, opacity:0.95,
      lineCap:'round', lineJoin:'round',
      dashArray: r.status === 'blocked' ? '3,10' : r.status === 'caution' ? '10,8' : null,
    }).addTo(targetMap);
    line.bindPopup(`<b>${esc(r.name)}</b><br>Status: ${r.status.toUpperCase()}<br>${esc(r.weather_summary || 'No weather data yet')}`);
    const start = coords[0], end = coords[coords.length - 1];
    L.circleMarker(start, {radius:7, color:'#ffffff', weight:2, fillColor:statusColor[r.status] || '#9fb3c8', fillOpacity:1}).bindTooltip('Route origin').addTo(targetMap);
    L.circleMarker(end, {radius:7, color:'#ffffff', weight:2, fillColor:statusColor[r.status] || '#9fb3c8', fillOpacity:1}).bindTooltip('Route destination').addTo(targetMap);
    layerStore[r.id] = line;
    bounds.push(...coords);
  });

  // Keep the map at the J&K + Ladakh regional framing set in initMap().
  // Route data must not zoom the user out to neighbouring countries or away from the full corridor network.
}

async function loadRoutes(){
  const listWrap = document.getElementById('routeList');
  try {
    const routes = await API.routes();
    routesCache = routes;
    updateRouteLayers(map, routeLayers, routes);

    listWrap.innerHTML = routes.map(r => `
      <li style="flex-wrap:wrap;">
        <div>
          <div class="route-name">${esc(r.name)}</div>
          <div class="route-meta">${esc(r.weather_summary || 'Awaiting weather check')} ${r.weather_checked_at ? '· ' + timeAgo(r.weather_checked_at) : ''}${r.manual_override ? ' · manually overridden' : ''}</div>
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          <span class="status-chip ${r.status}">${r.status.toUpperCase()}</span>
          <button class="btn-clay small" data-override="${r.id}">${r.status === 'blocked' ? 'Mark Open' : 'Mark Blocked'}</button>
          ${r.manual_override ? `<button class="btn-clay small ghost" data-clear-override="${r.id}">Reset to Live</button>` : ''}
        </div>
      </li>`).join('');

    listWrap.querySelectorAll('[data-override]').forEach(btn => {
      btn.addEventListener('click', async () => { await API.overrideRoute(btn.dataset.override); loadRoutes(); });
    });
    listWrap.querySelectorAll('[data-clear-override]').forEach(btn => {
      btn.addEventListener('click', async () => { await API.clearOverride(btn.dataset.clearOverride); loadRoutes(); });
    });
  } catch (e){
    listWrap.innerHTML = emptyState('Could not load routes: ' + e.message);
  }
}

/* ---------------- 7. DISRUPTION EVENTS ---------------- */
async function loadDisruptions(){
  const grid = document.getElementById('disruptionGrid');
  try {
    const [disruptions, routes] = await Promise.all([API.disruptions(), API.routes()]);

    grid.innerHTML = disruptions.length ? disruptions.map(d => `
      <div class="disruption-card glass">
        <div class="disruption-head">
          <span class="disruption-type">${esc(d.type.replace('_',' '))}</span>
          <span class="status-chip ${d.severity === 'high' ? 'blocked' : d.severity === 'medium' ? 'caution' : 'open'}">${d.severity.toUpperCase()}</span>
        </div>
        <div class="disruption-loc">${esc(d.location)} · ${d.routes ? esc(d.routes.name) : ''}</div>
        <div class="disruption-time">Reported ${timeAgo(d.reported_at)}</div>
        <button class="disruption-resolve" data-resolve-disruption="${d.id}">Mark resolved</button>
      </div>`).join('') : emptyState('No active disruptions.');

    const routeSelect = document.getElementById('disruptionRoute');
    routeSelect.innerHTML = routes.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('');

    grid.querySelectorAll('[data-resolve-disruption]').forEach(btn => {
      btn.addEventListener('click', async () => { await API.resolveDisruption(btn.dataset.resolveDisruption); loadDisruptions(); loadRoutes(); });
    });
  } catch (e){
    grid.innerHTML = emptyState('Could not load disruptions: ' + e.message);
  }
}

function wireDisruptionForm(){
  document.getElementById('disruptionForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      route_id: document.getElementById('disruptionRoute').value,
      type: document.getElementById('disruptionType').value,
      severity: document.getElementById('disruptionSeverity').value,
      location: document.getElementById('disruptionLocation').value.trim(),
    };
    if (!body.location) return;
    await API.createDisruption(body);
    document.getElementById('disruptionLocation').value = '';
    loadDisruptions();
    if (activePanel === 'routes') loadRoutes();
  });
}

/* ---------------- 8. REROUTE ASSISTANT ---------------- */
async function loadReroute(){
  const wrap = document.getElementById('rerouteList');
  try {
    const suggestions = await API.rerouteSuggestions();
    if (!suggestions.length){ wrap.innerHTML = emptyState('No reroute suggestions right now — all routes are clear.'); return; }

    wrap.innerHTML = suggestions.map(s => {
      const productName = s.loads && s.loads.products ? s.loads.products.name : '';
      const meta = s.to_route_id
        ? `Saves ~${s.hours_saved}h · protects ${s.tonnage_protected}t`
        : `Holds ${s.tonnage_protected}t — no route currently beats the spoilage clock`;
      return `
        <div class="reroute-card glass">
          <div class="reroute-main">
            <div class="reroute-title">${s.to_route_id ? `Reroute ${esc(s.load_id)} via ${esc(s.to ? s.to.name : '')}` : `Hold ${esc(s.load_id)} at current cold point`}</div>
            <div class="reroute-reason">${esc(s.reason)} ${productName ? '· ' + esc(productName) : ''}</div>
            <div class="reroute-meta">${esc(meta)}</div>
          </div>
          <div class="reroute-actions">
            <span class="status-badge ${s.status}">${s.status.toUpperCase()}</span>
            ${s.status === 'pending' ? `<button class="btn-clay small" data-approve="${s.id}">Approve</button>` : ''}
            ${s.status === 'approved' && s.to_route_id ? `<button class="btn-clay small" data-apply="${s.id}">Apply</button>` : ''}
          </div>
        </div>`;
    }).join('');

    wrap.querySelectorAll('[data-approve]').forEach(btn => {
      btn.addEventListener('click', async () => { await API.approveReroute(btn.dataset.approve); loadReroute(); });
    });
    wrap.querySelectorAll('[data-apply]').forEach(btn => {
      btn.addEventListener('click', async () => { await API.applyReroute(btn.dataset.apply); loadReroute(); if (activePanel === 'loads') loadLoads(); });
    });
  } catch (e){
    wrap.innerHTML = emptyState('Could not load reroute suggestions: ' + e.message);
  }
}

/* ---------------- 9. LOADS IN TRANSIT ---------------- */
async function loadLoads(){
  const body = document.getElementById('loadsTableBody');
  try {
    const loads = await API.loads();
    body.innerHTML = loads.length ? loads.map(l => `
      <tr>
        <td class="truck-id">${esc(l.id)}</td>
        <td>${l.products ? esc(l.products.name) : '—'}<div class="route-meta">${l.weight_kg} kg</div></td>
        <td>${l.cold_boxes ? esc(l.cold_boxes.name) : '—'}</td>
        <td>${l.routes ? esc(l.routes.name) : '—'} ${l.routes ? statusChipHtml(l.routes.status) : ''}</td>
        <td>${l.status.replace('_',' ')}</td>
        <td>${fmtTime(l.eta)}</td>
        <td>${l.riskInfo ? `<span class="status-chip ${l.riskInfo.level === 'HIGH' ? 'blocked' : l.riskInfo.level === 'MEDIUM' ? 'caution' : 'open'}">${l.riskInfo.risk}% ${l.riskInfo.level}</span>` : '—'}</td>
        <td class="action-cell">${l.status === 'in_transit' ? `<button class="btn-clay small" data-report-delay="${esc(l.id)}"><i data-lucide="clock"></i> Report Delay</button>` : ''}</td>
      </tr>`).join('') : `<tr><td colspan="8" class="empty-state">No loads found.</td></tr>`;
    body.querySelectorAll('[data-report-delay]').forEach(btn => btn.addEventListener('click', () => openDelayModal(btn.dataset.reportDelay)));
    lucide.createIcons();
  } catch (e){
    body.innerHTML = `<tr><td colspan="8" class="empty-state">Could not load: ${esc(e.message)}</td></tr>`;
  }
}

/* ---------------- REPORT DELAY (real weather-driven projection, not simulated) ---------------- */
function openDelayModal(loadId){
  document.getElementById('delayLoadId').value = loadId;
  document.getElementById('delayLocation').value = '';
  document.getElementById('delayHours').value = '';
  document.getElementById('delayModalOverlay').style.display = 'flex';
}
function closeDelayModal(){ document.getElementById('delayModalOverlay').style.display = 'none'; }
async function submitDelayReport(){
  const loadId = document.getElementById('delayLoadId').value;
  const type = document.getElementById('delayType').value;
  const location = document.getElementById('delayLocation').value.trim();
  const severity = document.getElementById('delaySeverity').value;
  const hours = Number(document.getElementById('delayHours').value);
  if (!location) return alert('Enter a location for this blockage.');
  if (!hours || hours <= 0) return alert('Enter the estimated delay in hours.');
  const btn = document.getElementById('delaySubmitBtn');
  btn.disabled = true; btn.innerHTML = '<i data-lucide="loader-2"></i> Analyzing…'; lucide.createIcons();
  try {
    const result = await API.reportDelay({ load_id: loadId, type, location, severity, estimated_delay_hours: hours });
    renderDelayAnalysis(loadId, result);
    closeDelayModal();
    loadLoads(); refreshAlertBadge();
  } catch (e) {
    alert(e.message || 'Could not run delay analysis.');
  } finally {
    btn.disabled = false; btn.innerHTML = '<i data-lucide="triangle-alert"></i> Run Analysis'; lucide.createIcons();
  }
}
function renderDelayAnalysis(loadId, r){
  const card = document.getElementById('delayAnalysisCard');
  const a = r.analysis;
  const suggestion = (r.rerouteSuggestions || [])[0] || null;
  card.innerHTML = `
    <div class="card-head"><h3><i data-lucide="thermometer"></i> Delay Analysis — ${esc(loadId)}</h3><span class="card-tag">${esc(r.disruption.type.replace('_',' '))} at ${esc(r.disruption.location)}</span></div>
    ${a ? `
    <p class="box-sub">Projected over ${a.delayHours}h using real ambient weather: <b>${a.ambientTemp}°C</b>, ${a.ambientHumidity}% humidity.</p>
    <div class="delay-result-grid">
      <div class="delay-result-block"><span>Projected Temp</span><b>${a.projectedTemp}°C</b></div>
      <div class="delay-result-block"><span>Projected Humidity</span><b>${a.projectedHumidity}%</b></div>
      <div class="delay-result-block"><span>Risk Before</span><b>${a.riskBefore}%</b></div>
      <div class="delay-result-block"><span>Risk After</span><b class="status-chip ${a.riskAfter >= 66 ? 'blocked' : a.riskAfter >= 33 ? 'caution' : 'open'}">${a.riskAfter}%</b></div>
      <div class="delay-result-block"><span>Est. Additional Waste</span><b>${a.estimatedAdditionalWasteKg} kg</b></div>
    </div>` : `<p class="box-sub">No cold box attached to this load — disruption logged, but no sensor-based projection is available.</p>`}
    ${suggestion ? `<p class="box-sub">${suggestion.to && suggestion.to.name
        ? `Reroute Assistant suggests moving this load via <b>${esc(suggestion.to.name)}</b>, saving ~${suggestion.hours_saved}h.`
        : `Reroute Assistant checked for alternates: ${esc(suggestion.reason)}`}</p>
       <button class="btn-clay small" onclick="switchPanel('reroute')" style="margin-top:6px;"><i data-lucide="route"></i> Open Reroute Assistant</button>` : ''}
  `;
  card.style.display = 'block';
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  lucide.createIcons();
}

/* ---------------- 10. WASTE & IMPACT ---------------- */
function initWasteChart(){
  // Chart is non-critical: never allow a CDN failure to block dashboard data.
  if (typeof Chart === 'undefined') { console.warn('Chart.js unavailable; skipping chart initialization.'); return; }
  const ctx = document.getElementById('wasteChart');
  if (!ctx) { console.warn('Waste chart canvas not found; skipping chart initialization.'); return; }
  wasteChart = new Chart(ctx, {
    type:'line',
    data:{ labels:[], datasets:[
      { label:'Saved (kg)', data:[], borderColor:'#31c48d', backgroundColor:'rgba(49,196,141,0.12)', fill:true, tension:0.35 },
      { label:'Waste (kg)', data:[], borderColor:'#e4483c', backgroundColor:'rgba(228,72,60,0.10)', fill:true, tension:0.35 },
    ]},
    options:{
      responsive:true,
      plugins:{ legend:{ labels:{ color:'#c7d6e6', font:{ family:'Inter', size:11 } } } },
      scales:{
        x:{ ticks:{ color:'#9fb3c8', font:{ size:10.5 } }, grid:{ color:'rgba(255,255,255,0.05)' } },
        y:{ ticks:{ color:'#9fb3c8', font:{ size:10.5 } }, grid:{ color:'rgba(255,255,255,0.05)' } },
      }
    }
  });
}

async function loadWaste(){
  try {
    const w = await API.wasteImpact();
    setText('wasteSaved', w.produceSavedTonnes + ' t');
    setText('wasteRate', w.wasteRate + '%');
    setText('wasteCo2', w.co2AvoidedTonnes + ' t');
    wasteChart.data.labels = w.dailySeries.map(d => d.day.slice(5));
    wasteChart.data.datasets[0].data = w.dailySeries.map(d => d.saved);
    wasteChart.data.datasets[1].data = w.dailySeries.map(d => d.waste);
    wasteChart.update();
  } catch (e){
    console.error(e);
  }
}

/* ---------------- REGISTER CARGO ---------------- */
let cargoProducts = [];
let cargoColdBoxesAll = [];
let cargoRoutesAll = [];
function cargoCalc(){
  const boxes = Number(document.getElementById('cargoBoxes')?.value) || 0;
  const perBox = Number(document.getElementById('cargoWeightPerBox')?.value) || 0;
  const price = Number(document.getElementById('cargoUnitPrice')?.value) || 0;
  const method = document.getElementById('cargoPricingMethod')?.value || 'per_kg';
  const totalWeight = boxes * perBox;
  const totalValue = method === 'per_box' ? boxes * price : totalWeight * price;
  setText('cargoTotalWeight', `${totalWeight.toLocaleString(undefined,{maximumFractionDigits:2})} kg`);
  setText('cargoTotalValue', `₹${totalValue.toLocaleString(undefined,{maximumFractionDigits:2})}`);
  const label = document.getElementById('cargoPriceLabel');
  if (label) label.textContent = method === 'per_box' ? 'Price per Box (₹)' : 'Price per KG (₹)';
  return { boxes, perBox, price, method, totalWeight, totalValue };
}
async function loadRegisterCargo(){
  const select = document.getElementById('cargoProduct');
  if (!select) return;
  try {
    // Never let the picker offer (or silently keep, via browser autofill) a
    // past date/time — that's exactly what causes a shipment to look
    // "delivered" the instant it's registered.
    const departureInput = document.getElementById('cargoDeparture');
    if (departureInput) {
      const now = new Date();
      now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
      departureInput.min = now.toISOString().slice(0, 16);
    }
    if (!cargoProducts.length) cargoProducts = await API.products();
    const current = select.value;
    select.innerHTML = `<option value="">Select product</option>` + cargoProducts.map(p => `<option value="${esc(p.id)}">${esc(p.name)} · ${esc(p.category)}</option>`).join('');
    if (current) select.value = current;
    // Refresh fleet + active loads each time this panel opens, so "already
    // carrying a shipment" boxes are correctly excluded from the picker.
    cargoColdBoxesAll = await API.coldBoxes();
    populateCargoColdBoxOptions();
    // Real corridors, picked explicitly — this is what actually links a
    // registration to live weather, risk and the reroute engine, instead of
    // guessing from free-text origin/destination.
    cargoRoutesAll = await API.routes();
    const routeSelect = document.getElementById('cargoRoute');
    if (routeSelect) {
      const currentRoute = routeSelect.value;
      routeSelect.innerHTML = `<option value="">No corridor match — custom/local route</option>` +
        cargoRoutesAll.map(r => `<option value="${esc(r.id)}">${esc(r.name)} (${r.status.toUpperCase()})</option>`).join('');
      if (currentRoute) routeSelect.value = currentRoute;
    }
  } catch (e) { console.error(e); }
}
async function populateCargoColdBoxOptions(){
  const boxSelect = document.getElementById('cargoColdBox');
  const productId = document.getElementById('cargoProduct')?.value;
  if (!boxSelect) return;
  let activeBoxIds = new Set();
  try { const loads = await API.loads(); activeBoxIds = new Set(loads.filter(l => l.status === 'in_transit' && l.cold_box_id).map(l => l.cold_box_id)); } catch (e) { /* non-fatal */ }
  const matches = cargoColdBoxesAll.filter(b => (!productId || b.product_id === productId) && !activeBoxIds.has(b.id));
  const current = boxSelect.value;
  boxSelect.innerHTML = `<option value="">No cold box — generic risk baseline</option>` +
    matches.map(b => `<option value="${esc(b.id)}">${esc(b.name)} · ${esc(b.location)} (${b.current_temp}°C now)</option>`).join('');
  if (current && matches.some(b => b.id === current)) boxSelect.value = current;
}
function getCargoPayload(){
  const c = cargoCalc();
  return {
    owner_name: document.getElementById('cargoOwnerName').value.trim(), phone: document.getElementById('cargoPhone').value.trim(),
    origin: document.getElementById('cargoOrigin').value.trim(), destination: document.getElementById('cargoDestination').value.trim(),
    route_id: document.getElementById('cargoRoute')?.value || null,
    expected_duration_hours: Number(document.getElementById('cargoTransitHours').value), departure: document.getElementById('cargoDeparture').value || null,
    product_id: document.getElementById('cargoProduct').value, cold_box_id: document.getElementById('cargoColdBox')?.value || null,
    quantity_boxes: c.boxes, weight_per_box_kg: c.perBox, pricing_method: c.method, unit_price: c.price,
  };
}
function validateCargo(p){ return p.owner_name && p.phone && p.origin && p.destination && p.expected_duration_hours > 0 && p.product_id && p.quantity_boxes > 0 && p.weight_per_box_kg > 0 && p.unit_price >= 0; }
function showCargoReview(){
  const p = getCargoPayload(); if (!validateCargo(p)) return alert('Please complete all required fields before reviewing.');
  const product = cargoProducts.find(x => x.id === p.product_id);
  const box = cargoColdBoxesAll.find(x => x.id === p.cold_box_id);
  const route = cargoRoutesAll.find(x => x.id === p.route_id);
  const totalWeight = p.quantity_boxes * p.weight_per_box_kg;
  const totalValue = p.pricing_method === 'per_box' ? p.quantity_boxes * p.unit_price : totalWeight * p.unit_price;
  document.getElementById('cargoReviewContent').innerHTML = `
    <div class="review-grid">
      <div class="review-block"><span>OWNER</span><b>${esc(p.owner_name)}</b><small>${esc(p.phone)}</small></div>
      <div class="review-block"><span>ORIGIN → DESTINATION</span><b>${esc(p.origin)} → ${esc(p.destination)}</b><small>${p.expected_duration_hours}h expected transit time</small></div>
      <div class="review-block"><span>CORRIDOR</span><b>${route ? esc(route.name) : 'Not linked to a tracked corridor'}</b><small>${route ? `Live status: ${route.status.toUpperCase()}` : 'Weather/risk/reroute features will not apply'}</small></div>
      <div class="review-block"><span>PRODUCT</span><b>${esc(product ? product.name : p.product_id)}</b><small>${p.quantity_boxes} boxes × ${p.weight_per_box_kg} kg</small></div>
      <div class="review-block"><span>COLD BOX</span><b>${box ? esc(box.name) : 'None assigned'}</b><small>${box ? 'Live sensor tracking enabled' : 'Generic risk baseline only'}</small></div>
      <div class="review-block"><span>TOTAL WEIGHT</span><b>${totalWeight.toLocaleString()} kg</b><small>Calculated automatically</small></div>
      <div class="review-block"><span>PRICING</span><b>₹${p.unit_price.toLocaleString()} ${p.pricing_method === 'per_box' ? '/ box' : '/ kg'}</b><small>Pricing method selected</small></div>
      <div class="review-block total"><span>TOTAL CARGO VALUE</span><b>₹${totalValue.toLocaleString()}</b><small>This is the declared cargo value</small></div>
    </div>`;
  document.getElementById('cargoReviewCard').style.display='block';
  document.getElementById('cargoSuccessCard').style.display='none';
  document.getElementById('cargoReviewCard').scrollIntoView({behavior:'smooth', block:'nearest'});
  lucide.createIcons();
}
async function confirmCargo(){
  const p=getCargoPayload(); if(!validateCargo(p)) return alert('Please complete all required fields.');
  const btn=document.getElementById('cargoConfirmBtn'); btn.disabled=true; btn.textContent='Registering...';
  try {
    const created=await API.registerCargo(p);
    document.getElementById('cargoReviewCard').style.display='none';
    const success=document.getElementById('cargoSuccessCard'); success.style.display='block';
    const ia = created.impactAnalysis;
    const impactHtml = ia ? `
      <div class="impact-analysis-block" style="margin-top:14px; padding-top:14px; border-top:1px solid rgba(255,255,255,0.12);">
        <div class="control-row-head"><b><i data-lucide="triangle-alert"></i> Impact Analysis${ia.routeName ? ` — ${esc(ia.routeName)} is ${ia.routeStatus.toUpperCase()}` : ''}</b></div>
        ${ia.routeName ? `<div class="box-sub" style="margin:6px 0;">${esc(ia.weatherSummary || 'Reason pending next weather check')}</div>` : ''}
        <div style="display:flex; gap:10px; flex-wrap:wrap; margin:8px 0;">
          <span class="status-chip ${ia.riskLevel === 'HIGH' ? 'blocked' : ia.riskLevel === 'MEDIUM' ? 'caution' : 'open'}">Spoilage risk: ${ia.risk}% (${ia.riskLevel})</span>
          ${ia.routeStatus ? `<span class="status-chip ${ia.routeStatus}">${ia.routeStatus.toUpperCase()}</span>` : ''}
        </div>
        ${ia.coldBoxName ? `<div class="box-sub">Live from <b>${esc(ia.coldBoxName)}</b>: ${ia.liveSensor.temp}°C · ${ia.liveSensor.humidity}% humidity · ${ia.liveSensor.battery}% battery — risk above is computed from these real sensor readings, not a generic baseline.</div>` : `<div class="box-sub">No cold box assigned — risk above is a generic route-only baseline. Assign a cold box next time for live sensor-based risk.</div>`}
        ${ia.routeStatus && ia.routeStatus !== 'open' ? `
        <div class="box-sub" style="margin-top:6px;">
          ${ia.rerouteSuggestion
            ? (ia.rerouteSuggestion.toRouteName
                ? `Reroute Assistant already suggests moving this load via <b>${esc(ia.rerouteSuggestion.toRouteName)}</b>, saving ~${ia.rerouteSuggestion.hoursSaved}h.`
                : `Reroute Assistant checked for alternates: ${esc(ia.rerouteSuggestion.reason)}`)
            : 'Reroute Assistant is evaluating alternates for this route.'}
        </div>
        <button class="btn-clay small" id="cargoGoToReroute" style="margin-top:10px;"><i data-lucide="route"></i> Open Reroute Assistant</button>` : ''}
      </div>` : '';
    success.innerHTML=`<div class="success-wrap"><span class="success-icon clay"><i data-lucide="check-circle-2"></i></span><div><h3>Cargo Registered Successfully</h3><p><b>${esc(created.id)}</b> is now registered in FRIGARO's cold-chain workflow.</p><div class="success-meta">${created.calculated.totalWeight.toLocaleString()} kg · ₹${created.calculated.totalCargoValue.toLocaleString()} · ${created.calculated.matchedRoute ? esc(created.calculated.matchedRoute) : 'Custom route pending corridor match'}</div>${impactHtml}</div></div>`;
    document.getElementById('cargoGoToReroute')?.addEventListener('click', () => switchPanel('reroute'));
    document.getElementById('cargoForm').reset(); cargoCalc(); populateCargoColdBoxOptions();
    loadOverview(); refreshAlertBadge(); lucide.createIcons();
  } catch(e){ alert(e.message || 'Could not register cargo.'); }
  finally { btn.disabled=false; btn.innerHTML='<i data-lucide="check-circle-2"></i> Confirm Registration'; lucide.createIcons(); }
}
function wireCargoForm(){
  ['cargoBoxes','cargoWeightPerBox','cargoUnitPrice','cargoPricingMethod'].forEach(id=>document.getElementById(id)?.addEventListener('input',cargoCalc));
  document.getElementById('cargoProduct')?.addEventListener('change', populateCargoColdBoxOptions);
  document.getElementById('cargoReviewBtn')?.addEventListener('click',showCargoReview);
  document.getElementById('cargoEditBtn')?.addEventListener('click',()=>document.getElementById('cargoReviewCard').style.display='none');
  document.getElementById('cargoConfirmBtn')?.addEventListener('click',confirmCargo);
  document.getElementById('overviewRegisterBtn')?.addEventListener('click',()=>switchPanel('register-cargo'));
}

/* ---------------- PANEL SWITCHING ---------------- */
const panelTitles = {
  overview: ['Control Room Overview', 'Every cold box, route and load at a glance'],
  'register-cargo': ['Register Cargo', 'Add a shipment, calculate its value, then review before confirmation'],
  'cold-boxes': ['Cold Box Health', 'Temperature, humidity, airflow, battery and cooling state'],
  cooling: ['Cooling & Airflow Control', 'Set the target climate inside each box'],
  risk: ['Spoilage Risk', 'Risk grade per box and load, from real climate + product data'],
  alerts: ['Alerts', 'Live warnings from boxes and roads'],
  routes: ['Route Status', 'Mountain corridors — open, caution or blocked, from live weather'],
  disruptions: ['Disruption Events', 'What is holding traffic up right now'],
  reroute: ['Reroute Assistant', 'Suggested moves — you stay in control'],
  loads: ['Loads in Transit', 'Every truck, its crate and its route'],
  waste: ['Waste & Impact', 'What the decisions saved this week'],
};

const panelLoaders = {
  overview: loadOverview, 'register-cargo': loadRegisterCargo, 'cold-boxes': loadColdBoxes, cooling: loadCooling, risk: loadRisk,
  alerts: loadAlerts, routes: loadRoutes, disruptions: loadDisruptions, reroute: loadReroute,
  loads: loadLoads, waste: loadWaste,
};

function switchPanel(name){
  activePanel = name;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.panel === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
  const [title, sub] = panelTitles[name];
  setText('pageTitle', title); setText('pageSub', sub);
  if (name === 'routes') {
    if (!map) {
      // Build the map lazily, the first time this panel is actually visible.
      // Leaflet needs a real (non-zero) container size to compute a valid
      // initial view — building it while the panel was still display:none
      // produced a NaN center/zoom and threw before the tile layer was ever
      // added, which is why no tiles (and no Esri attribution) ever showed.
      setTimeout(() => { try { initMap(); } catch (e) { console.error('Map init failed:', e); } }, 50);
    } else {
      // Panel was already visited once — just resync size/framing.
      setTimeout(() => {
        map.invalidateSize();
        if (mapBounds) {
          map.fitBounds(mapBounds, { padding: [10, 10] });
          map.setMinZoom(map.getZoom());
        }
      }, 200);
    }
  }
  panelLoaders[name]().then(() => { if (window.lucide) lucide.createIcons(); });
}

/* ---------------- CLOCK ---------------- */
function tickClock(){ setText('clock', new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' })); }

/* ---------------- INIT ---------------- */
document.addEventListener('DOMContentLoaded', async () => {
  // IMPORTANT: Optional visual components must never prevent data loading.
  try { if (window.lucide) lucide.createIcons(); } catch (e) { console.warn('Lucide init failed:', e); }
  // Map is now initialized lazily in switchPanel(), the first time the
  // Route Status panel is actually opened (see there for why).
  try { initWasteChart(); } catch (e) { console.error('Chart init failed:', e); }
  try { wireDisruptionForm(); } catch (e) { console.error('Disruption form init failed:', e); }
  try { wireCargoForm(); cargoCalc(); } catch (e) { console.error('Cargo form init failed:', e); }
  try {
    document.getElementById('delayCancelBtn')?.addEventListener('click', closeDelayModal);
    document.getElementById('delaySubmitBtn')?.addEventListener('click', submitDelayReport);
    document.getElementById('delayModalOverlay')?.addEventListener('click', (e) => { if (e.target.id === 'delayModalOverlay') closeDelayModal(); });
  } catch (e) { console.error('Delay modal init failed:', e); }

  // Always run backend checks and dashboard loading even if a visual library fails.
  try { await checkHealth(); } catch (e) { console.error('Health initialization failed:', e); }
  try { await switchPanel('overview'); } catch (e) { console.error('Overview initialization failed:', e); }
  try { await refreshAlertBadge(); } catch (e) { console.error('Alert badge initialization failed:', e); }

  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => switchPanel(btn.dataset.panel));
  });

  document.getElementById('clearAlertsBtn').addEventListener('click', async () => {
    await API.clearAlerts();
    loadAlerts();
  });

  const forceBtn = document.getElementById('forceTickBtn');
  forceBtn.addEventListener('click', async () => {
    forceBtn.classList.add('spinning');
    try {
      await API.tick();
      await panelLoaders[activePanel]();
      await refreshAlertBadge();
      lucide.createIcons();
    } catch (e){ console.error(e); }
    forceBtn.classList.remove('spinning');
  });

  tickClock();
  setInterval(tickClock, 1000);
  setInterval(() => panelLoaders[activePanel]().then(() => { if (window.lucide) lucide.createIcons(); }).catch(e => console.error('Auto refresh failed:', e)), 20000);
  setInterval(refreshAlertBadge, 15000);
  setInterval(checkHealth, 30000);
});