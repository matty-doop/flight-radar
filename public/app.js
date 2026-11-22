'use strict';
const $ = id => document.getElementById(id);
const POLL_MS = 5000;
const COLORS = { in: '#3ddc84', out: '#ff9f43', other: '#7fb2ff', sel: '#ffe14d', gnd: '#9aa3ad' };

// ---------- persisted settings ----------
const saved = (() => { try { return JSON.parse(localStorage.getItem('fr') || '{}'); } catch { return {}; } })();
const S = Object.assign({ airport: 'KGEG', mode: 'both', range: 100, hideGround: false, selPaths: false, airlines: true, collapsed: null, search: '', altMin: '', altMax: '' }, saved);
const persist = () => { try { localStorage.setItem('fr', JSON.stringify(S)); } catch {} };

// ---------- state ----------
let apt = null;                 // {icao, iata, name, lat, lon, elev}
let aircraft = [];              // latest snapshot
let selected = null;            // hex
let watchInfo = null;           // {tracked} when following airline flights worldwide
let needFit = false;
let nearbyCount = 0, followedCount = 0;
const watchMode = () => !!apt && S.airlines && S.mode !== 'all';
const routes = new Map();       // callsign -> route | null
const routePending = new Set();
const tags = new Map();         // hex -> {dir:'in'|'out', t} from the approach/departure heuristic
const wasGroundAtApt = new Map(); // hex -> timestamp
const trails = new Map();       // hex -> [[lat,lon],...]
const markers = new Map();      // hex -> L.marker

