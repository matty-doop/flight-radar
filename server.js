// Local flight tracker server. No dependencies, no API keys.
// Live positions: adsb.fi (fallback adsb.lol) - community ADS-B feeds, free and open.
// Routes/airports: adsb.lol's public copy of the VRS standing-data set.
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const crypto = require('crypto');

const PORT = process.env.PORT || 8642;
// Set APP_PASSWORD on the host to require a password (any username) to open the page.
const PASSWORD = process.env.APP_PASSWORD || '';
// Only accept connections from other machines on the cloud host (Render sets RENDER) or
// when a password has been set. On your own PC it answers this computer only.
const HOST = process.env.HOST || (process.env.RENDER || PASSWORD ? '0.0.0.0' : '127.0.0.1');
function authorized(req) {
  if (!PASSWORD) return true;
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const given = Buffer.from(m[1], 'base64').toString('utf8').split(':').slice(1).join(':');
  const a = crypto.createHash('sha256').update(given).digest(), b = crypto.createHash('sha256').update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}
const PUBLIC = path.join(__dirname, 'public');
// Where downloaded lookup files are kept. The packaged desktop app points this at a writable per-user folder.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const CACHE_FILE = path.join(DATA_DIR, 'routes-cache.json');
const STANDING = 'https://vrs-standing-data.adsb.lol';
const UA = { 'User-Agent': 'local-flight-tracker/1.0' };

const DAY = 86400e3;
const ROUTE_TTL = 7 * DAY;   // known routes
const MISS_TTL = 1 * DAY;    // callsigns with no known route

// ---------- route cache (memory + disk) ----------
let routeCache = {};
try { routeCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch {}
let saveTimer = null;
function saveCacheSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(CACHE_FILE, JSON.stringify(routeCache), () => {});
  }, 5000);
}

// Weather radar frame list from RainViewer (free, no key). Cached for 2 minutes.
let radarCache = { t: 0, data: null };
async function getRadar() {
  if (radarCache.data && Date.now() - radarCache.t < 120e3) return radarCache.data;
  const j = await getJson('https://api.rainviewer.com/public/weather-maps.json');
  const past = (j.radar && j.radar.past) || [];
  const last = past[past.length - 1];
  if (!last || !/^\/v2\/radar\/\w+$/.test(last.path) || !/^https:\/\/[\w.-]+\.rainviewer\.com$/.test(j.host)) throw new Error('no radar frames');
  radarCache = { t: Date.now(), data: { host: j.host, path: last.path, time: last.time } };
  return radarCache.data;
}

async function getJson(url, timeoutMs = 12000) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 404) return null;
  if (!res.ok) {
    const err = new Error(`${res.status} from ${new URL(url).host}`);
    err.status = res.status; err.headers = res.headers;
    throw err;
  }
  return res.json();
}

