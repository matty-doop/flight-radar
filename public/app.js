'use strict';
const $ = id => document.getElementById(id);
const POLL_MS = 5000;
const COLORS = { in: '#3ddc84', out: '#ff9f43', other: '#7fb2ff', sel: '#ffe14d', gnd: '#9aa3ad' };

// ---------- persisted settings ----------
const saved = (() => { try { return JSON.parse(localStorage.getItem('fr') || '{}'); } catch { return {}; } })();
const S = Object.assign({ airport: 'KGEG', mode: 'both', range: 100, hideGround: false, airlines: true, collapsed: null, search: '', altMin: '', altMax: '' }, saved);
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
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18, className: 'tiles',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors | aircraft: adsb.lol',
}).addTo(map);
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
    if (!w) continue;
    const sel = ac.hex === selected, color = sel ? COLORS.sel : COLORS[w.dir] || COLORS.other;
    const here = [ac.lat, ac.lon];
    const trail = (w.trail || []).concat([here]);
    const dash = { color, weight: 2, opacity: sel ? .7 : .55, dashArray: '1 7', lineCap: 'round', interactive: false };
    pathLayer.addLayer(L.polyline(trail, { color, weight: sel ? 4.5 : 3.5, opacity: 1, interactive: false }));
    if (w.phase !== 'arrived') pathLayer.addLayer(L.polyline(gcLine(here, [w.dest.lat, w.dest.lon]), dash));
    for (const a of [w.orig, w.dest]) if (!apt || a.icao !== apt.icao) ends.set(a.icao, a);
  }
  for (const a of ends.values()) {
    pathLayer.addLayer(L.circleMarker([a.lat, a.lon], { radius: 4, color: '#cfd8e3', weight: 1.5, fillOpacity: .3, interactive: false })
      .bindTooltip(a.iata || a.icao, { permanent: true, direction: 'top', offset: [0, -4], className: 'cslabel' }));
  }
}

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

let polling = false;
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
      j.source = j.source || 'adsb.lol';
    } else {
      watchInfo = null;
      aircraft = j.ac.filter(a => a.lat != null && (a.seen_pos ?? 0) < 60);
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
      map.fitBounds(L.latLngBounds(aircraft.flatMap(a => [[a.lat, a.lon], [a._w.orig.lat, a._w.orig.lon], [a._w.dest.lat, a._w.dest.lon]])
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
function planeIcon(color, rot, big) {
  const s = big ? 30 : 22;
  return L.divIcon({
    className: '', iconSize: [s, s], iconAnchor: [s / 2, s / 2],
    html: `<svg class="plane" width="${s}" height="${s}" viewBox="0 0 24 24" style="transform:rotate(${rot}deg)">
      <path fill="${color}" stroke="#0b0e12" stroke-width=".8" d="M12 1.5c.9 0 1.5 1 1.5 2.4V9l8 4.6v2.1l-8-2.5v5l2.4 1.8v1.6L12 20.6l-3.9 1v-1.6l2.4-1.8v-5l-8 2.5v-2.1l8-4.6V3.9c0-1.4.6-2.4 1.5-2.4z"/></svg>`,
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
    const key = `${colorFor(ac)}|${Math.round(trackOf(ac) / 5) * 5}|${ac.hex === selected}`;
    let m = markers.get(ac.hex);
    if (!m) {
      m = L.marker([ac.lat, ac.lon], { icon: planeIcon(colorFor(ac), trackOf(ac), false), keyboard: false }).addTo(map);
      m.on('click', () => select(ac.hex));
      m._key = key;
      markers.set(ac.hex, m);
    } else {
      m.setLatLng([ac.lat, ac.lon]);
      if (m._key !== key) { m.setIcon(planeIcon(colorFor(ac), Math.round(trackOf(ac) / 5) * 5, ac.hex === selected)); m._key = key; }
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
$('range').value = S.range; $('search').value = S.search; $('hideGround').checked = S.hideGround;
$('altMin').value = S.altMin; $('altMax').value = S.altMax;
$('go').onclick = () => setAirport($('airport').value, true);
$('airport').onkeydown = e => { if (e.key === 'Enter') setAirport($('airport').value, true); };
const switchSource = () => { const was = !!watchInfo; persist(); syncMode(); if (was !== watchMode()) { aircraft = []; watchInfo = null; needFit = watchMode(); poll(); } render(); };
$('mode').onclick = e => { const m = e.target.dataset.mode; if (m) { S.mode = m; switchSource(); } };
$('airlines').checked = S.airlines;
$('airlines').onchange = e => { S.airlines = e.target.checked; switchSource(); };
$('search').oninput = e => { S.search = e.target.value.trim(); persist(); render(); };
$('hideGround').onchange = e => { S.hideGround = e.target.checked; persist(); render(); };
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