// ---------- map ----------
const map = L.map('map', { zoomControl: true }).setView([47.6199, -117.5338], 8);
// Base map. "Normal" is OpenStreetMap (darkened), whose place names are baked into the
// pictures. "Faint" and "Off" use Esri's dark gray map, which keeps the names on a
// separate layer that can be dimmed or left out.
const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const AC_ATTR = ' | aircraft: adsb.fi, adsb.lol';
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/';
const baseMaps = {
  osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, className: 'tiles', attribution: OSM_ATTR + AC_ATTR }),
  dark: L.tileLayer(ESRI + 'World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 18, maxNativeZoom: 16,
    attribution: 'Tiles &copy; <a href="https://www.esri.com">Esri</a> &mdash; Esri, HERE, Garmin, ' + OSM_ATTR + AC_ATTR }),
};
const labelLayer = L.tileLayer(ESRI + 'World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 18, maxNativeZoom: 16, opacity: .45 });
function setLabels(v) {
  S.labels = v; persist();
  const base = v === 'normal' ? baseMaps.osm : baseMaps.dark;
  for (const l of Object.values(baseMaps)) if (l !== base && map.hasLayer(l)) map.removeLayer(l);
  if (!map.hasLayer(base)) base.addTo(map);
  if (v === 'faint') labelLayer.addTo(map); else labelLayer.remove();
}
setLabels(['normal', 'faint', 'off'].includes(S.labels) ? S.labels : 'normal');

// Weather radar overlay. Over the lower 48 it uses the National Weather Service composite
// (via Iowa State's Mesonet), which is sharp down to airport level; elsewhere RainViewer,
// whose free tiles stop at zoom 7 and are enlarged beyond that. The newest frame is
// fetched every 5 minutes while the layer is on.
const US_BOX = L.latLngBounds([20, -130], [53, -60]);
const radar = { layer: null, src: '', url: '', info: null, timer: null, time: 0 };
async function loadRadar() {
  try {
    const r = await fetch('api/radar').then(x => x.ok ? x.json() : null);
    if (r && S.radar) { radar.info = r; showRadar(); }
  } catch {}
}
function showRadar() {
  const r = radar.info;
  if (!S.radar || !r) return;
  const useUS = US_BOX.contains(map.getCenter()) && r.us;
  let url, opts;
  if (useUS) {
    // the time in the address makes browsers fetch fresh tiles after each update
    url = `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png?t=${r.us.time || Math.floor(Date.now() / 300e3)}`;
    opts = { maxNativeZoom: 12, attribution: 'radar: NWS via <a href="https://mesonet.agron.iastate.edu">Iowa Mesonet</a>' };
  } else if (r.world) {
    url = `${r.world.host}${r.world.path}/256/{z}/{x}/{y}/2/1_1.png`;
    opts = { maxNativeZoom: 7, attribution: 'radar: <a href="https://www.rainviewer.com">RainViewer</a>' };
  } else return;
  const src = useUS ? 'NWS' : 'RainViewer';
  radar.time = useUS ? r.us.time : r.world.time;
  if (radar.layer && radar.src === src) { if (radar.url !== url) radar.layer.setUrl(url); }
  else {
    if (radar.layer) radar.layer.remove();
    radar.layer = L.tileLayer(url, { opacity: S.radarOpacity ?? .6, maxZoom: 18, zIndex: 5, ...opts }).addTo(map);
  }
  radar.src = src; radar.url = url;
  updateRadarBtn();
}
map.on('moveend', showRadar);
function setRadar(on) {
  S.radar = on; persist();
  clearInterval(radar.timer);
  if (on) { loadRadar(); radar.timer = setInterval(loadRadar, 300e3); }
  else if (radar.layer) { radar.layer.remove(); radar.layer = null; radar.src = ''; }
  updateRadarBtn();
}
const RadarToggle = L.Control.extend({
  options: { position: 'topleft' },
  onAdd() {
    const box = L.DomUtil.create('div', 'radarctl');
    const b = L.DomUtil.create('a', 'leaflet-bar sidebtn radarbtn', box);
    b.href = '#'; b.setAttribute('role', 'button'); b.textContent = '☂';
    // opacity slider, shown beside the button while the radar is on
    const r = L.DomUtil.create('input', 'radarop', box);
    r.type = 'range'; r.min = 10; r.max = 100; r.step = 5;
    r.value = Math.round((S.radarOpacity ?? .6) * 100);
    r.title = 'Radar opacity'; r.setAttribute('aria-label', 'Radar opacity');
    L.DomEvent.disableClickPropagation(box);
    L.DomEvent.disableScrollPropagation(box);
    L.DomEvent.on(b, 'click', e => { L.DomEvent.preventDefault(e); setRadar(!S.radar); });
    L.DomEvent.on(r, 'input', () => {
      S.radarOpacity = r.value / 100;
      if (radar.layer) radar.layer.setOpacity(S.radarOpacity);
    });
    L.DomEvent.on(r, 'change', persist);
    this._b = b;
    return box;
  },
});
const radarToggle = new RadarToggle();
map.addControl(radarToggle);
function updateRadarBtn() {
  const b = radarToggle._b;
  radarToggle.getContainer().classList.toggle('on', !!S.radar);
  b.classList.toggle('on', !!S.radar);
  const at = radar.time ? ` (as of ${new Date(radar.time * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})` : '';
  b.title = S.radar ? `Hide weather radar${radar.src ? ' — ' + radar.src : ''}${at}` : 'Show weather radar';
  b.setAttribute('aria-label', b.title);
}
setRadar(!!S.radar);

// button on the map that hides or shows the side panel
const SideToggle = L.Control.extend({
  options: { position: 'topleft' },
  onAdd() {
    const b = L.DomUtil.create('a', 'leaflet-bar sidebtn');
    b.href = '#'; b.setAttribute('role', 'button');
    L.DomEvent.disableClickPropagation(b);
    L.DomEvent.on(b, 'click', e => { L.DomEvent.preventDefault(e); setSide(!S.sideHidden); });
    this._b = b;
    return b;
  },
});
const sideToggle = new SideToggle();
map.addControl(sideToggle);
sideToggle.getContainer().parentNode.prepend(sideToggle.getContainer()); // above the zoom buttons
function setSide(hidden) {
  S.sideHidden = hidden; persist();
  document.body.classList.toggle('noside', hidden);
  const b = sideToggle._b;
  b.textContent = hidden ? '☰' : '«';
  b.title = hidden ? 'Show panel' : 'Hide panel';
  b.setAttribute('aria-label', b.title);
  map.invalidateSize();
}
setSide(!!S.sideHidden);

const trailLine = L.polyline([], { color: COLORS.sel, weight: 2, opacity: .8 }).addTo(map);
const pathLayer = L.layerGroup().addTo(map);
let aptMarker = null, rangeRing = null;

// Points along the shortest (great-circle) path between two [lat, lon] places.
function gcLine(a, b, n = 24) {
  const v = ([la, lo]) => [Math.cos(rad(la)) * Math.cos(rad(lo)), Math.cos(rad(la)) * Math.sin(rad(lo)), Math.sin(rad(la))];
  const p = v(a), q = v(b), w = Math.acos(Math.min(1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2]));
  if (w < 1e-4) return [a, b];
  const out = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n, A = Math.sin((1 - f) * w) / Math.sin(w), B = Math.sin(f * w) / Math.sin(w);
    const x = A * p[0] + B * q[0], y = A * p[1] + B * q[1], z = A * p[2] + B * q[2];
    out.push([deg(Math.atan2(z, Math.hypot(x, y))), deg(Math.atan2(y, x))]);
  }
  return out;
}

// For followed airline flights: solid line = path actually flown, dotted = projected
// direct route still to fly.
function drawPaths(shown) {
  pathLayer.clearLayers();
  const ends = new Map();
  for (const ac of shown) {
    const w = ac._w;
    if (!w || (S.selPaths && ac.hex !== selected)) continue;
    const sel = ac.hex === selected, color = sel ? COLORS.sel : COLORS[w.dir] || COLORS.other;
    const here = [ac.lat, ac.lon];
    const trail = (w.trail || []).concat([here]);
    const dash = { color, weight: 2, opacity: sel ? .7 : .55, dashArray: '1 7', lineCap: 'round', interactive: false };
    pathLayer.addLayer(L.polyline(trail, { color, weight: sel ? 3 : 1.5, opacity: sel ? 1 : .75, interactive: false }));
    if (w.phase !== 'arrived') pathLayer.addLayer(L.polyline(gcLine(here, [w.dest.lat, w.dest.lon]), dash));
    for (const a of [w.orig, w.dest]) if (!apt || a.icao !== apt.icao) ends.set(a.icao, a);
  }
  for (const a of ends.values()) {
    pathLayer.addLayer(L.circleMarker([a.lat, a.lon], { radius: 4, color: '#cfd8e3', weight: 1.5, fillOpacity: .3, interactive: false })
      .bindTooltip(a.iata || a.icao, { permanent: true, direction: 'top', offset: [0, -4], className: 'cslabel' }));
  }
}