// ---------- live data sources ----------
// adsb.fi asks for no more than one request a second. adsb.lol now allows only 500 requests
// a day without a key, so it is the backup. A source that says "too many requests" is left
// alone until it says it will accept requests again.
const LIVE = [
  { name: 'adsb.fi', gap: 1100, nextAt: 0, blockedUntil: 0, backoff: 0, lastError: null,
    point: (lat, lon, d) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${d}`,
    callsign: list => `https://opendata.adsb.fi/api/v2/callsign/${list}` },
  { name: 'adsb.lol', gap: 1100, nextAt: 0, blockedUntil: 0, backoff: 0, lastError: null,
    point: (lat, lon, d) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${d}`,
    callsign: list => `https://api.adsb.lol/v2/callsign/${list}` },
];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function liveFetch(kind, ...args) {
  let lastErr = null;
  for (const src of LIVE) {
    if (Date.now() < src.blockedUntil) continue;
    const wait = Math.max(0, src.nextAt - Date.now());
    src.nextAt = Math.max(src.nextAt, Date.now()) + src.gap;
    if (wait > 8000) continue; // too busy right now; try the other source
    if (wait) await sleep(wait);
    try {
      const j = await getJson(src[kind](...args));
      src.backoff = 0;
      return { source: src.name, j: j || {} };
    } catch (e) {
      lastErr = e;
      src.lastError = { at: new Date().toISOString(), msg: String(e.message || e) };
      if (e.status === 429) {
        // rest it for as long as it asks; if it doesn't say, start short and double each time
        const h = e.headers;
        src.backoff = Math.min(Math.max(src.backoff * 2, 10), 120);
        const secs = Number(h && (h.get('retry-after') || h.get('x-ratelimit-reset'))) || src.backoff;
        src.blockedUntil = Date.now() + Math.min(secs, 86400) * 1000;
        console.log(`${src.name} says too many requests; resting it for ${Math.round(Math.min(secs, 86400))} s`);
      } else {
        src.blockedUntil = Date.now() + 3e3; // a hiccup (timeout, server error): try again shortly
      }
    }
  }
  if (!lastErr) throw new Error('both live data sources are resting after too many requests; retrying shortly');
  throw lastErr;
}

const slimAirport = a => a && ({
  icao: a.icao, iata: a.iata, name: a.name, location: a.location,
  lat: a.lat, lon: a.lon, elev: a.alt_feet || 0,
});

async function lookupRoute(cs) {
  const hit = routeCache[cs];
  if (hit && Date.now() - hit.t < (hit.r ? ROUTE_TTL : MISS_TTL)) return hit.r;
  let r = null;
  try {
    const j = await getJson(`${STANDING}/routes/${cs.slice(0, 2)}/${cs}.json`);
    if (j && j.airport_codes) {
      r = { codes: j.airport_codes.split('-'), airports: (j._airports || []).map(slimAirport) };
    }
  } catch {
    return hit ? hit.r : undefined; // network trouble: don't cache, retry later
  }
  routeCache[cs] = { t: Date.now(), r };
  saveCacheSoon();
  return r;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const n = i++; out[n] = await fn(items[n]); }
  }));
  return out;
}

