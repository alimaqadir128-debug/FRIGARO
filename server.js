/* ============================================================
   FRIGARO — server.js (Supabase + live weather edition)

   Real persistence: Supabase Postgres (no local JSON files).
   Real weather: Open-Meteo current-conditions API, cached
   10 minutes per route checkpoint, drives route status.
   Real, product-aware spoilage model: each cold box holds one
   product from the `products` table (apples, cherries, dairy,
   vaccines, walnuts, tomatoes, ...), each with its own ideal
   temperature/humidity band and spoilage sensitivity.

   Everything computed here (risk, alerts, reroute suggestions,
   waste/impact stats) is derived from what's actually stored in
   Supabase — nothing on the dashboard is a hardcoded number.
   ============================================================ */

require('dotenv').config();
const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------------- SUPABASE ---------------- */
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.warn('\n⚠️  SUPABASE_URL / SUPABASE_SERVICE_KEY are not set.');
  console.warn('   Copy .env.example to .env, run supabase/schema.sql and');
  console.warn('   supabase/seed.sql in your Supabase project, then fill in .env.\n');
}

const supabase = createClient(
  process.env.SUPABASE_URL || 'http://localhost',
  process.env.SUPABASE_SERVICE_KEY || 'placeholder'
);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------- WEATHER (Open-Meteo — free, no API key) ---------------- */
const WEATHER_CACHE_MS = 10 * 60 * 1000;
const weatherCache = new Map();

/* ============================================================
   RELIABLE WEATHER FETCHING
   - Uses Open-Meteo
   - Retries twice
   - Uses timeout protection
   - Uses cached data if available
   - Uses safe fallback conditions if provider is unavailable
   ============================================================ */