// ---------- smooth movement between updates ----------
// Between real position reports each plane is moved along its last known track and speed
// (following its turn, if it was turning). When a new report arrives the plane eases onto
// it over a moment instead of jumping.
const EASE_MS = 1500, MAX_GUESS_S = 45;
function fixTime(ac) {
  const at = ac._w ? ac._w.t : ac._rx || Date.now();
  return at - (ac.seen_pos ?? 0) * 1000;
}
function setFix(m, ac) {
  const f = m._drFix;
  if (f && f.lat === ac.lat && f.lon === ac.lon) return; // nothing new
  const now = Date.now(), before = f ? placeOf(m, now) : null;
  m._drFix = { lat: ac.lat, lon: ac.lon, t: fixTime(ac), gs: ac.gs || 0, trk: trackOf(ac), gnd: onGround(ac),
             rate: Math.max(-3, Math.min(3, ac.track_rate || 0)) };
  m._drEase = null;
  if (before) {
    const p = guess(m._drFix, now);
    const dlat = before[0] - p[0], dlon = before[1] - p[1];
    if (Math.abs(dlat) < 0.5 && Math.abs(dlon) < 0.5) m._drEase = { dlat, dlon, t: now }; // big gaps just jump
  }
}
function guess(f, now) {
  // taxiing planes turn and slow down often, so they are carried forward for only a few
  // seconds and at a bit under their last speed, to avoid overshooting
  let dt = Math.min(f.gnd ? 5 : MAX_GUESS_S, Math.max(0, (now - f.t) / 1000));
  if (f.gs < (f.gnd ? 3 : 30) || !dt) return [f.lat, f.lon]; // parked or barely moving: leave it where it is
  const gs = f.gnd ? f.gs * 0.7 : f.gs;
  let lat = f.lat, lon = f.lon, trk = f.trk;
  const step = 1, turnFor = 20; // follow a turn for at most 20 s
  for (let s = 0; s < dt; s += step) {
    const h = Math.min(step, dt - s), nm = gs * h / 3600, k = rad(trk);
    lat += nm / 60 * Math.cos(k);
    lon += nm / 60 * Math.sin(k) / Math.cos(rad(lat));
    if (s < turnFor) trk += f.rate * h;
  }
  return [lat, lon];
}
function placeOf(m, now) {
  const p = guess(m._drFix, now), o = m._drEase;
  if (!o) return p;
  const k = 1 - (now - o.t) / EASE_MS;
  if (k <= 0) { m._drEase = null; return p; }
  return [p[0] + o.dlat * k, p[1] + o.dlon * k];
}
setInterval(() => {
  if (document.hidden) return;
  const now = Date.now();
  for (const m of markers.values()) if (m._drFix) m.setLatLng(placeOf(m, now));
}, 200);