// ---------- live aircraft ----------
const acCache = new Map(); // key -> {t, body}
async function getAircraft(lat, lon, dist) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)},${dist}`;
  const hit = acCache.get(key);
  if (hit && Date.now() - hit.t < 2500) return hit.body;
  const { source, j } = await liveFetch('point', lat, lon, dist);
  const body = { source, now: j.now, ac: j.aircraft || j.ac || [] };
  acCache.set(key, { t: Date.now(), body });
  if (acCache.size > 50) acCache.delete(acCache.keys().next().value);
  return body;
}

// ---------- airports (OurAirports public-domain list, downloaded once) ----------
const AIRPORTS_FILE = path.join(DATA_DIR, 'airports.csv');
const AIRPORTS_URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv';
let airportsPromise = null;
function parseCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
function loadAirports() {
  return airportsPromise ||= (async () => {
    let text;
    try {
      const st = fs.statSync(AIRPORTS_FILE);
      if (Date.now() - st.mtimeMs > 90 * DAY) throw new Error('stale');
      text = fs.readFileSync(AIRPORTS_FILE, 'utf8');
    } catch {
      try {
        const res = await fetch(AIRPORTS_URL, { headers: UA, signal: AbortSignal.timeout(60000) });
        if (!res.ok) throw new Error(`airport list download failed (${res.status})`);
        text = await res.text();
        fs.writeFile(AIRPORTS_FILE, text, () => {}); // cache is optional (cloud disks may be read-only)
      } catch (e) {
        if (!fs.existsSync(AIRPORTS_FILE)) throw e;
        text = fs.readFileSync(AIRPORTS_FILE, 'utf8'); // stale copy beats none
      }
    }
    const lines = text.split(/\r?\n/);
    const H = parseCsvLine(lines[0]), col = n => H.indexOf(n);
    const [iId, iType, iName, iLat, iLon, iEl, iCity, iIcao, iIata, iGps, iLocal] =
      ['ident', 'type', 'name', 'latitude_deg', 'longitude_deg', 'elevation_ft', 'municipality', 'icao_code', 'iata_code', 'gps_code', 'local_code'].map(col);
    const m = new Map();
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const f = parseCsvLine(lines[i]);
      if (f[iType] === 'closed' || !isFinite(+f[iLat])) continue;
      const a = { icao: f[iIcao] || f[iGps] || f[iId], iata: f[iIata], name: f[iName], location: f[iCity], lat: +f[iLat], lon: +f[iLon], elev: +f[iEl] || 0 };
      // ICAO-style codes win; IATA / local codes only fill gaps
      for (const k of [f[iIcao], f[iGps], f[iId]]) if (k) m.set(k.toUpperCase(), a);
      for (const k of [f[iIata], f[iLocal]]) if (k && !m.has(k.toUpperCase())) m.set(k.toUpperCase(), a);
    }
    return m;
  })().catch(e => { airportsPromise = null; throw e; });
}

// ---------- airline flights for an airport, worldwide, with takeoff times ----------
// The full callsign->route list tells us every airline callsign that serves an airport.
// We look those callsigns up wherever they are in the world and remember when each
// one leaves the ground, so the page can show takeoff time and an ETA.
const ROUTES_FILE = path.join(DATA_DIR, 'routes.csv.gz');
const WATCH_FILE = path.join(DATA_DIR, 'watch.json');
const R_NM = 3440.065, rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
function distNm(a, b) {
  const x = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.sqrt(x));
}
function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

let routesTextPromise = null;
function loadRoutesText() {
  return routesTextPromise ||= (async () => {
    let buf;
    try {
      if (Date.now() - fs.statSync(ROUTES_FILE).mtimeMs > 7 * DAY) throw new Error('stale');
      buf = fs.readFileSync(ROUTES_FILE);
    } catch {
      try {
        const res = await fetch(`${STANDING}/routes.csv.gz`, { headers: UA, signal: AbortSignal.timeout(90000) });
        if (!res.ok) throw new Error(`route list download failed (${res.status})`);
        buf = Buffer.from(await res.arrayBuffer());
        fs.writeFile(ROUTES_FILE, buf, () => {});
      } catch (e) {
        if (!fs.existsSync(ROUTES_FILE)) throw e;
        buf = fs.readFileSync(ROUTES_FILE);
      }
    }
    return zlib.gunzipSync(buf).toString('utf8');
  })().catch(e => { routesTextPromise = null; throw e; });
}

const watchers = new Map();    // icao -> watcher
const flightState = new Map(); // callsign -> {leg, phase, takeoff, takeoffEst, landed, seen}
// Each poll asks for up to CHUNK flight numbers in one request: first every flight already being
// followed (so positions stay fresh), then the next slice of the rest, to spot new departures.
const MAX_WATCHERS = 3, CHUNK = 250, WATCH_MS = 5000;

async function ensureWatcher(icao) {
  let w = watchers.get(icao);
  if (w) { watchers.delete(icao); watchers.set(icao, w); return w; } // most recent last
  const [airports, text] = await Promise.all([loadAirports(), loadRoutesText()]);
  const apt = airports.get(icao);
  if (!apt) return null;
  const list = [];
  for (const line of text.split('\n')) {
    if (!line.includes(icao)) continue;
    const f = line.trim().split(',');
    const codes = (f[4] || '').split('-');
    if (!codes.includes(icao)) continue;
    const pts = codes.map(c => airports.get(c));
    if (pts.length < 2 || pts.some(p => !p)) continue;
    list.push({ cs: f[0], pts });
  }
  w = { icao, apt, list, byCs: new Map(list.map(r => [r.cs, r])), cursor: 0, flights: new Map(), source: null, error: null };
  watchers.set(icao, w);
  while (watchers.size > MAX_WATCHERS) watchers.delete(watchers.keys().next().value);
  fs.writeFile(WATCH_FILE, JSON.stringify([...watchers.keys()]), () => {});
  await pollWatcher(w);
  return w;
}

async function pollWatcher(w) {
  if (!w.list.length) return;
  const active = [...w.flights.keys()].slice(0, CHUNK - 20).map(cs => w.byCs.get(cs)).filter(Boolean);
  const want = new Set(active.map(r => r.cs));
  const chunk = active.slice();
  for (let n = 0; n < w.list.length && chunk.length < CHUNK; n++) {
    if (w.cursor >= w.list.length) w.cursor = 0;
    const r = w.list[w.cursor++];
    if (!want.has(r.cs)) { want.add(r.cs); chunk.push(r); }
  }
  w.scanEvery = Math.ceil(w.list.length / Math.max(20, CHUNK - active.length)) * WATCH_MS;
  try {
    const { source, j } = await liveFetch('callsign', chunk.map(r => r.cs).join(','));
    w.error = null; w.source = source;
    const now = Date.now();
    for (const ac of j.ac || j.aircraft || []) {
      const cs = (ac.flight || '').trim(), route = w.byCs.get(cs);
      if (!route || ac.lat == null || (ac.seen_pos ?? 0) > 90) continue;
      const f = updateFlight(w, ac, route, now);
      if (f) w.flights.set(cs, f); else w.flights.delete(cs);
      if (f && f.phase === 'air') fetchHistory(ac.hex, cs, route);
    }
    const maxAge = 90e3; // followed flights are re-checked every poll, so 90 s unseen means gone
    for (const [cs, f] of w.flights) if (now - f.t > maxAge) w.flights.delete(cs);
  } catch (e) { w.error = String(e.message || e); }
}

// The path already flown before we started watching, from OpenSky's free track lookup.
// It also gives the real takeoff time. Anonymous use is limited to roughly 100 lookups
// a day, so each flight is looked up once (and again only after a long gap).
const history = { status: 'untried', day: '', used: 0 };
async function fetchHistory(hex, cs, route) {
  const st = flightState.get(cs), now = Date.now();
  if (!st || (st.histTried && now - st.histTried < 45 * 60e3)) return;
  const day = new Date().toISOString().slice(0, 10);
  if (history.day !== day) { history.day = day; history.used = 0; }
  if (history.used >= 80) return;
  st.histTried = now; history.used++;
  try {
    const j = await getJson(`https://opensky-network.org/api/tracks/all?icao24=${hex}&time=0`, 15000);
    history.status = 'ok';
    if (!j || !Array.isArray(j.path) || (j.callsign || '').trim() !== cs) return;
    if (flightState.get(cs) !== st || st.phase !== 'air') return;
    // entries are [unix time, lat, lon, altitude m, track, on ground]
    const flown = j.path.filter(p => p[1] != null && p[2] != null);
    const firstAir = flown.findIndex(p => !p[5]);
    if (firstAir < 0) return;
    const pathPts = flown.slice(firstAir).filter(p => p[0] * 1000 < (st.trailStart || now));
    if (pathPts.length < 2) return;
    const step = Math.ceil(pathPts.length / 400);
    const hist = pathPts.filter((_, i) => i % step === 0).map(p => [p[1], p[2]]);
    st.trail = hist.concat(st.trail || []);
    // if the track really starts at the origin airport, its first airborne moment is the takeoff
    const o = route.pts[st.leg], t0 = pathPts[0];
    if (o && distNm({ lat: t0[1], lon: t0[2] }, o) < 12 && now - t0[0] * 1000 < 20 * 3600e3) {
      st.takeoff = t0[0] * 1000; st.takeoffEst = false;
    }
  } catch (e) {
    if (history.status !== 'ok') history.status = 'unavailable';
  }
}