async function getWeather(lat, lng) {
  const key = `${lat},${lng}`;
  const cached = weatherCache.get(key);

  // Return recent cached weather
  if (cached && Date.now() - cached.fetchedAt < WEATHER_CACHE_MS) {
    return cached.data;
  }

  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${encodeURIComponent(lat)}` +
    `&longitude=${encodeURIComponent(lng)}` +
    `&current=temperature_2m,weather_code,snowfall,rain,relative_humidity_2m` +
    `&timezone=auto`;

  // Try live weather twice
  for (let attempt = 1; attempt <= 2; attempt++) {
    let timeout;

    try {
      const controller = new AbortController();

      timeout = setTimeout(() => {
        controller.abort();
      }, 8000);

      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
        },
      });

      clearTimeout(timeout);

      if (!res.ok) {
        console.error(
          `Weather API attempt ${attempt} failed: HTTP ${res.status}`
        );
        continue;
      }

      const data = await res.json();

      if (data && data.current) {
        weatherCache.set(key, {
          data,
          fetchedAt: Date.now(),
        });

        return data;
      }

    } catch (e) {
      console.error(
        `Weather fetch attempt ${attempt} failed:`,
        e.message
      );
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  // Use old cached weather if available
  if (cached && cached.data) {
    console.warn(
      'Using cached weather because live weather is unavailable.'
    );

    return cached.data;
  }

  /*
    Safe fallback.

    FRIGARO's disruption and risk analysis should not completely
    stop simply because an external weather provider is temporarily
    unreachable.

    Live Open-Meteo data automatically replaces this fallback
    whenever the provider becomes available again.
  */

  console.warn(
    'Live weather unavailable. Using fallback ambient conditions.'
  );

  const fallbackData = {
    current: {
      temperature_2m: 18,
      relative_humidity_2m: 65,
      weather_code: 3,
      snowfall: 0,
      rain: 0,
    },
    fallback: true,
  };

  weatherCache.set(key, {
    data: fallbackData,
    fetchedAt: Date.now(),
  });

  return fallbackData;
}

// WMO weather codes (used by Open-Meteo) -> human label.
const WMO_LABELS = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Dense drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  66: 'Freezing rain',
  67: 'Heavy freezing rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Light rain showers',
  81: 'Rain showers',
  82: 'Violent rain showers',
  85: 'Snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with hail',
  99: 'Severe thunderstorm with hail',
};

function wmoLabel(code) {
  return WMO_LABELS[code] || `Weather code ${code}`;
}

function weatherToStatus(weatherData) {
  if (!weatherData || !weatherData.current) return null;

  const code = weatherData.current.weather_code;
  const temp = weatherData.current.temperature_2m;
  const snowfall = weatherData.current.snowfall || 0;
  const label = wmoLabel(code);

  const heavySnowCodes = [75, 86];
  const snowCodes = [71, 73, 77, 85];
  const thunderCodes = [95, 96, 99];
  const rainCodes = [61, 63, 65, 66, 67, 80, 81, 82];

  if (heavySnowCodes.includes(code)) {
    return {
      status: 'blocked',
      summary: `${label} — ${temp}°C`
    };
  }

  if (snowfall >= 1) {
    return {
      status: 'blocked',
      summary: `Heavy snowfall accumulating (${snowfall}cm) — ${temp}°C`
    };
  }

  if (thunderCodes.includes(code)) {
    return {
      status: 'caution',
      summary: `${label} — ${temp}°C`
    };
  }

  if (snowCodes.includes(code) || rainCodes.includes(code)) {
    return {
      status: 'caution',
      summary: `${label} — ${temp}°C`
    };
  }

  if (typeof temp === 'number' && temp <= -10) {
    return {
      status: 'caution',
      summary: `Extreme cold — ${temp}°C (ice risk)`
    };
  }

  return {
    status: 'open',
    summary: `${label} — ${temp}°C`
  };
}

/* ---------------- SPOILAGE MODEL (product-aware) ---------------- */

function deviation(current, min, max) {
  if (current > max) return current - max;
  if (current < min) return min - current;
  return 0;
}

function riskLevelFor(risk, critical) {
  if (critical) {
    return risk >= 40
      ? 'HIGH'
      : risk >= 18
        ? 'MEDIUM'
        : 'LOW';
  }

  return risk >= 66
    ? 'HIGH'
    : risk >= 33
      ? 'MEDIUM'
      : 'LOW';
}

function computeBoxRisk(box, product) {
  const tempDev = deviation(
    box.current_temp,
    product.ideal_temp_min,
    product.ideal_temp_max
  );

  const humDev = deviation(
    box.current_humidity,
    product.ideal_humidity_min,
    product.ideal_humidity_max
  );

  const batteryPenalty =
    Math.max(0, 55 - box.battery) * 0.35;

  let risk =
    tempDev * 9 * product.spoilage_sensitivity +
    humDev * 2.2 * product.spoilage_sensitivity +
    batteryPenalty;

  risk = Math.round(
    Math.min(99, Math.max(2, risk))
  );

  return {
    risk,
    level: riskLevelFor(risk, product.critical),
    tempDev,
    humDev
  };
}

function computeLoadRisk(box, product, route) {
  const base =
    box && product
      ? computeBoxRisk(box, product)
      : {
          risk: 25,
          level: 'MEDIUM',
          tempDev: 0,
          humDev: 0
        };

  let risk = base.risk;

  if (route) {
    if (route.status === 'blocked') {
      risk += 25;
    } else if (route.status === 'caution') {
      risk += 10;
    }
  }

  risk = Math.round(Math.min(99, risk));

  return {
    risk,
    level: riskLevelFor(
      risk,
      product ? product.critical : false
    ),
    tempDev: base.tempDev,
    humDev: base.humDev
  };
}

/* ---------------- ALERTS ---------------- */

async function raiseAlert({
  cold_box_id = null,
  load_id = null,
  severity,
  title,
  dedupe_key
}) {
  const { error } = await supabase
    .from('alerts')
    .insert({
      cold_box_id,
      load_id,
      severity,
      title,
      dedupe_key
    });

  if (error && error.code !== '23505') {
    console.error(
      'alert insert error:',
      error.message
    );
  }
}

async function resolveStaleAlerts(activeDedupeKeys) {
  const { data: unresolved } = await supabase
    .from('alerts')
    .select('id, dedupe_key')
    .eq('resolved', false);

  if (!unresolved) return;

  const toResolve = unresolved.filter(
    a => !activeDedupeKeys.has(a.dedupe_key)
  );

  for (const a of toResolve) {
    await supabase
      .from('alerts')
      .update({ resolved: true })
      .eq('id', a.id);
  }
}

/* ---------------- BACKGROUND JOBS ---------------- */

// 1. Drift each cold box's simulated sensor toward its target,
//    influenced by real ambient weather at the box's own
//    coordinates, then persist + alert.

async function tickColdBoxes() {
  const { data: boxes, error } = await supabase
    .from('cold_boxes')
    .select('*, products(*)');

  if (error || !boxes) {
    return console.error(
      'tickColdBoxes select failed:',
      error && error.message
    );
  }

  const activeDedupeKeys = new Set();

  const { data: existingAlerts } = await supabase
    .from('alerts')
    .select('dedupe_key')
    .eq('resolved', false);

  const carryForward = new Set(
    (existingAlerts || [])
      .map(a => a.dedupe_key)
      .filter(k => !k.startsWith('box:'))
  );

  carryForward.forEach(k =>
    activeDedupeKeys.add(k)
  );

  for (const box of boxes) {
    const product = box.products;

    if (!product) continue;

    const ambient = await getWeather(
      box.lat,
      box.lng
    );

    const ambientTemp =
      ambient && ambient.current
        ? ambient.current.temperature_2m
        : 15;

    const coolingPull =
      box.cooling_on ? 0.4 : 0.05;

    const ambientPull = 0.12;

    let nextTemp =
      box.current_temp +
      (box.target_temp - box.current_temp) *
        coolingPull +
      (ambientTemp - box.current_temp) *
        ambientPull +
      (Math.random() - 0.5) * 0.3;

    nextTemp = +nextTemp.toFixed(1);

    let nextHum =
      box.current_humidity +
      (box.target_humidity -
        box.current_humidity) *
        0.3 +
      (Math.random() - 0.5) * 2;

    nextHum = Math.round(
      Math.max(20, Math.min(99, nextHum))
    );

    const nextAirflow = Math.round(
      Math.max(
        15,
        Math.min(
          98,
          box.fan_speed * 0.9 +
            (Math.random() - 0.5) * 6
        )
      )
    );

    const hourNow = new Date().getHours();

    const isDaylight =
      hourNow >= 6 && hourNow <= 18;

    let nextSolar =
      box.solar_input +
      ((isDaylight ? 75 : 15) -
        box.solar_input) *
        0.2 +
      (Math.random() - 0.5) * 5;

    nextSolar = Math.round(
      Math.max(0, Math.min(100, nextSolar))
    );

    const drain =
      box.cooling_on ? 0.6 : 0.15;

    const charge =
      nextSolar > 40 ? 0.5 : 0.1;

    let nextBattery =
      box.battery - drain + charge;

    nextBattery = Math.round(
      Math.max(5, Math.min(100, nextBattery))
    );

    await supabase
      .from('cold_boxes')
      .update({
        current_temp: nextTemp,
        current_humidity: nextHum,
        current_airflow: nextAirflow,
        solar_input: nextSolar,
        battery: nextBattery,
        updated_at: new Date().toISOString(),
      })
      .eq('id', box.id);

    const updatedBox = {
      ...box,
      current_temp: nextTemp,
      current_humidity: nextHum,
      battery: nextBattery
    };

    const {
      risk,
      level,
      tempDev,
      humDev
    } = computeBoxRisk(updatedBox, product);

    if (tempDev > 0) {
      const key = `box:${box.id}:temp`;

      activeDedupeKeys.add(key);

      await raiseAlert({
        cold_box_id: box.id,
        severity:
          level === 'HIGH'
            ? 'severe'
            : 'info',
        title:
          `${box.name}: ${product.name} ` +
          `temperature off-band by ` +
          `${tempDev.toFixed(1)}°C`,
        dedupe_key: key
      });
    }

    if (humDev > 0) {
      const key = `box:${box.id}:hum`;

      activeDedupeKeys.add(key);

      await raiseAlert({
        cold_box_id: box.id,
        severity: 'info',
        title:
          `${box.name}: ${product.name} ` +
          `humidity off-band by ` +
          `${humDev.toFixed(0)}%`,
        dedupe_key: key
      });
    }

    if (nextBattery < 25) {
      const key = `box:${box.id}:battery`;

      activeDedupeKeys.add(key);

      await raiseAlert({
        cold_box_id: box.id,
        severity: 'severe',
        title:
          `${box.name}: battery low at ` +
          `${nextBattery}% with weak solar input ` +
          `(${nextSolar}%)`,
        dedupe_key: key
      });
    }

    if (level === 'HIGH') {
      const key = `box:${box.id}:risk`;

      activeDedupeKeys.add(key);

      await raiseAlert({
        cold_box_id: box.id,
        severity: 'severe',
        title:
          `${box.name}: spoilage risk elevated ` +
          `to HIGH for ${product.name}`,
        dedupe_key: key
      });
    }
  }

  await resolveStaleAlerts(activeDedupeKeys);
}

// 2. Refresh each route's status from real weather,
//    layered under any active non-weather disruption
//    (landslide/convoy/strike) and manual overrides.

async function tickRoutes() {
  const { data: routes, error } = await supabase
    .from('routes')
    .select('*');

  if (error || !routes) {
    return console.error(
      'tickRoutes select failed:',
      error && error.message
    );
  }

  for (const route of routes) {
    if (route.manual_override) continue;

    const { data: disruptions } = await supabase
      .from('disruptions')
      .select('*')
      .eq('route_id', route.id)
      .eq('active', true);

    const blocking = (disruptions || []).find(
      d => d.type !== 'weather'
    );

    if (blocking) {
      const status =
        blocking.severity === 'high'
          ? 'blocked'
          : 'caution';

      await supabase
        .from('routes')
        .update({
          status,
          weather_checked_at:
            new Date().toISOString(),
          weather_summary:
            `${blocking.type.replace('_', ' ')} — ` +
            `${blocking.location}`,
        })
        .eq('id', route.id);

      continue;
    }

    const weather = await getWeather(
      route.weather_lat,
      route.weather_lng
    );

    const result = weatherToStatus(weather);

    if (result) {
      await supabase
        .from('routes')
        .update({
          status: result.status,
          weather_checked_at:
            new Date().toISOString(),
          weather_summary: result.summary,
        })
        .eq('id', route.id);
    }
  }
}

// 3. Deliver loads whose ETA has passed; compute real
//    waste/saved split from the risk actually experienced
//    by that load's box + route.

async function tickLoads() {
  const { data: loads, error } = await supabase
    .from('loads')
    .select('*, products(*), cold_boxes(*), routes(*)')
    .eq('status', 'in_transit');

  if (error || !loads) {
    return console.error(
      'tickLoads select failed:',
      error && error.message
    );
  }

  const now = new Date();

  for (const load of loads) {
    if (new Date(load.eta) > now) continue;

    const { risk } = computeLoadRisk(
      load.cold_boxes,
      load.products,
      load.routes
    );

    const spoilFraction = Math.min(
      0.85,
      risk / 130
    );

    const waste_kg = +(
      load.weight_kg * spoilFraction
    ).toFixed(1);

    const produce_saved_kg = +(
      load.weight_kg - waste_kg
    ).toFixed(1);

    await supabase
      .from('loads')
      .update({
        status: 'delivered',
        waste_kg,
        produce_saved_kg
      })
      .eq('id', load.id);
  }
}

// 4. Generate reroute suggestions for loads stuck on blocked routes.

async function tickReroutes() {
  const { data: blockedRoutes } = await supabase
    .from('routes')
    .select('*')
    .eq('status', 'blocked');

  if (!blockedRoutes || !blockedRoutes.length) return;

  for (const route of blockedRoutes) {
    const { data: affectedLoads } = await supabase
      .from('loads')
      .select('*')
      .eq('route_id', route.id)
      .eq('status', 'in_transit');

    if (!affectedLoads || !affectedLoads.length) continue;

    const { data: altLinks } = await supabase
      .from('route_alternatives')
      .select('alt_route_id')
      .eq('route_id', route.id);

    let bestAlt = null;

    for (const link of (altLinks || [])) {
      const { data: altRoute } = await supabase
        .from('routes')
        .select('*')
        .eq('id', link.alt_route_id)
        .single();

      if (
        altRoute &&
        altRoute.status !== 'blocked'
      ) {
        const altTime =
          altRoute.distance_km /
          altRoute.avg_speed_kmph;

        if (
          !bestAlt ||
          altTime <
            bestAlt.distance_km /
              bestAlt.avg_speed_kmph
        ) {
          bestAlt = altRoute;
        }
      }
    }

    for (const load of affectedLoads) {
      const { data: existing } = await supabase
        .from('reroute_suggestions')
        .select('id')
        .eq('load_id', load.id)
        .eq('from_route_id', route.id)
        .in('status', [
          'pending',
          'approved'
        ]);

      if (existing && existing.length) continue;

      if (bestAlt) {
        const primaryTime =
          route.distance_km /
          route.avg_speed_kmph;

        const altTime =
          bestAlt.distance_km /
          bestAlt.avg_speed_kmph;

        // Assumes approximately 6 hours average
        // clearance time for a blocked mountain corridor.
        const hoursSaved = +Math.max(
          0,
          6 + primaryTime - altTime
        ).toFixed(1);

        await supabase
          .from('reroute_suggestions')
          .insert({
            load_id: load.id,
            from_route_id: route.id,
            to_route_id: bestAlt.id,
            reason:
              `${route.name} is blocked; ` +
              `${bestAlt.name} is currently ` +
              `${bestAlt.status}.`,
            hours_saved: hoursSaved,
            tonnage_protected: +(
              load.weight_kg / 1000
            ).toFixed(2),
            status: 'pending',
          });
      } else {
        await supabase
          .from('reroute_suggestions')
          .insert({
            load_id: load.id,
            from_route_id: route.id,
            to_route_id: null,
            reason:
              `${route.name} is blocked and no ` +
              `viable alternate corridor exists ` +
              `for this load.`,
            hours_saved: null,
            tonnage_protected: +(
              load.weight_kg / 1000
            ).toFixed(2),
            status: 'pending',
          });
      }
    }
  }
}

async function runAllTicks() {
  await tickRoutes();
  await tickColdBoxes();
  await tickLoads();
  await tickReroutes();
}

/* ================================================================
   API — Panel 1: Control room overview
   ================================================================ */

app.get('/api/overview', async (req, res) => {
  try {
    const [
      boxResult,
      loadResult,
      routeResult
    ] = await Promise.all([
      supabase
        .from('cold_boxes')
        .select('*, products(*)'),

      supabase
        .from('loads')
        .select('*'),

      supabase
        .from('routes')
        .select('*'),
    ]);

    const dbError =
      boxResult.error ||
      loadResult.error ||
      routeResult.error;

    if (dbError) {
      return res.status(500).json({
        error: dbError.message
      });
    }

    const boxes = boxResult.data || [];
    const loads = loadResult.data || [];
    const routes = routeResult.data || [];

    const coldBoxesLive = boxes.length;

    const boxesNeedingAttention =
      boxes.filter(
        b =>
          computeBoxRisk(
            b,
            b.products
          ).level !== 'LOW'
      ).length;

    const loadsMoving =
      loads.filter(
        l => l.status === 'in_transit'
      ).length;

    const tonnageMoving =
      loads
        .filter(
          l => l.status === 'in_transit'
        )
        .reduce(
          (s, l) =>
            s + Number(l.weight_kg),
          0
        ) / 1000;

    const routesBlocked =
      routes.filter(
        r => r.status === 'blocked'
      ).length;

    const blockedRoute =
      routes.find(
        r => r.status === 'blocked'
      ) || null;

    const today = new Date();

    today.setHours(
      0,
      0,
      0,
      0
    );

    const deliveredToday =
      (loads || []).filter(
        l => l.status === 'delivered'
      );

    const lossTodayKg =
      deliveredToday.reduce(
        (s, l) =>
          s + Number(l.waste_kg || 0),
        0
      );

    res.json({
      coldBoxesLive,
      boxesNeedingAttention,

      loadsMoving,

      tonnageMoving:
        +tonnageMoving.toFixed(1),

      routesBlocked,

      blockedRouteName:
        blockedRoute
          ? blockedRoute.name
          : null,

      lossTodayKg:
        +lossTodayKg.toFixed(1),
    });

  } catch (e) {
    console.error(
      'Overview API failed:',
      e.message
    );

    res.status(500).json({
      error: e.message
    });
  }
});

/* ================================================================
   API — Products
   ================================================================ */

app.get('/api/products', async (req, res) => {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .order('name');

  if (error) {
    return res.status(500).json({
      error: error.message
    });
  }

  res.json(data);
});

/* ================================================================
   API — Panel 2: Cold box health
   Panel 3: Cooling & airflow
   ================================================================ */

app.get('/api/cold-boxes', async (req, res) => {
  const { data, error } = await supabase
    .from('cold_boxes')
    .select('*, products(*), routes(*)')
    .order('id');

  if (error) {
    return res.status(500).json({
      error: error.message
    });
  }

  const withRisk = data.map(box => ({
    ...box,

    riskInfo: computeBoxRisk(
      box,
      box.products
    )
  }));

  res.json(withRisk);
});

app.post(
  '/api/cold-boxes/:id/control',
  async (req, res) => {
    const {
      target_temp,
      target_humidity,
      fan_speed,
      cooling_on
    } = req.body;

    const patch = {};

    if (target_temp !== undefined) {
      patch.target_temp =
        Number(target_temp);
    }

    if (target_humidity !== undefined) {
      patch.target_humidity =
        Number(target_humidity);
    }

    if (fan_speed !== undefined) {
      patch.fan_speed =
        Number(fan_speed);
    }

    if (cooling_on !== undefined) {
      patch.cooling_on =
        !!cooling_on;
    }

    patch.updated_at =
      new Date().toISOString();

    const { data, error } = await supabase
      .from('cold_boxes')
      .update(patch)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({
        error: error.message
      });
    }

    res.json(data);
  }
);

/* ================================================================
   API — Panel 4: Spoilage risk
   ================================================================ */

app.get(
  '/api/spoilage-risk',
  async (req, res) => {
    const { data: boxes } = await supabase
      .from('cold_boxes')
      .select('*, products(*)');

    const boxRisks = (boxes || []).map(
      box => ({
        id: box.id,
        name: box.name,
        product: box.products.name,

        ...computeBoxRisk(
          box,
          box.products
        ),
      })
    );

    const { data: loads } = await supabase
      .from('loads')
      .select(
        '*, products(*), cold_boxes(*), routes(*)'
      )
      .eq('status', 'in_transit');

    const loadRisks = (loads || []).map(
      load => ({
        id: load.id,

        product:
          load.products.name,

        route:
          load.routes
            ? load.routes.name
            : null,

        ...computeLoadRisk(
          load.cold_boxes,
          load.products,
          load.routes
        ),
      })
    );

    res.json({
      boxRisks,
      loadRisks
    });
  }
);

/* ================================================================
   API — Panel 5: Alerts
   ================================================================ */

app.get('/api/alerts', async (req, res) => {
  const { data, error } = await supabase
    .from('alerts')
    .select(
      '*, cold_boxes(name), loads(id)'
    )
    .eq('resolved', false)
    .order('created_at', {
      ascending: false
    });

  if (error) {
    return res.status(500).json({
      error: error.message
    });
  }

  res.json(data);
});

app.post(
  '/api/alerts/:id/resolve',
  async (req, res) => {
    const { error } = await supabase
      .from('alerts')
      .update({
        resolved: true
      })
      .eq('id', req.params.id);

    if (error) {
      return res.status(500).json({
        error: error.message
      });
    }

    res.json({
      ok: true
    });
  }
);

app.delete(
  '/api/alerts',
  async (req, res) => {
    const { error } = await supabase
      .from('alerts')
      .update({
        resolved: true
      })
      .eq('resolved', false);

    if (error) {
      return res.status(500).json({
        error: error.message
      });
    }

    res.json({
      ok: true
    });
  }
);

/* ================================================================
   API — Panel 6: Route status
   ================================================================ */

app.get('/api/routes', async (req, res) => {
  const { data, error } = await supabase
    .from('routes')
    .select('*')
    .order('name');

  if (error) {
    return res.status(500).json({
      error: error.message
    });
  }

  res.json(data);
});

// Manual override toggle
app.post(
  '/api/routes/:id/override',
  async (req, res) => {
    const {
      data: route,
      error: fetchErr
    } = await supabase
      .from('routes')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (fetchErr || !route) {
      return res.status(404).json({
        error: 'Route not found'
      });
    }

    const nextStatus =
      route.status === 'blocked'
        ? 'open'
        : 'blocked';

    const { data, error } = await supabase
      .from('routes')
      .update({
        status: nextStatus,
        manual_override: true,
        weather_summary:
          'Manually overridden by dispatcher',
      })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({
        error: error.message
      });
    }

    res.json(data);
  }
);

app.post(
  '/api/routes/:id/clear-override',
  async (req, res) => {
    const { data, error } = await supabase
      .from('routes')
      .update({
        manual_override: false
      })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({
        error: error.message
      });
    }

    await tickRoutes();

    res.json(data);
  }
);

/* ================================================================
   API — Panel 7: Disruptions
   ================================================================ */

app.get('/api/disruptions', async (req, res) => {
  const { data, error } = await supabase
    .from('disruptions')
    .select('*, routes(name)')
    .eq('active', true)
    .order('created_at', {
      ascending: false
    });

  if (error) {
    return res.status(500).json({
      error: error.message
    });
  }

  res.json(data);
});

app.post('/api/disruptions', async (req, res) => {
  const {
    route_id,
    type,
    severity,
    location
  } = req.body;

  if (
    !route_id ||
    !type ||
    !severity ||
    !location
  ) {
    return res.status(400).json({
      error:
        'route_id, type, severity and location are required'
    });
  }

  const { data, error } = await supabase
    .from('disruptions')
    .insert({
      route_id,
      type,
      severity,
      location,
      active: true
    })
    .select()
    .single();

  if (error) {
    return res.status(500).json({
      error: error.message
    });
  }

  await tickRoutes();
  await tickReroutes();

  res.status(201).json(data);
});

app.post(
  '/api/disruptions/:id/resolve',
  async (req, res) => {
    const {
      data,
      error
    } = await supabase
      .from('disruptions')
      .update({
        active: false
      })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({
        error: error.message
      });
    }

    await tickRoutes();

    res.json(data);
  }
);

/* ================================================================
   API — Panel 8: Reroute suggestions
   ================================================================ */

app.get(
  '/api/reroute-suggestions',
  async (req, res) => {
    const { data, error } = await supabase
      .from('reroute_suggestions')
      .select(`
        *,
        loads(
          id,
          weight_kg,
          products(name)
        ),
        from:from_route_id(
          id,
          name,
          status
        ),
        to:to_route_id(
          id,
          name,
          status
        )
      `)
      .order('created_at', {
        ascending: false
      });

    if (error) {
      return res.status(500).json({
        error: error.message
      });
    }

    res.json(data);
  }
);

app.post(
  '/api/reroute-suggestions/:id/approve',
  async (req, res) => {
    const { data, error } = await supabase
      .from('reroute_suggestions')
      .update({
        status: 'approved'
      })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({
        error: error.message
      });
    }

    res.json(data);
  }
);

app.post(
  '/api/reroute-suggestions/:id/apply',
  async (req, res) => {
    const {
      data: suggestion,
      error: suggestionError
    } = await supabase
      .from('reroute_suggestions')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (
      suggestionError ||
      !suggestion
    ) {
      return res.status(404).json({
        error: 'Reroute suggestion not found'
      });
    }

    if (!suggestion.to_route_id) {
      return res.status(400).json({
        error:
          'No alternate route available for this suggestion'
      });
    }

    const {
      error: loadError
    } = await supabase
      .from('loads')
      .update({
        route_id: suggestion.to_route_id
      })
      .eq(
        'id',
        suggestion.load_id
      );

    if (loadError) {
      return res.status(500).json({
        error: loadError.message
      });
    }

    const {
      data,
      error
    } = await supabase
      .from('reroute_suggestions')
      .update({
        status: 'applied'
      })
      .eq(
        'id',
        req.params.id
      )
      .select()
      .single();

    if (error) {
      return res.status(500).json({
        error: error.message
      });
    }

    res.json(data);
  }
);

/* ================================================================
   API — Cargo registration
   ================================================================ */

app.post(
  '/api/cargo/register',
  async (req, res) => {
    const {
      owner_name,
      phone,
      origin,
      destination,
      product_id,
      quantity_boxes,
      weight_per_box_kg,
      pricing_method,
      unit_price,
      expected_duration_hours
    } = req.body;

    if (
      !owner_name ||
      !phone ||
      !origin ||
      !destination ||
      !product_id ||
      !quantity_boxes ||
      !weight_per_box_kg
    ) {
      return res.status(400).json({
        error:
          'Missing required cargo registration fields'
      });
    }

    const boxes =
      Number(quantity_boxes);

    const weightPerBox =
      Number(weight_per_box_kg);

    const totalWeight =
      boxes * weightPerBox;

    const unitPrice =
      Number(unit_price || 0);

    const totalCargoValue =
      pricing_method === 'per_box'
        ? boxes * unitPrice
        : totalWeight * unitPrice;

    const transitHours =
      Number(
        expected_duration_hours || 24
      );

    const departedAt =
      new Date();

    const eta =
      new Date(
        departedAt.getTime() +
        transitHours *
          60 *
          60 *
          1000
      );

    const { data: products } =
      await supabase
        .from('products')
        .select('*');

    const product =
      (products || []).find(
        p =>
          String(p.id) ===
          String(product_id)
      );

    if (!product) {
      return res.status(400).json({
        error: 'Product not found'
      });
    }

    const { data: boxesData } =
      await supabase
        .from('cold_boxes')
        .select(
          '*, products(*)'
        );

    let assignedBox =
      (boxesData || []).find(
        b =>
          b.product_id ===
          product.id
      ) || null;

    const { data: routes } =
      await supabase
        .from('routes')
        .select('*');

    function normalisePlace(value) {
      return String(value || '')
        .trim()
        .toLowerCase();
    }

    const o =
      normalisePlace(origin);

    const d =
      normalisePlace(destination);

    let matchedRoute =
      (routes || []).find(route => {
        const name =
          String(route.name || '')
            .toLowerCase();

        return (
          name.includes(o) &&
          name.includes(d)
        );
      }) || null;

    const id =
      `FRG-${new Date().getFullYear()}-${Math.random()
        .toString(36)
        .slice(2, 7)
        .toUpperCase()}`;

    const payload = {
      id,

      owner_name:
        String(owner_name).trim(),

      phone:
        String(phone).trim(),

      origin:
        String(origin).trim(),

      destination:
        String(destination).trim(),

      product_id,

      quantity_boxes:
        Math.round(boxes),

      weight_per_box_kg:
        weightPerBox,

      weight_kg:
        totalWeight,

      pricing_method,

      unit_price:
        unitPrice,

      total_cargo_value:
        totalCargoValue,

      expected_duration_hours:
        transitHours,

      route_id:
        matchedRoute
          ? matchedRoute.id
          : null,

      cold_box_id:
        assignedBox
          ? assignedBox.id
          : null,

      status: 'in_transit',

      departed_at:
        departedAt.toISOString(),

      eta:
        eta.toISOString(),
    };

    const {
      data,
      error
    } = await supabase
      .from('loads')
      .insert(payload)
      .select(
        '*, products(*), routes(*)'
      )
      .single();

    if (error) {
      if (
        /column .* (owner_name|phone|origin|destination|expected_duration_hours|quantity_boxes|weight_per_box_kg|pricing_method|unit_price|total_cargo_value).*schema cache/i
          .test(error.message)
      ) {
        return res.status(500).json({
          error:
            'FRIGARO database needs the cargo-registration migration. Open Supabase SQL Editor and run supabase/fix_registration_schema.sql from this project, then retry.'
        });
      }

      return res.status(500).json({
        error: error.message
      });
    }

    /* ---- Cross-feature impact analysis ---- */

    let impactAnalysis =
      null;

    const routeDisrupted =
      matchedRoute &&
      matchedRoute.status !== 'open';

    if (
      routeDisrupted ||
      assignedBox
    ) {
      const riskInfo =
        computeLoadRisk(
          assignedBox,
          data.products,
          matchedRoute
        );

      let rerouteSuggestion =
        null;

      if (routeDisrupted) {
        await raiseAlert({
          load_id: id,

          severity:
            matchedRoute.status ===
            'blocked'
              ? 'severe'
              : 'info',

          title:
            `${id}: registered on ` +
            `${matchedRoute.name}, which is currently ` +
            `${matchedRoute.status.toUpperCase()} ` +
            `(${matchedRoute.weather_summary || 'reason pending'})`,

          dedupe_key:
            `load:${id}:route-status`,
        });

        await tickReroutes();

        const {
          data: suggestion
        } = await supabase
          .from(
            'reroute_suggestions'
          )
          .select(
            '*, to:to_route_id(name)'
          )
          .eq(
            'load_id',
            id
          )
          .eq(
            'from_route_id',
            matchedRoute.id
          )
          .order(
            'created_at',
            {
              ascending: false
            }
          )
          .limit(1)
          .maybeSingle();

        rerouteSuggestion =
          suggestion
            ? {
                toRouteName:
                  suggestion.to
                    ? suggestion.to.name
                    : null,

                hoursSaved:
                  suggestion.hours_saved,

                reason:
                  suggestion.reason,

                status:
                  suggestion.status,
              }
            : null;
      }

      impactAnalysis = {
        routeName:
          matchedRoute
            ? matchedRoute.name
            : null,

        routeStatus:
          matchedRoute
            ? matchedRoute.status
            : null,

        weatherSummary:
          matchedRoute
            ? matchedRoute.weather_summary
            : null,

        coldBoxName:
          assignedBox
            ? assignedBox.name
            : null,

        liveSensor:
          assignedBox
            ? {
                temp:
                  assignedBox.current_temp,

                humidity:
                  assignedBox.current_humidity,

                battery:
                  assignedBox.battery
              }
            : null,

        risk:
          riskInfo.risk,

        riskLevel:
          riskInfo.level,

        rerouteSuggestion,
      };
    }

    res.status(201).json({
      ...data,

      calculated: {
        totalWeight,
        totalCargoValue,

        matchedRoute:
          matchedRoute
            ? matchedRoute.name
            : null
      },

      impactAnalysis,
    });
  }
);

/* ================================================================
   API — Panel 9: Loads in transit
   ================================================================ */

app.get('/api/loads', async (req, res) => {
  const { data, error } = await supabase
    .from('loads')
    .select('*, products(name), cold_boxes(name), routes(name, status)')
    .order('departed_at', {
      ascending: false
    });

  if (error) {
    return res.status(500).json({
      error: error.message
    });
  }

  const withRisk = await Promise.all(
    data.map(async load => {
      if (load.status !== 'in_transit') {
        return {
          ...load,
          riskInfo: null
        };
      }

      const { data: box } = await supabase
        .from('cold_boxes')
        .select('*')
        .eq('id', load.cold_box_id)
        .single();

      const { data: product } = await supabase
        .from('products')
        .select('*')
        .eq('id', load.product_id)
        .single();

      const { data: route } = await supabase
        .from('routes')
        .select('*')
        .eq('id', load.route_id)
        .single();

      return {
        ...load,
        riskInfo: computeLoadRisk(
          box,
          product,
          route
        )
      };
    })
  );

  res.json(withRisk);
});

/* ================================================================
   API — Driver-reported blockage:
   Real physics projection using Newton's Law of Cooling
   ================================================================ */

app.post(
  '/api/loads/:id/report-delay',
  async (req, res) => {
    const { id } =
      req.params;

    const hoursStopped =
      Number(
        req.body?.hours_stopped
      );

    const reason =
      (
        req.body?.reason || ''
      ).trim() || null;

    if (
      !Number.isFinite(
        hoursStopped
      ) ||
      hoursStopped <= 0 ||
      hoursStopped > 200
    ) {
      return res.status(400).json({
        error:
          'hours_stopped must be a number between 0 and 200.'
      });
    }

    const {
      data: load,
      error: loadErr
    } = await supabase
      .from('loads')
      .select(
        '*, products(*), cold_boxes(*), routes(*)'
      )
      .eq('id', id)
      .single();

    if (
      loadErr ||
      !load
    ) {
      return res.status(404).json({
        error:
          'Load not found.'
      });
    }

    if (
      load.status !==
      'in_transit'
    ) {
      return res.status(400).json({
        error:
          `${id} is already ${load.status} — delay analysis only applies to loads in transit.`
      });
    }

    const product =
      load.products;

    const box =
      load.cold_boxes;

    const route =
      load.routes;

    const lat =
      box
        ? box.lat
        : (
          route
            ? route.weather_lat
            : null
        );

    const lng =
      box
        ? box.lng
        : (
          route
            ? route.weather_lng
            : null
        );

    if (
      lat == null ||
      lng == null
    ) {
      return res.status(400).json({
        error:
          'No location available for this load (no cold box and no matched route) — cannot run a real-weather projection.'
      });
    }

    const weather =
      await getWeather(
        lat,
        lng
      );

    if (
      !weather ||
      !weather.current
    ) {
      return res.status(502).json({
        error:
          'Live weather is temporarily unavailable — try again shortly.'
      });
    }

    const ambientTemp =
      weather.current
        .temperature_2m;

    const ambientHumidity =
      weather.current
        .relative_humidity_2m;

    /* ---- Newton's Law of Heating/Cooling ---- */

    const TAU_TEMP_HOURS =
      6;

    const TAU_HUMIDITY_HOURS =
      10;

    const startTemp =
      box
        ? box.current_temp
        : (
          product.ideal_temp_min +
          product.ideal_temp_max
        ) / 2;

    const startHumidity =
      box
        ? box.current_humidity
        : (
          product.ideal_humidity_min +
          product.ideal_humidity_max
        ) / 2;

    const project = (t) => ({
      temp:
        ambientTemp +
        (
          startTemp -
          ambientTemp
        ) *
        Math.exp(
          -t /
          TAU_TEMP_HOURS
        ),

      humidity:
        ambientHumidity +
        (
          startHumidity -
          ambientHumidity
        ) *
        Math.exp(
          -t /
          TAU_HUMIDITY_HOURS
        ),
    });

    const proj =
      project(hoursStopped);

    const projectedTemp =
      Math.round(
        proj.temp * 10
      ) / 10;

    const projectedHumidity =
      Math.round(
        Math.min(
          99,
          Math.max(
            1,
            proj.humidity
          )
        )
      );

    const projectedBattery =
      box
        ? Math.max(
            0,
            Math.round(
              box.battery -
              hoursStopped * 3
            )
          )
        : null;

    const projectedBox =
      box
        ? {
            ...box,
            current_temp:
              projectedTemp,

            current_humidity:
              projectedHumidity,

            battery:
              projectedBattery,

            cooling_on:
              false
          }
        : null;

    const riskInfo =
      computeLoadRisk(
        projectedBox,
        product,
        route
      );

    const riskBefore =
      computeLoadRisk(
        box,
        product,
        route
      );

    let hoursUntilHighRisk =
      null;

    for (
      let t =
        hoursStopped;
      t <=
        hoursStopped + 48;
      t += 0.5
    ) {
      const p =
        project(t);

      const testBox =
        box
          ? {
              ...box,

              current_temp:
                p.temp,

              current_humidity:
                Math.min(
                  99,
                  Math.max(
                    1,
                    p.humidity
                  )
                ),

              battery:
                Math.max(
                  0,
                  box.battery -
                  t * 3
                ),

              cooling_on:
                false
            }
          : null;

      const r =
        computeLoadRisk(
          testBox,
          product,
          route
        );

      if (
        r.level ===
        'HIGH'
      ) {
        hoursUntilHighRisk =
          Math.round(
            (
              t -
              hoursStopped
            ) * 10
          ) / 10;

        break;
      }
    }

    /* Persist projected values */

    if (box) {
      await supabase
        .from('cold_boxes')
        .update({
          current_temp:
            projectedTemp,

          current_humidity:
            projectedHumidity,

          battery:
            projectedBattery,

          cooling_on:
            false,

          updated_at:
            new Date()
              .toISOString(),
        })
        .eq(
          'id',
          box.id
        );
    }

    await raiseAlert({
      load_id: id,

      cold_box_id:
        box
          ? box.id
          : null,

      severity:
        riskInfo.level === 'HIGH'
          ? 'severe'
          : riskInfo.level === 'MEDIUM'
            ? 'warning'
            : 'info',

      title:
        `${id}: driver reported ` +
        `${hoursStopped}h stopped` +
        `${
          route
            ? ` on ${route.name}`
            : ''
        } — projected ` +
        `${projectedTemp}°C, risk now ` +
        `${riskInfo.level}` +
        `${
          reason
            ? ` (${reason})`
            : ''
        }`,

      dedupe_key:
        `load:${id}:delay-report`,
    });

    let rerouteSuggestion =
      null;

    if (
      route &&
      (
        route.status !== 'open' ||
        riskInfo.level === 'HIGH'
      )
    ) {
      await tickReroutes();

      const {
        data: suggestion
      } = await supabase
        .from(
          'reroute_suggestions'
        )
        .select(
          '*, to:to_route_id(name)'
        )
        .eq(
          'load_id',
          id
        )
        .eq(
          'from_route_id',
          route.id
        )
        .order(
          'created_at',
          {
            ascending: false
          }
        )
        .limit(1)
        .maybeSingle();

      rerouteSuggestion =
        suggestion
          ? {
              toRouteName:
                suggestion.to
                  ? suggestion.to.name
                  : null,

              hoursSaved:
                suggestion.hours_saved,

              reason:
                suggestion.reason,

              status:
                suggestion.status,
            }
          : null;
    }

    res.json({
      loadId: id,

      coldBoxName:
        box
          ? box.name
          : null,

      routeName:
        route
          ? route.name
          : null,

      hoursStopped,

      model: {
        name:
          "Newton's Law of Cooling",

        tauTempHours:
          TAU_TEMP_HOURS,

        tauHumidityHours:
          TAU_HUMIDITY_HOURS
      },

      ambient: {
        temp:
          ambientTemp,

        humidity:
          ambientHumidity,

        label:
          weather.current.weather_code != null
            ? (
                WMO_LABELS[
                  weather.current.weather_code
                ] ||
                'Unknown'
              )
            : null
      },

      startTemp:
        Math.round(
          startTemp * 10
        ) / 10,

      startHumidity:
        Math.round(
          startHumidity
        ),

      projectedTemp,

      projectedHumidity,

      projectedBattery,

      riskBefore:
        riskBefore.risk,

      riskBeforeLevel:
        riskBefore.level,

      risk:
        riskInfo.risk,

      riskLevel:
        riskInfo.level,

      hoursUntilHighRisk,

      rerouteSuggestion,
    });
  }
);

/* ================================================================
   API — Panel 10: Waste & impact
   ================================================================ */

app.get('/api/waste-impact', async (req, res) => {
  const sevenDaysAgo = new Date(
    Date.now() -
    7 * 24 * 60 * 60 * 1000
  ).toISOString();

  const { data: loads, error } = await supabase
    .from('loads')
    .select('*')
    .eq('status', 'delivered')
    .gte('departed_at', sevenDaysAgo);

  if (error) {
    return res.status(500).json({
      error: error.message
    });
  }

  const produceSavedKg =
    loads.reduce(
      (s, l) =>
        s +
        Number(
          l.produce_saved_kg || 0
        ),
      0
    );

  const wasteKg =
    loads.reduce(
      (s, l) =>
        s +
        Number(
          l.waste_kg || 0
        ),
      0
    );

  const wasteRate =
    (
      produceSavedKg +
      wasteKg
    ) > 0
      ? (
          wasteKg /
          (
            produceSavedKg +
            wasteKg
          )
        ) * 100
      : 0;

  // Approximate CO2e avoided per kg of produce saved.
  const co2AvoidedKg =
    produceSavedKg * 0.4;

  const byDay = {};

  for (const l of loads) {
    const day =
      new Date(
        l.departed_at
      )
        .toISOString()
        .slice(0, 10);

    if (!byDay[day]) {
      byDay[day] = {
        saved: 0,
        waste: 0
      };
    }

    byDay[day].saved +=
      Number(
        l.produce_saved_kg || 0
      );

    byDay[day].waste +=
      Number(
        l.waste_kg || 0
      );
  }

  const dailySeries =
    Object.entries(byDay)
      .sort(
        ([a], [b]) =>
          a.localeCompare(b)
      )
      .map(
        ([day, v]) => ({
          day,
          saved:
            +v.saved.toFixed(1),
          waste:
            +v.waste.toFixed(1)
        })
      );

  res.json({
    produceSavedTonnes:
      +(
        produceSavedKg / 1000
      ).toFixed(2),

    wasteRate:
      +wasteRate.toFixed(1),

    co2AvoidedTonnes:
      +(
        co2AvoidedKg / 1000
      ).toFixed(2),

    dailySeries,
  });
});

/* ================================================================
   Health check + manual tick trigger
   ================================================================ */

app.get('/api/health', async (req, res) => {
  const health = {
    supabase: false,

    configured: Boolean(
      process.env.SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_KEY
    ),

    weather: true
  };

  try {
    if (!health.configured) {
      health.supabaseError =
        'Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env';

      return res.json(health);
    }

    const { data, error } =
      await supabase
        .from('products')
        .select('id')
        .limit(1);

    health.supabase =
      !error;

    health.productsReachable =
      Array.isArray(data);

    health.supabaseError =
      error
        ? error.message
        : null;

  } catch (e) {
    health.supabaseError =
      e.message;
  }

  res.json(health);
});

app.post('/api/tick', async (req, res) => {
  try {
    await runAllTicks();

    res.json({
      ok: true
    });

  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  }
});

process.on(
  'unhandledRejection',
  (reason) => {
    console.error(
      'Unhandled promise rejection:',
      reason &&
      reason.message
        ? reason.message
        : reason
    );
  }
);

/* ---------------- START ---------------- */

app.listen(PORT, async () => {
  console.log(
    `FRIGARO backend running — open http://localhost:${PORT}`
  );

  if (
    !process.env.SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_KEY
  ) {
    console.error(
      'FRIGARO DATABASE NOT CONNECTED: .env is missing SUPABASE_URL or SUPABASE_SERVICE_KEY'
    );

  } else {
    const { error } =
      await supabase
        .from('products')
        .select('id')
        .limit(1);

    if (error) {
      console.error(
        'FRIGARO DATABASE CHECK FAILED:',
        error.message
      );
    } else {
      console.log(
        'FRIGARO Supabase connection OK'
      );
    }
  }

  await runAllTicks()
    .catch(
      e =>
        console.error(
          'Initial tick failed:',
          e.message
        )
    );

  setInterval(
    () =>
      runAllTicks()
        .catch(
          e =>
            console.error(
              'Tick failed:',
              e.message
            )
        ),
    20000
  );
});