// ---------- geo helpers ----------
const R_NM = 3440.065, rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
function distNm(a, b, c, d) {
  const x = Math.sin(rad(c - a) / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(rad(d - b) / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.sqrt(x));
}
function bearing(a, b, c, d) {
  const y = Math.sin(rad(d - b)) * Math.cos(rad(c));
  const x = Math.cos(rad(a)) * Math.sin(rad(c)) - Math.sin(rad(a)) * Math.cos(rad(c)) * Math.cos(rad(d - b));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

// ---------- aircraft helpers ----------
const csOf = ac => (ac.flight || '').trim();
const onGround = ac => ac.alt_baro === 'ground';
// Airliner types (not business jets or light aircraft), used to spot airline planes parked
// at the airport that are not broadcasting a flight number with a published route.
const AIRLINER = /^(A3[0-8]\d|A[12][01]N|A3[3-9]\w|A38\d|BCS[13]|B7[0-8]\w|B3[789]M|B3XM|B46\w|CRJ[1-9X]|E1[3-9]\d|E2[79]\d|E45X|E7[05][LS]|E17\d|E19\d|DH8[A-D]|AT[47]\d|MD[89]\d|MD1\d|RJ\d\d|SF34|DC\d\d)$/;
const altOf = ac => onGround(ac) ? 0 : (typeof ac.alt_baro === 'number' ? ac.alt_baro : ac.alt_geom);
const vsOf = ac => ac.baro_rate ?? ac.geom_rate ?? 0;
const trackOf = ac => ac.track ?? ac.true_heading ?? ac.mag_heading ?? 0;

// Direction relative to the selected airport.
// Returns {dir:'in'|'out'|'gnd', sure:bool} or null. "sure" = from the published route.
function classify(ac) {
  if (!apt || ac.lat == null) return null;
  const d = distNm(ac.lat, ac.lon, apt.lat, apt.lon);
  ac._d = d;
  if (ac._w) return { dir: ac._w.dir, sure: true };
  const gnd = onGround(ac);
  if (gnd && d < 2.5) { wasGroundAtApt.set(ac.hex, Date.now()); return { dir: 'gnd', sure: true }; }

  const r = routes.get(csOf(ac));
  if (r && r.codes) {
    const i = r.codes.indexOf(apt.icao);
    if (i >= 0) {
      const isDest = i > 0, isOrig = i < r.codes.length - 1;
      if (isDest && !isOrig) return { dir: 'in', sure: true };
      if (isOrig && !isDest) return { dir: 'out', sure: true };
      return { dir: vsOf(ac) < 0 ? 'in' : 'out', sure: true }; // multi-leg through this airport
    }
  }

  // Heuristic for flights with no published route (GA, charters, etc.)
  if (!gnd && d < 25) {
    const agl = (altOf(ac) ?? 99999) - apt.elev, vs = vsOf(ac), trk = trackOf(ac);
    const toApt = bearing(ac.lat, ac.lon, apt.lat, apt.lon);
    const justLeft = Date.now() - (wasGroundAtApt.get(ac.hex) || 0) < 20 * 60e3;
    let dir = null;
    if (justLeft) dir = 'out';
    else if (agl < 1500 + d * 450 && vs < -150 && angDiff(trk, toApt) < 45) dir = 'in';
    else if (d < 12 && agl < 1000 + d * 700 && vs > 250 && angDiff(trk, toApt) > 110) dir = 'out';
    if (dir) tags.set(ac.hex, { dir, t: Date.now() });
  }
  const tag = tags.get(ac.hex);
  if (tag && Date.now() - tag.t < 30 * 60e3) return { dir: tag.dir, sure: false };
  return null;
}

function passes(ac) {
  if (ac.lat == null) return false;
  const c = ac._c;
  if (apt && S.mode !== 'all') {
    if (!c) return false;
    if (S.mode === 'in' && c.dir === 'out') return false;
    if (S.mode === 'out' && c.dir === 'in') return false;
  }
  if (S.hideGround && onGround(ac)) return false;
  const alt = altOf(ac);
  if (S.altMin !== '' && !(alt >= +S.altMin)) return false;
  if (S.altMax !== '' && !(alt <= +S.altMax)) return false;
  if (S.search) {
    const hay = `${csOf(ac)} ${ac.r || ''} ${ac.t || ''} ${ac.desc || ''} ${ac.hex}`.toUpperCase();
    if (!S.search.toUpperCase().split(/\s+/).every(w => hay.includes(w))) return false;
  }
  return true;
}

// ---------- data loading ----------
function queryCentre() {
  if (apt) return { lat: apt.lat, lon: apt.lon };
  const c = map.getCenter();
  return { lat: c.lat, lon: c.lng };
}

let polling = false, groundCache = null;
async function poll() {
  if (polling || document.hidden) return;
  polling = true;
  try {
    const watching = watchMode(), c = queryCentre();
    const res = await fetch(watching ? `/api/watch?airport=${apt.icao}`
      : `/api/aircraft?lat=${c.lat.toFixed(4)}&lon=${c.lon.toFixed(4)}&dist=${S.range}`);
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || res.status);
    if (watching !== watchMode()) return; // settings changed while loading
    if (watching) {
      if (j.error && !j.flights.length) throw new Error(j.error);
      watchInfo = { tracked: j.tracked, history: j.history };
      aircraft = j.flights.map(f => Object.assign(f.ac, { _w: f }));
      j.source = j.source || 'adsb.fi';
      // Add airline planes on the ground at the airport that are not (yet) on a followed flight:
      // parked at the gate with no flight number set, or still showing the one they arrived on.
      if (!S.hideGround) {
        const icao = apt.icao;
        // refreshed every poll (5 s) so taxiing planes are shown moving along the taxiways
        if (!groundCache || groundCache.icao !== icao || Date.now() - groundCache.t > 4e3) {
          const g = await fetch(`/api/aircraft?lat=${apt.lat.toFixed(4)}&lon=${apt.lon.toFixed(4)}&dist=3`).then(r => r.ok ? r.json() : null).catch(() => null);
          if (!watchMode() || !apt || apt.icao !== icao) return;
          groundCache = g ? { icao, t: Date.now(), g } : groundCache;
        }
        const g = groundCache && groundCache.icao === icao ? groundCache.g : null;
        if (g) {
          const hexes = new Set(aircraft.map(a => a.hex));
          for (const a of g.ac) {
            a._rx = groundCache.t;
            if (a.lat != null && onGround(a) && AIRLINER.test(a.t || '') && !hexes.has(a.hex) &&
                (a.seen_pos ?? 0) < 120 && distNm(a.lat, a.lon, apt.lat, apt.lon) < 2.5) aircraft.push(a);
          }
        }
      }
    } else {
      watchInfo = null;
      const rx = Date.now();
      aircraft = j.ac.filter(a => a.lat != null && (a.seen_pos ?? 0) < 60);
      for (const a of aircraft) a._rx = rx;
      nearbyCount = aircraft.length; followedCount = 0;
      // With an airport chosen, add its followed airline flights too, however far away they
      // are. Where a plane is in both lists, the followed copy wins (it has takeoff and ETA).
      if (apt) {
        const icao = apt.icao;
        const w = await fetch(`/api/watch?airport=${icao}`).then(r => r.ok ? r.json() : null).catch(() => null);
        if (watchMode() || !apt || apt.icao !== icao) return;
        if (w && w.flights.length) {
          const followed = w.flights.map(f => Object.assign(f.ac, { _w: f }));
          const hexes = new Set(followed.map(a => a.hex));
          aircraft = followed.concat(aircraft.filter(a => !hexes.has(a.hex)));
          followedCount = followed.length;
        }
      }
    }
    for (const ac of aircraft) {
      let t = trails.get(ac.hex);
      if (!t) trails.set(ac.hex, t = []);
      const last = t[t.length - 1];
      if (!last || last[0] !== ac.lat || last[1] !== ac.lon) { t.push([ac.lat, ac.lon]); if (t.length > 400) t.shift(); }
    }
    $('status').textContent = `${j.source} · ${new Date().toLocaleTimeString()}`;
    $('status').className = '';
    render();
    if (needFit && aircraft.length) {
      needFit = false;
      map.fitBounds(L.latLngBounds(aircraft.flatMap(a => a._w ? [[a.lat, a.lon], [a._w.orig.lat, a._w.orig.lon], [a._w.dest.lat, a._w.dest.lon]] : [[a.lat, a.lon]])
        .concat([[apt.lat, apt.lon]])).pad(0.15), { maxZoom: 9, animate: false });
    }
    if (!watching) fetchRoutes();
  } catch (e) {
    $('status').textContent = 'data error: ' + e.message;
    $('status').className = 'err';
  } finally { polling = false; }
}

async function fetchRoutes() {
  const want = [];
  for (const ac of aircraft) {
    const cs = csOf(ac);
    // airline-style callsigns only; tail numbers have no published route
    if (/^[A-Z]{3}\d[A-Z0-9]{0,4}$/.test(cs) && !routes.has(cs) && !routePending.has(cs)) want.push(cs);
    if (want.length >= 50) break;
  }
  if (!want.length) return;
  want.forEach(c => routePending.add(c));
  try {
    const j = await (await fetch('/api/routes?cs=' + want.join(','))).json();
    for (const cs of want) if (cs in j) routes.set(cs, j[cs]);
    render();
  } catch {} finally { want.forEach(c => routePending.delete(c)); }
}

// ---------- rendering ----------
// Marker shape and size by aircraft type (ADS-B type code, falling back to the emitter category)
const JET_PATH = 'M12 1.5c.9 0 1.5 1 1.5 2.4V9l8 4.6v2.1l-8-2.5v5l2.4 1.8v1.6L12 20.6l-3.9 1v-1.6l2.4-1.8v-5l-8 2.5v-2.1l8-4.6V3.9c0-1.4.6-2.4 1.5-2.4z';
const SHAPES = {
  jet: JET_PATH,
  heavy: 'M12 .6c1 0 1.7 1.1 1.7 2.7v5.1l9.6 5.4v2.4l-9.6-3v5.5l2.8 2v1.7L12 21.5l-4.5.9v-1.7l2.8-2v-5.5l-9.6 3v-2.4l9.6-5.4V3.3C10.3 1.7 11 .6 12 .6z' +
         'M5.9 9.6h1.5v2.6H5.9zM16.6 9.6h1.5v2.6h-1.5z',
  biz: 'M12 2c.8 0 1.3.9 1.3 2.2v5.6l6.8 4.3v1.7l-6.8-2v3.6l3 2.1v1.4L12 20l-4.3.9v-1.4l3-2.1v-3.6l-6.8 2v-1.7l6.8-4.3V4.2C10.7 2.9 11.2 2 12 2z',
  prop: 'M12 2c.8 0 1.2.9 1.2 2.2v4.3l9.3.3v2.4l-9.3.7v5.7l3 1v1.6l-4.2.4-4.2-.4v-1.6l3-1v-5.7l-9.3-.7V8.8l9.3-.3V4.2C10.8 2.9 11.2 2 12 2z' +
        'M6.2 6.9h1.4v2H6.2zM16.4 6.9h1.4v2h-1.4z',
  light: 'M12 3c.7 0 1.1.8 1.1 1.9V8l9.4.2v2.3l-9.4.5v6.2l2.8.8v1.5L12 19.8l-3.9-.3V18l2.8-.8V11l-9.4-.5V8.2l9.4-.2V4.9C10.9 3.8 11.3 3 12 3z',
  heli: 'M12 6.4c1.9 0 3.2 1.9 3.2 4.4s-1.3 4.3-3.2 4.3-3.2-1.8-3.2-4.3 1.3-4.4 3.2-4.4z' +
        'M11.3 14.5h1.4v6.4h-1.4zM9.6 20.2h4.8v1.3H9.6z' +
        'M3.4 2.6l.9-.9 16.3 16.3-.9.9zM20.6 2.6l-.9-.9L3.4 18l.9.9z',
};
const SIZES = { heavy: 32, jet: 24, regional: 21, propliner: 21, biz: 19, prop: 18, light: 15, heli: 19 };
const HEAVY = /^(A30\w|A310|A33\w|A34\w|A35\w|A38\w|B74\w|B76\w|B77\w|B78\w|B79\w|MD11|DC10|L101|IL96|IL76|C17|C5M?|KC10|K35R|KC46|A400|A124|AN12|AN22|B52|E3TF|E3CF|BLCF|A3ST)$/;
const REGIONAL = /^(CRJ\w|E1[3-9]\d|E17\d|E19\d|E7[05][LS]|E2[79]\d|E45X|RJ\d\d|B46\w|F70|F100|BCS1)$/;
const PROPLINER = /^(DH8\w|AT[4-7]\w|SF34|SB20|E120|F50|D328|J328|JS41|SW4)$/;
const PROP = /^(B190|BE20|BE30|B350|BE9L|BE9T|BE99|BE10|PC12|C208|C30J|C130|DHC6|DHC7|L410|PAY\w|P180|TBM\w|M600|PA46|P46T|C441|C425|AN2\d|AN3\d|Y12|DO28|CN35|C295|BN2\w|AC\d\w|MU2|KODI|PC6T|C406|JS3\d)$/;
const HELI = /^(H47|H53|H60|H64|H500|H269|EC\d\d\w?|AS\d\d\w?|R22|R44|R66|B06|B06T|B407|B412|B429|B505|B212|B222|B230|BK17|A109|A119|A139|A169|A189|AW\d+|S76|S92|UH\d+|MD52|MD60|MD90|EXPL|EH10|NH90|CH\d+|AH\d+|S61|S64|K32|MI8|MI17|G2CA|ALO\d|R300|EN\d\d|H160|H135|H145|H125|H130|H155|H175|H215|H225)$/;
const BIZ = /^(C25\w|C5\d\w|C56X|C68A|C700|C750|C510|C501|CL30|CL35|CL60|GL\w\w|GLF\d|GA\dC|G150|G280|LJ\d\d|FA\d\w|F2TH|F900|E50P|E55P|E545|E550|H25\w|HDJT|PC24|BE40|PRM1|SF50|EA50|ASTR|WW24|GALX)$/;
const LIGHT = /^(C1[5-9]\d|C2[01]\d|C17\w|C18\w|P28\w|PA\d\d|SR2\d|DA\d\w|M20\w|BE3[356]|BE23|BE76|BE55|BE58|C310|C340|AA5|RV\d+|GLID|ULAC|J3|CH7A|DV20|TB\d\d|P32R|S22T|AMPH|BL8|SIRA|PA\w\w)$/;
function kindOf(ac) {
  const t = ac.t || '', cat = ac.category || '';
  if (HELI.test(t) || cat === 'A7') return 'heli';
  if (HEAVY.test(t)) return 'heavy';
  if (REGIONAL.test(t)) return 'regional';
  if (PROPLINER.test(t)) return 'propliner';
  if (PROP.test(t)) return 'prop';
  if (BIZ.test(t)) return 'biz';
  if (LIGHT.test(t)) return 'light';
  if (AIRLINER.test(t)) return 'jet';
  if (cat === 'A5') return 'heavy';
  if (cat === 'A1' || cat === 'B1' || cat === 'B4') return 'light';
  if (cat === 'A2') return 'biz';
  return 'jet';
}
function planeIcon(color, rot, big, kind = 'jet') {
  const shape = SHAPES[kind] || (kind === 'propliner' ? SHAPES.prop : SHAPES.jet);
  const s = Math.round((SIZES[kind] || 22) * (big ? 1.3 : 1));
  return L.divIcon({
    className: '', iconSize: [s, s], iconAnchor: [s / 2, s / 2],
    html: `<svg class="plane" width="${s}" height="${s}" viewBox="0 0 24 24" style="transform:rotate(${rot}deg)">
      <path fill="${color}" stroke="#0b0e12" stroke-width="${(.8 * 24 / s).toFixed(2)}" d="${shape}"/></svg>`,
  });
}

function colorFor(ac) {
  if (ac.hex === selected) return COLORS.sel;
  const c = ac._c;
  if (c) return c.dir === 'in' ? COLORS.in : c.dir === 'out' ? COLORS.out : COLORS.gnd;
  return onGround(ac) ? COLORS.gnd : COLORS.other;
}

const fmtTime = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDur = m => m >= 60 ? `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m` : `${Math.max(0, Math.round(m))} min`;
const code = a => a.iata || a.icao;
// Where the flight is in its trip: waiting at origin, en route (takeoff + ETA), or landed.
function timing(ac) {
  const w = ac._w;
  if (!w) return '';
  if (w.phase === 'origin') return `${ac.gs > 4 ? "Taxiing" : "On the ground"} at ${code(w.orig)} · flight time about ${fmtDur(w.estMin)}`;
  if (w.phase === 'arrived') return `Landed at ${code(w.dest)}${w.landed ? ' ' + fmtTime(w.landed) : ''}`;
  const off = w.takeoff ? `Left ${code(w.orig)} ${w.takeoffEst ? '~' : ''}${fmtTime(w.takeoff)} · ` : '';
  return `${off}ETA ${code(w.dest)} ${fmtTime(w.eta)} (${fmtDur((w.eta - Date.now()) / 60e3)})`;
}

function routeText(ac) {
  if (ac._w) return `${code(ac._w.orig)} → ${code(ac._w.dest)}`;
  const r = routes.get(csOf(ac));
  if (!r) return '';
  return r.airports.length ? r.airports.map(a => a.iata || a.icao).join(' → ') : r.codes.join(' → ');
}
const fmtAlt = ac => onGround(ac) ? 'ground' : altOf(ac) != null ? `${altOf(ac).toLocaleString()} ft` : '—';
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

const MODE_LABEL = { all: 'All traffic', both: 'In + Out', in: 'Inbound', out: 'Outbound' };
function renderSummary() {
  const collapsed = $('side').classList.contains('collapsed');
  const parts = [apt ? apt.icao : 'No airport', MODE_LABEL[apt ? S.mode : 'all']];
  if (watchMode()) parts.push('airlines');
  if (S.search) parts.push(`"${S.search}"`);
  if (S.hideGround) parts.push('no ground');
  if (S.selPaths) parts.push('one path');
  if (S.altMin !== '' || S.altMax !== '') parts.push('altitude');
  $('filterSummary').textContent = collapsed ? parts.join(' · ') : 'Hide filters';
}

function render() {
  renderSummary();
  for (const ac of aircraft) ac._c = classify(ac);
  const shown = aircraft.filter(passes);
  const labels = shown.length <= 40;

  // markers
  const live = new Set();
  for (const ac of shown) {
    live.add(ac.hex);
    const kind = kindOf(ac);
    const key = `${colorFor(ac)}|${Math.round(trackOf(ac) / 5) * 5}|${ac.hex === selected}|${kind}`;
    let m = markers.get(ac.hex);
    if (!m) {
      m = L.marker([ac.lat, ac.lon], { icon: planeIcon(colorFor(ac), trackOf(ac), false, kind), keyboard: false }).addTo(map);
      setFix(m, ac); m.setLatLng(placeOf(m, Date.now()));
      m.on('click', () => select(ac.hex));
      m._key = key;
      markers.set(ac.hex, m);
    } else {
      setFix(m, ac); m.setLatLng(placeOf(m, Date.now()));
      if (m._key !== key) { m.setIcon(planeIcon(colorFor(ac), Math.round(trackOf(ac) / 5) * 5, ac.hex === selected, kind)); m._key = key; }
    }
    const label = csOf(ac) || ac.r || ac.hex;
    const dir = ac._c ? ac._c.dir : '';
    if (m._label !== label || m._perm !== labels || m._dir !== dir) {
      m.unbindTooltip();
      m.bindTooltip(label, { permanent: labels, direction: 'right', offset: [10, 0], className: `cslabel ${dir}` });
      m._label = label; m._perm = labels; m._dir = dir;
    }
    m.setZIndexOffset(ac.hex === selected ? 1000 : 0);
  }
  for (const [hex, m] of markers) if (!live.has(hex)) { m.remove(); markers.delete(hex); }

  // trail
  trailLine.setLatLngs(selected && live.has(selected) && !aircraft.find(a => a.hex === selected)?._w ? trails.get(selected) || [] : []);
  drawPaths(shown);

  // list
  shown.sort((a, b) => apt ? a._d - b._d : csOf(a).localeCompare(csOf(b)));
  const list = $('list');
  list.replaceChildren(...shown.slice(0, 250).map(ac => {
    const li = el('li', ac.hex === selected ? 'sel' : '');
    li.append(el('span', 'cs', csOf(ac) || ac.r || ac.hex.toUpperCase()));
    const c = ac._c;
    if (c) li.append(el('span', `badge ${c.dir}${c.sure ? '' : ' guess'}`,
      c.dir === 'gnd' ? 'on field' : (c.dir === 'in' ? 'inbound' : 'outbound') + (c.sure ? '' : ' ?')));
    else li.append(el('span'));
    const sub = el('div', 'sub');
    sub.append(el('span', '', [ac.t, ac.r, routeText(ac)].filter(Boolean).join(' · ') || '—'));
    sub.append(el('span', '', `${fmtAlt(ac)}${apt ? ` · ${ac._d.toFixed(0)} nm` : ''}`));
    li.append(sub);
    if (ac._w) li.append(el('div', 'sub when', timing(ac)));
    li.onclick = () => select(ac.hex, true);
    return li;
  }));

  const n = { in: 0, out: 0, gnd: 0 };
  for (const ac of aircraft) if (ac._c) n[ac._c.dir]++;
  $('count').textContent = watchInfo
    ? `${shown.length} live now · following ${watchInfo.tracked} airline flight numbers for ${apt.icao}, anywhere${watchInfo.history === "unavailable" ? " · earlier flight paths unavailable" : ""}`
    : `${shown.length} shown of ${nearbyCount} within ${S.range} nm` +
      (followedCount ? ` + ${followedCount} followed airline flight${followedCount > 1 ? 's' : ''}` : '') +
      (apt ? ` · ${apt.icao}: ${n.in} in, ${n.out} out, ${n.gnd} on field` : '');
  if (rangeRing) rangeRing.setStyle({ opacity: watchInfo ? 0 : .35 });
  if (watchInfo && !aircraft.length) list.append(el('li', 'muted', watchInfo.tracked
    ? "None of this airport's airline flights are on the move right now."
    : 'No airline routes are published for this airport. Untick "Airline flights only" to see nearby traffic.'));
  renderDetail();
}

function renderDetail() {
  const box = $('detail');
  const ac = aircraft.find(a => a.hex === selected);
  if (!ac) { box.hidden = true; return; }
  box.hidden = false;
  const h = el('h2', '', csOf(ac) || ac.r || ac.hex.toUpperCase());
  const x = el('button', '', '×'); x.title = 'Deselect'; x.onclick = () => select(null);
  h.append(x);
  const r = ac._w ? { airports: [ac._w.orig, ac._w.dest] } : routes.get(csOf(ac));
  const routeLine = el('div', 'muted', r && r.airports.length
    ? r.airports.map(a => `${a.location || a.name} (${a.iata || a.icao})`).join(' → ')
    : 'No published route for this callsign');
  if (ac._w) routeLine.append(el('div', 'when', timing(ac)));
  const dl = el('dl');
  const rows = [
    ['Type', ac.t || '—'], ['Reg', ac.r || '—'],
    ['Altitude', fmtAlt(ac)], ['Speed', ac.gs != null ? `${Math.round(ac.gs)} kt` : '—'],
    ['V/S', `${vsOf(ac) > 0 ? '+' : ''}${vsOf(ac)} fpm`], ['Track', `${Math.round(trackOf(ac))}°`],
    ['Squawk', ac.squawk || '—'], ['Hex', ac.hex.toUpperCase()],
  ];
  if (ac._w) rows.push(['To go', `${Math.round(ac._w.remaining)} nm`], ['Trip', `${Math.round(ac._w.legDist)} nm`]);
  for (const [k, v] of rows) dl.append(el('dt', '', k), el('dd', '', v));
  box.replaceChildren(h, routeLine, dl);
  if (ac.desc || ac.ownOp) box.append(el('div', 'muted', [ac.desc, ac.ownOp].filter(Boolean).join(' · ')));
}

function select(hex, pan) {
  selected = hex === selected ? null : hex;
  const ac = aircraft.find(a => a.hex === selected);
  if (ac && pan) map.panTo([ac.lat, ac.lon]);
  render();
}

// ---------- airport ----------
function drawAirport() {
  aptMarker?.remove(); rangeRing?.remove(); aptMarker = rangeRing = null;
  if (!apt) return;
  aptMarker = L.marker([apt.lat, apt.lon], {
    icon: L.divIcon({ className: '', html: '<div class="aptmark"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }),
    interactive: false, zIndexOffset: -500,
  }).addTo(map);
  rangeRing = L.circle([apt.lat, apt.lon], { radius: S.range * 1852, color: '#ffe14d', weight: 1, opacity: .35, fill: false, interactive: false, dashArray: '4 6' }).addTo(map);
}

async function setAirport(code, fit) {
  code = (code || '').trim().toUpperCase();
  tags.clear(); wasGroundAtApt.clear();
  if (!code) {
    apt = null; S.airport = ''; $('aptName').textContent = 'No airport — showing traffic around the map centre';
  } else {
    try {
      const res = await fetch('/api/airport/' + encodeURIComponent(code));
      if (res.status === 404) throw new Error(`Couldn't find airport "${code}" — try the 4-letter ICAO code`);
      if (!res.ok) throw new Error('Airport lookup failed — check your connection and press Go again');
      apt = await res.json();
      S.airport = apt.icao;
      $('aptName').textContent = `${apt.name}${apt.iata ? ` (${apt.iata})` : ''} — ${apt.location || ''}`;
    } catch (e) {
      $('aptName').textContent = e.message;
      return;
    }
  }
  $('airport').value = S.airport;
  persist(); drawAirport(); syncMode();
  needFit = watchMode();
  if (apt && fit) map.fitBounds(rangeRing.getBounds(), { animate: !needFit });
  aircraft = []; watchInfo = null; render(); poll();
}

function syncMode() {
  for (const b of $('mode').children) {
    b.classList.toggle('on', b.dataset.mode === (apt ? S.mode : 'all'));
    b.disabled = !apt && b.dataset.mode !== 'all';
  }
  $('airlines').disabled = !apt || S.mode === 'all';
  $('range').disabled = watchMode();
}

// ---------- wiring ----------
$('range').value = S.range; $('search').value = S.search; $('hideGround').checked = S.hideGround; $('selPaths').checked = S.selPaths; $('labels').value = S.labels;
$('altMin').value = S.altMin; $('altMax').value = S.altMax;
$('go').onclick = () => setAirport($('airport').value, true);
$('airport').onkeydown = e => { if (e.key === 'Enter') setAirport($('airport').value, true); };
const switchSource = () => { const was = !!watchInfo; persist(); syncMode(); if (was !== watchMode()) { aircraft = []; watchInfo = null; needFit = watchMode(); poll(); } render(); };
$('mode').onclick = e => { const m = e.target.dataset.mode; if (m) { S.mode = m; switchSource(); } };
$('airlines').checked = S.airlines;
$('airlines').onchange = e => { S.airlines = e.target.checked; switchSource(); };
$('search').oninput = e => { S.search = e.target.value.trim(); persist(); render(); };
$('hideGround').onchange = e => { S.hideGround = e.target.checked; persist(); render(); };
$('labels').onchange = e => setLabels(e.target.value);
$('selPaths').onchange = e => { S.selPaths = e.target.checked; persist(); render(); };
$('altMin').oninput = e => { S.altMin = e.target.value; persist(); render(); };
$('altMax').oninput = e => { S.altMax = e.target.value; persist(); render(); };
$('range').onchange = e => { S.range = +e.target.value; persist(); drawAirport(); if (apt) map.fitBounds(rangeRing.getBounds()); poll(); };
map.on('moveend', () => { if (!apt) poll(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

// filter panel starts collapsed on phones; the choice is remembered after that
if (S.collapsed == null) S.collapsed = matchMedia('(max-width: 760px)').matches;
function setCollapsed(c) {
  S.collapsed = c; persist();
  $('side').classList.toggle('collapsed', c);
  $('toggleFilters').setAttribute('aria-expanded', String(!c));
  renderSummary();
}
$('toggleFilters').onclick = () => setCollapsed(!S.collapsed);
setCollapsed(S.collapsed);

setAirport(S.airport, true);
setInterval(poll, POLL_MS);