function updateFlight(w, ac, route, now) {
  const cs = route.cs, pts = route.pts, pos = { lat: ac.lat, lon: ac.lon };
  let st = flightState.get(cs);
  if (st && now - st.seen > 3 * 3600e3) st = null; // callsigns are reused; old state is a different flight
  if (!st) st = { leg: -1, phase: null, takeoff: null, takeoffEst: false, landed: null, seen: 0 };
  const watched = st.seen && now - st.seen < 120e3; // were we already following it a moment ago?
  if (ac.alt_baro === 'ground') {
    const near = pts.map((p, i) => distNm(pos, p) < 4 ? i : -1).filter(i => i >= 0);
    if (!near.length) return null; // on the ground somewhere off-route
    if (st.phase === 'air' && near.includes(st.leg + 1)) { st.phase = 'arrived'; st.landed = now; }
    else if (st.phase === 'arrived' && near.includes(st.leg + 1)) {
      // turnaround on a multi-leg route: after a while on the ground it becomes the next departure
      if (now - (st.landed || st.seen) > 15 * 60e3 && st.leg + 1 < pts.length - 1) { st.leg++; st.phase = 'origin'; st.takeoff = st.landed = null; }
    } else if (!(st.phase === 'origin' && near.includes(st.leg))) {
      const dep = near.find(i => i < pts.length - 1);
      if (dep !== undefined) { st.leg = dep; st.phase = 'origin'; st.takeoff = st.landed = null; }
      else { st.leg = pts.length - 2; st.phase = 'arrived'; st.landed = null; }
    }
  } else if (st.phase === 'origin') {
    st.phase = 'air'; st.takeoff = now; st.takeoffEst = !watched;
  } else if (st.phase === 'arrived') {
    if (st.leg + 1 < pts.length - 1) { st.leg++; st.takeoff = now; st.takeoffEst = !watched; st.landed = null; }
    st.phase = 'air';
  } else if (st.phase === 'air' && st.leg + 1 < pts.length - 1 && (
    (st.nearDest && distNm(pos, pts[st.leg + 1]) > 12) ||
    // or: lost on the way in, then back after a long silence and farther away than before
    (now - st.seen > 12 * 60e3 && st.lastDest < 30 && distNm(pos, pts[st.leg + 1]) > st.lastDest + 3))) {
    // It got down low right by its destination and is now flying away again. We never saw it
    // on the ground (small airports often have no ground coverage), so the landing was missed
    // and this is the next leg of the route.
    const from = pts[st.leg + 1];
    st.leg++; st.landed = null; st.takeoffEst = true;
    st.takeoff = now - (distNm(pos, from) / Math.max(ac.gs || 0, 250) * 1.08 * 3600e3 + 2 * 60e3);
  } else if (st.phase !== 'air') {
    // first seen already airborne: pick the leg it best fits, estimate when it left
    const trk = ac.track ?? ac.true_heading ?? 0;
    const vs = ac.baro_rate ?? ac.geom_rate ?? 0;
    let best = 0, bestScore = Infinity, bestDetour = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const dO = distNm(pos, pts[i]), dD = distNm(pos, pts[i + 1]);
      const detour = dO + dD - distNm(pts[i], pts[i + 1]);
      let score = detour + angDiff(trk, bearing(pos, pts[i + 1])) / 180 * 60;
      // out-and-back routes: climbing near an airport means leaving it, descending means arriving
      if (dO < 60 && dO < dD && vs < -300) score += 100;
      if (dD < 60 && dD < dO && vs > 300) score += 100;
      if (score < bestScore) { bestScore = score; best = i; bestDetour = detour; }
    }
    // nowhere near the published route: the route list is wrong for today's flight
    if (bestDetour > Math.max(150, 0.3 * distNm(pts[best], pts[best + 1]))) return null;
    st.leg = best; st.phase = 'air'; st.takeoffEst = true;
    st.takeoff = now - (distNm(pos, pts[best]) / Math.max(ac.gs || 0, 280) * 1.08 * 3600e3 + 4 * 60e3);
  }
  st.seen = now;
  // remember the path flown on this leg so any device opening the page can draw it
  if (st.trailLeg !== st.leg) { st.trail = []; st.trailLeg = st.leg; st.trailStart = now; st.histTried = 0; st.nearDest = false; }
  // note when it is low and close to this leg's destination, i.e. about to land there
  const destPt = pts[st.leg + 1];
  if (st.phase === 'air' && typeof ac.alt_baro === 'number' && ac.alt_baro < destPt.elev + 3000 && distNm(pos, destPt) < 6) st.nearDest = true;
  st.lastDest = distNm(pos, destPt);
  const lastPt = st.trail[st.trail.length - 1];
  if (!lastPt || distNm(pos, { lat: lastPt[0], lon: lastPt[1] }) > 0.3) {
    st.trail.push([+ac.lat.toFixed(4), +ac.lon.toFixed(4)]);
    if (st.trail.length > 800) st.trail = st.trail.filter((_, i) => i % 2 === 0 || i > 700); // thin out the old part
  }
  flightState.set(cs, st);

  const o = pts[st.leg], d = pts[st.leg + 1];
  const legDist = distNm(o, d), remaining = distNm(pos, d);
  const brief = a => ({ icao: a.icao, iata: a.iata, name: a.name, location: a.location, lat: a.lat, lon: a.lon });
  return {
    t: now, ac, orig: brief(o), dest: brief(d), trail: st.trail,
    dir: d.icao === w.icao ? 'in' : o.icao === w.icao ? 'out' : null,
    phase: st.phase, takeoff: st.takeoff, takeoffEst: st.takeoffEst, landed: st.landed,
    legDist, remaining,
    // still far out: assume at least cruise speed, so a slow climb-out doesn't inflate the ETA
    eta: st.phase === 'air' ? now + remaining / Math.max(ac.gs || 0, remaining > 100 ? 380 : 200) * 3600e3 + 3 * 60e3 : null,
    estMin: Math.round(legDist / 400 * 60 + 12),
  };
}

let watchBusy = false;
setInterval(async () => {
  if (watchBusy) return;
  watchBusy = true;
  try { for (const w of [...watchers.values()]) await pollWatcher(w); } finally { watchBusy = false; }
}, WATCH_MS);
// resume watching the airports from last time, so takeoffs are caught while the page is closed
try {
  JSON.parse(fs.readFileSync(WATCH_FILE, 'utf8')).slice(-MAX_WATCHERS)
    .reduce((p, c) => p.then(() => ensureWatcher(c)).catch(() => {}), Promise.resolve());
} catch {}

// ---------- http ----------
// The page may only run code that ships with the app, and only load map tiles from OpenStreetMap.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://tile.openstreetmap.org https://server.arcgisonline.com https://tilecache.rainviewer.com; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Flight Radar", charset="UTF-8"' });
    return res.end('Password required');
  }
  try {
    if (url.pathname === '/api/aircraft') {
      const lat = +url.searchParams.get('lat'), lon = +url.searchParams.get('lon');
      const dist = Math.min(250, Math.max(1, Math.round(+url.searchParams.get('dist') || 100)));
      if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return send(res, 400, { error: 'bad lat/lon' });
      return send(res, 200, await getAircraft(lat, lon, dist));
    }
    if (url.pathname === '/api/routes') {
      const list = (url.searchParams.get('cs') || '').toUpperCase().split(',')
        .filter(c => /^[A-Z0-9]{3,8}$/.test(c)).slice(0, 60);
      const routes = await mapLimit(list, 6, lookupRoute);
      const out = {};
      list.forEach((c, i) => { if (routes[i] !== undefined) out[c] = routes[i]; });
      return send(res, 200, out);
    }
    if (url.pathname === '/api/watch') {
      const code = (url.searchParams.get('airport') || '').toUpperCase();
      if (!/^[A-Z0-9]{3,4}$/.test(code)) return send(res, 400, { error: 'bad code' });
      const w = await ensureWatcher(code);
      if (!w) return send(res, 404, { error: 'unknown airport' });
      return send(res, 200, { airport: w.icao, tracked: w.list.length, scanSecs: Math.round((w.scanEvery || 0) / 1000), source: w.source, error: w.error, history: history.status, flights: [...w.flights.values()].filter(f => f.dir) });
    }
    if (url.pathname === '/api/radar') return send(res, 200, await getRadar());
    if (url.pathname.startsWith('/api/airport/')) {
      const code = url.pathname.split('/')[3].toUpperCase();
      if (!/^[A-Z0-9]{3,4}$/.test(code)) return send(res, 400, { error: 'bad code' });
      const a = (await loadAirports()).get(code);
      return a ? send(res, 200, a) : send(res, 404, { error: 'unknown airport' });
    }
    // static
    let p = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
    if (!p.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(p, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' });
      res.end(data);
    });
  } catch (e) {
    send(res, 502, { error: String(e.message || e) });
  }
}).listen(PORT, HOST, () => console.log(`Flight tracker running at http://localhost:${PORT}${PASSWORD ? ' (password protected)' : ''}`));
