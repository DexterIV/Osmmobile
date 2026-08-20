// Orto Review — review BDOT10k buildings and PRG addresses against the GUGiK
// orthophoto, one object at a time, and upload the good ones to OpenStreetMap.
// Copyright (C) 2026 DexterIV
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU General Public License as published by the Free Software
// Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see the GNU General Public
// License for more details: https://www.gnu.org/licenses/
//
// Source: https://github.com/DexterIV/Osmmobile

const R = 6378137;
const DEF = {
  apiBase: 'https://budynki.openstreetmap.org.pl',
  reportRejects: false,
  // The direct GUGiK endpoints, not the budynki proxy. Measured in a browser:
  // orto-high fetched 6/6 tiles with pixels readable, orto-std 3/6 readable,
  // and orto-proxy 0/6 — the proxy duplicates Access-Control-Allow-Origin on
  // exactly the responses that carry an image, so fetch can never obtain one.
  imagery: 'orto-high',
  customUrl: '',
  customLayers: '',
  tileTTLdays: 7,
  ctxTTLhours: 24,
  batchSize: 100,
  comment: 'Buildings and addresses from BDOT10k/PRG',
  source: 'BDOT10k;PRG',
  // Points at the source rather than a hashtag that says nothing.
  repo: 'https://github.com/DexterIV/Osmmobile',
  // Land cover is off until a server is set. Buildings never consult either.
  lcServer: '',
  lcOff: [],
  importTag: false,
  clientId: '',
  maxShift: 8,
  driftStep: 0.5,
  clearRadius: 50,
  dropKeys: [],
  // Set once the one-time move off orto-proxy has happened, so choosing it
  // again by hand is respected rather than silently undone on every launch.
  offProxy: false,
  // Set once the tile cache has been purged of bodies stored before the build
  // that started checking them for completeness. Same shape as offProxy: a
  // one-time migration that must not repeat on every launch.
  tilesChecked: false,
};

const PRESETS = {
  // Kept only so it can be re-tested if the header duplication is ever fixed
  // upstream. Tiles do draw through it, because a plain <img> performs no CORS
  // check, but nothing that needs fetch will work.
  'orto-proxy': {
    name: 'Ortophoto via budynki proxy (CORS broken)',
    url: 'https://budynki.openstreetmap.org.pl/orto',
    layers: 'Raster',
    attr: 'GUGiK / budynki.osm.org.pl',
  },
  'orto-std': {
    name: 'Ortophoto standard',
    url: 'https://mapy.geoportal.gov.pl/wss/service/PZGIK/ORTO/WMS/StandardResolution',
    layers: 'Raster',
    attr: 'GUGiK',
  },
  'orto-high': {
    name: 'Ortophoto high-res',
    url: 'https://mapy.geoportal.gov.pl/wss/service/PZGIK/ORTO/WMS/HighResolution',
    layers: 'Raster',
    attr: 'GUGiK',
  },
  'orto-archive': {
    name: 'Ortophoto (archival)',
    url: 'https://mapy.geoportal.gov.pl/wss/service/PZGIK/ORTO/WMS/StandardResolutionTime',
    layers: 'Raster',
    attr: 'GUGiK',
  },
  osm: { name: 'OSM Carto', xyz: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attr: 'OpenStreetMap' },
};

let S = Object.assign({}, DEF);
let wasm = null;
let db = null;
// 'unknown' until probeImagery says otherwise; 'blocked' once it has three
// independent signals that the source's CORS headers are unusable. Nothing on
// the per-tile path may set this — see probeImagery for why.
let pixelMode = 'unknown';

const $ = (id) => document.getElementById(id);
const fmt = (n, d = 1) => Number(n).toFixed(d);

function toast(msg, kind) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'show' + (kind ? ' ' + kind : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = ''), 3200);
}

function merc(lat, lon) {
  const x = (lon * Math.PI / 180) * R;
  const y = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * R;
  return [x, y];
}
function unmerc(x, y) {
  const lon = (x / R) * 180 / Math.PI;
  const lat = (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI;
  return [lat, lon];
}
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('ortoreview', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const s of ['kv', 'tiles', 'ctx', 'decisions', 'queue']) {
        if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function tx(store, mode) {
  return db.transaction(store, mode).objectStore(store);
}
function dbGet(store, key) {
  return new Promise((res, rej) => {
    const r = tx(store, 'readonly').get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function dbPut(store, key, val) {
  return new Promise((res, rej) => {
    const r = tx(store, 'readwrite').put(val, key);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });
}
function dbDel(store, key) {
  return new Promise((res) => {
    const r = tx(store, 'readwrite').delete(key);
    r.onsuccess = () => res();
    r.onerror = () => res();
  });
}
function dbAll(store) {
  return new Promise((res, rej) => {
    const out = [];
    const r = tx(store, 'readonly').openCursor();
    r.onsuccess = () => {
      const c = r.result;
      if (!c) return res(out);
      out.push({ key: c.key, val: c.value });
      c.continue();
    };
    r.onerror = () => rej(r.error);
  });
}
function dbClear(store) {
  return new Promise((res) => {
    const r = tx(store, 'readwrite').clear();
    r.onsuccess = () => res();
    r.onerror = () => res();
  });
}

// Deliberately a cursor rather than dbAll. dbAll accumulates every value it
// walks, so reading the timestamps off a week of cached tiles pulled every one of
// their blobs into JS memory — a boot-path spike of tens of megabytes on the one
// device where a killed tab is the likely outcome.
function dbEvict(store, maxAge, now) {
  return new Promise((res) => {
    let n = 0;
    const r = tx(store, 'readwrite').openCursor();
    r.onsuccess = () => {
      const c = r.result;
      if (!c) return res(n);
      const t = c.value && c.value.t;
      if (!t || now - t > maxAge) { c.delete(); n++; }
      c.continue();
    };
    r.onerror = () => res(n);
  });
}

async function evictExpired() {
  const now = Date.now();
  return await dbEvict('tiles', S.tileTTLdays * 86400e3, now) +
    await dbEvict('ctx', S.ctxTTLhours * 3600e3, now);
}

async function cacheStats() {
  const t = await dbAll('tiles');
  let bytes = 0;
  for (const e of t) bytes += e.val.blob ? e.val.blob.size : 0;
  const c = await dbAll('ctx');
  return { tiles: t.length, bytes, ctx: c.length };
}

async function initWasm() {
  const bin = Uint8Array.from(atob(WASM_B64), (c) => c.charCodeAt(0));
  const mod = await WebAssembly.instantiate(bin, {
    env: {
      abort: (m, f, l, c) => { throw new Error('wasm abort ' + l + ':' + c); },
      seed: () => Date.now(),
    },
  });
  wasm = mod.instance.exports;
}

const W = {
  bytes(str) {
    const enc = new TextEncoder().encode(str);
    const p = wasm.alloc(enc.length);
    new Uint8Array(wasm.memory.buffer, p, enc.length).set(enc);
    return [p, enc.length];
  },
  f64(arr) {
    const p = wasm.alloc(arr.length * 8);
    new Float64Array(wasm.memory.buffer, p, arr.length).set(arr);
    return p;
  },
  view64(ptr, n) { return new Float64Array(wasm.memory.buffer, ptr, n); },
  view32(ptr, n) { return new Int32Array(wasm.memory.buffer, ptr, n); },
};

let RAW = '';
let candidates = [];
let cursor = 0;
let ctxIndexReady = false;

function parseOsmXml(text) {
  RAW = text;
  const [p, len] = W.bytes(text);
  wasm.setSource(p, len);
  wasm.parse();
  const nc = wasm.nodeCount();
  const wc = wasm.wayCount();

  const nid = W.view64(wasm.ptrNodeId(), nc);
  const nlat = W.view64(wasm.ptrNodeLat(), nc);
  const nlon = W.view64(wasm.ptrNodeLon(), nc);
  const ntA = W.view32(wasm.ptrNodeTagA(), nc);
  const ntB = W.view32(wasm.ptrNodeTagB(), nc);
  const wA = W.view32(wasm.ptrWayNdA(), wc);
  const wN = W.view32(wasm.ptrWayNdN(), wc);
  const wtA = W.view32(wasm.ptrWayTagA(), wc);
  const wtB = W.view32(wasm.ptrWayTagB(), wc);
  const refs = W.view64(wasm.ptrRefs(), wasm.refsCount());

  const byId = new Map();
  for (let i = 0; i < nc; i++) byId.set(nid[i], i);

  const usedInWay = new Set();
  const out = [];

  // Resolve a way index to an open ring, or null.
  const ringOf = (i) => {
    const n = wN[i];
    if (n < 4) return null;
    const ring = [];
    for (let k = 0; k < n; k++) {
      const idx = byId.get(refs[wA[i] + k]);
      if (idx === undefined) return null;
      usedInWay.add(refs[wA[i] + k]);
      ring.push([nlat[idx], nlon[idx]]);
    }
    const a = ring[0], z = ring[ring.length - 1];
    if (a[0] === z[0] && a[1] === z[1]) ring.pop();
    return ring.length >= 3 ? ring : null;
  };

  // Way id -> way index, needed to resolve relation members. The scanner does
  // not keep way ids, and teaching it to would mean touching the growth path
  // that has bitten this project before, so the ids are read from the source in
  // document order — which is the order the scanner appends them. The count is
  // checked rather than assumed: on any mismatch relations are skipped entirely,
  // because a mis-resolved member would silently attach the wrong hole to the
  // wrong field.
  const wayIdx = new Map();
  let wayOrderOk = true;
  {
    let i = 0;
    for (const m of RAW.matchAll(WAY_ID_RE)) {
      if (i < wc) wayIdx.set(Number(m[1]), i);
      i++;
    }
    if (i !== wc) {
      wayOrderOk = false;
      console.warn('way id scan found ' + i + ' ways, wasm found ' + wc + ' — skipping relations');
    }
  }

  // Relations, parsed in JS. The wasm scanner only knows nodes and ways, and a
  // land-cover file holds a handful of relations against thousands of nodes, so
  // a regex pass costs nothing and beats teaching the scanner a third element.
  //
  // This matters more than it looks: without it a forest-island-in-farmland
  // arrives as two unrelated solid rings, and accepting the farmland uploads it
  // straight over the forest. That is the exact failure the importer's own notes
  // warn about, and the parser used to walk into it.
  const consumedWays = new Set();
  for (const m of (wayOrderOk ? RAW.matchAll(REL_RE) : [])) {
    const body = m[0];
    const tags = tagsIn(m.index, m.index + body.length);
    if (tags.type !== 'multipolygon') continue;
    const outers = [], inners = [];
    for (const mm of body.matchAll(MEMBER_RE)) {
      if (mm[1] !== 'way') continue;
      const idx = wayIdx.get(Number(mm[2]));
      if (idx === undefined) continue;
      (mm[3] === 'inner' ? inners : outers).push(idx);
      consumedWays.add(idx);
    }
    delete tags.type;
    // One candidate per outer ring; every inner ring is carried as a hole.
    // Multiple outers in one relation are rare here, and treating each as its
    // own reviewable area is more useful than refusing the whole relation.
    const holes = inners.map(ringOf).filter(Boolean);
    for (const oi of outers) {
      const ring = ringOf(oi);
      if (!ring) continue;
      out.push({ kind: areaKind(tags), ring, holes, tags: Object.assign({}, tags) });
    }
  }

  for (let i = 0; i < wc; i++) {
    if (consumedWays.has(i)) continue;
    const tags = tagsIn(wtA[i], wtB[i]);
    // Untagged closed ways used to become candidates with no tags at all. In a
    // land-cover file those are the inner rings of a multipolygon, and reviewing
    // them as objects in their own right is meaningless.
    if (!Object.keys(tags).length) continue;
    const ring = ringOf(i);
    if (!ring) continue;
    out.push({ kind: areaKind(tags), ring, tags });
  }

  for (let i = 0; i < nc; i++) {
    if (ntB[i] <= ntA[i]) continue;
    if (usedInWay.has(nid[i])) continue;
    const tags = tagsIn(ntA[i], ntB[i]);
    if (!Object.keys(tags).length) continue;
    out.push({ kind: 'address', ring: [[nlat[i], nlon[i]]], tags });
  }

  wasm.release(p);
  return out;
}

const REL_RE = /<relation\b[\s\S]*?<\/relation>/g;
const WAY_ID_RE = /<way\s+id="(-?\d+)"/g;
const MEMBER_RE = /<member\s+type="([^"]*)"\s+ref="(-?\d+)"\s+role="([^"]*)"/g;

// Land cover is reviewed as `area`, not `building`: auto-fit correlates Sobel
// edges of a building outline against imagery and is meaningless on a field, and
// dragging the vertices of a 200-point parcel is not a thing anyone wants to do
// on a phone. Buildings keep their own kind so that path is untouched.
const AREA_KEYS = ['landuse', 'natural', 'leisure', 'surface', 'crop'];

function areaKind(tags) {
  if (tags.building) return 'building';
  for (const k of AREA_KEYS) if (tags[k]) return 'area';
  return 'building';
}

const TAG_RE = /<tag\s+k=(["'])(.*?)\1\s+v=(["'])([\s\S]*?)\3\s*\/?>/g;
function tagsIn(a, b) {
  if (b <= a) return {};
  const slice = RAW.slice(a, b);
  const t = {};
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(slice))) t[unesc(m[2])] = unesc(m[4]);
  return t;
}
function unesc(s) {
  return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function parseGeoJson(text) {
  const gj = JSON.parse(text);
  const feats = gj.type === 'FeatureCollection' ? gj.features : [gj];
  const out = [];
  for (const f of feats) {
    if (!f.geometry) continue;
    // tagsOf, not a copy of properties: /sc/* wraps the OSM tags in
    // properties.tags beside an id, so copying properties wholesale produced a
    // tag literally called "tags" and lost the id that decisions key on.
    const tags = tagsOf(f.properties);
    const srcId = f.properties && f.properties.id;
    if (f.geometry.type === 'Point') {
      out.push({
        kind: 'address',
        ring: [[f.geometry.coordinates[1], f.geometry.coordinates[0]]],
        tags, srcId,
      });
      continue;
    }
    for (const r of ringsOf(f.geometry)) {
      const ring = r.map(([x, y]) => [y, x]);
      const a = ring[0], z = ring[ring.length - 1];
      if (a && z && a[0] === z[0] && a[1] === z[1]) ring.pop();
      if (ring.length < 3) continue;
      out.push({ kind: 'building', ring, tags: Object.assign({}, tags), srcId });
    }
  }
  return out;
}

function centroid(ring) {
  if (ring.length === 1) return ring[0].slice();
  const la0 = ring[0][0], lo0 = ring[0][1];
  const p = W.f64(ring.flatMap(([la, lo]) => [lo - lo0, la - la0]));
  wasm.ringCentroid(p, ring.length);
  const lon = lo0 + wasm.outFA(), lat = la0 + wasm.outFB();
  wasm.release(p);
  return [lat, lon];
}

function bboxOf(list) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const c of list) {
    for (const [la, lo] of c.ring) {
      if (la < s) s = la; if (la > n) n = la;
      if (lo < w) w = lo; if (lo > e) e = lo;
    }
  }
  return [s, w, n, e];
}

function apiBase() { return (S.apiBase || DEF.apiBase).replace(/\/+$/, ''); }

function tagsOf(props) {
  if (!props) return {};
  if (props.tags && typeof props.tags === 'object') return Object.assign({}, props.tags);
  const t = Object.assign({}, props);
  delete t.id;
  return t;
}

function ringsOf(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates[0]];
  if (geom.type === 'MultiPolygon') return geom.coordinates.map((p) => p[0]);
  return [];
}

function classify(err) {
  const m = String(err && err.message || err);
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) {
    return 'blocked or offline (CSP, CORS, DNS or no network — the browser will not say which)';
  }
  return m;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Jittered exponential backoff. The jitter matters because a screenful of
// tiles fails at the same instant, and unjittered retries would march in
// lockstep and hammer the server in synchronised bursts.
function backoff(attempt, base = 400, cap = 8000) {
  return Math.min(cap, base * 2 ** (attempt - 1)) * (0.7 + Math.random() * 0.6);
}

// A 4xx is a real answer and stands. Only transient conditions are retried.
const transient = (status) => status === 429 || (status >= 500 && status < 600);

// The budynki /orto proxy is measured returning 404 on roughly half of all
// GetMap requests, transiently — the identical URL succeeds on retry. So for
// imagery, and only for imagery, a 404 is treated as transient too. It stays
// definitive for /sc/* and friends, where a 404 means the route is genuinely
// absent and retrying would only hide a real misconfiguration.
const transientImagery = (status) => transient(status) || status === 404;

// Every network path goes through this: bounded timeout plus retries.
// Rejects with an Error carrying .kind ('network' | 'timeout' | 'http') so
// callers can tell a missing CORS header from a slow mobile connection —
// they are indistinguishable in the raw fetch rejection, and conflating
// them is what previously disabled auto-fit on a passing network blip.
//
// onAttempt receives (attempt, message, kind) for every FAILED attempt, because
// only the last attempt's kind survives into the thrown error. That loses real
// information on a source that fails two different ways: the budynki proxy answers
// 404 to about half its GetMaps and duplicates its CORS headers on the other half,
// so a probe that only reads err.kind sees whichever came last and cannot tell
// that a CORS rejection happened at all.
async function fetchRetry(url, opts = {}) {
  const { tries = 3, timeout = 15000, onAttempt, retryOn = transient, ...init } = opts;
  let last = null;
  for (let i = 1; i <= tries; i++) {
    if (i > 1) await sleep(Math.max(backoff(i - 1), last && last.after || 0));
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeout);
    try {
      const r = await fetch(url, Object.assign({}, init, { signal: ac.signal }));
      if (retryOn(r.status) && i < tries) {
        const ra = Number(r.headers.get('retry-after'));
        last = { msg: 'HTTP ' + r.status, kind: 'http', after: ra > 0 ? Math.min(ra * 1000, 10000) : 0 };
        if (onAttempt) onAttempt(i, last.msg, last.kind);
        continue;
      }
      r.attempts = i;
      return r;
    } catch (err) {
      last = timedOut
        ? { msg: 'timeout after ' + timeout + 'ms', kind: 'timeout' }
        : { msg: classify(err), kind: 'network' };
      if (onAttempt) onAttempt(i, last.msg, last.kind);
    } finally {
      clearTimeout(timer);
    }
  }
  const e = new Error(last ? last.msg : 'failed');
  e.kind = last ? last.kind : 'network';
  e.attempts = tries;
  throw e;
}

// Same contract as fetchRetry but throws on a non-ok status too.
async function fetchOk(url, opts) {
  const r = await fetchRetry(url, opts);
  if (!r.ok) {
    const e = new Error('HTTP ' + r.status);
    e.kind = 'http';
    e.attempts = r.attempts;
    throw e;
  }
  return r;
}

// A cors fetch that fails tells you nothing on its own: offline, DNS, CSP and
// a malformed Access-Control-Allow-Origin all arrive as the same TypeError.
// A no-cors fetch skips CORS enforcement entirely, so if that one resolves the
// server was reached and answered, and the fault is in its CORS headers.
// Measured against budynki: /sc/* sends the header twice ('*, *') and
// /josm_data and /random/ omit it, so this is the common case, not a corner.
async function corsOrNetwork(url) {
  try {
    await fetch(url, { mode: 'no-cors', cache: 'no-store' });
    return 'server answered, but the browser rejected its CORS headers — ' +
      'likely duplicated or missing Access-Control-Allow-Origin. ' +
      'The exact reason is in the browser console.';
  } catch (_) {
    return 'unreachable — offline, DNS, or blocked before the request left';
  }
}

function markPixelsBlocked(why) {
  if (pixelMode === 'blocked') return;
  pixelMode = 'blocked';
  const b = $('autoBtn');
  b.disabled = true;
  b.title = 'Auto-fit unavailable: ' + why;
  toast('Imagery pixels are not readable (' + why + '). Use the drift pad.', 'warn');
}

// Called whenever the imagery source changes. Without this a single bad
// source left auto-fit disabled for the rest of the session even after
// switching to one that does send CORS headers.
function resetPixelMode() {
  pixelMode = 'unknown';
  const b = $('autoBtn');
  if (b) { b.disabled = false; b.title = ''; }
}

function envReport() {
  const framed = window.self !== window.top;
  const host = location.hostname || '(none)';
  const sandboxed = framed || !host || host === 'localhost' && location.protocol === 'file:';
  return {
    origin: location.origin || '(opaque)',
    host, protocol: location.protocol, framed,
    secure: window.isSecureContext, sandboxed,
  };
}

async function diagnose() {
  const base = apiBase();
  const out = [];
  const e = envReport();
  // First line, because "which build am I actually running" turned out to be
  // the hardest question to answer while chasing a stale service worker.
  out.push('build       ' + (typeof BUILD_ID === 'string' ? BUILD_ID : '(dev)') +
    '   imagery: ' + S.imagery);
  out.push('origin      ' + e.origin);
  out.push('secure ctx  ' + e.secure + '   in iframe: ' + e.framed);
  if (e.framed) {
    out.push('');
    out.push('!! Running inside an iframe. If this is a preview sandbox its');
    out.push('   CSP will block every outbound request below. Deploy the file');
    out.push('   to a real https origin and open it directly.');
  }
  out.push('');

  const line = (s) => {
    out.push(s);
    $('diagOut').textContent = out.join('\n');
  };

  const probe = async (label, url, check, opts) => {
    const t0 = performance.now();
    const notes = [];
    const o = Object.assign({ tries: 3, timeout: 15000 }, opts);
    o.onAttempt = (n, msg) => notes.push('try ' + n + ': ' + msg);
    const ms = () => (performance.now() - t0).toFixed(0) + 'ms';
    try {
      const r = await fetchRetry(url, o);
      // Retries that eventually succeeded are the interesting case: the
      // endpoint works but is flaky, which reads as "broken" without this.
      const tail = '  ' + ms() + (r.attempts > 1 ? '  (recovered on try ' + r.attempts + ')' : '');
      if (!r.ok) { line(label.padEnd(12) + 'HTTP ' + r.status + tail); }
      else { line(label.padEnd(12) + (check ? await check(r) : 'ok') + tail); }
    } catch (err) {
      line(label.padEnd(12) + 'FAIL [' + (err.kind || '?') + '] ' + err.message +
        '  ' + ms() + '  after ' + (err.attempts || 1) + ' tries');
      // Separate "your phone has no signal" from "this endpoint's headers are
      // wrong", which the raw rejection cannot distinguish.
      if (err.kind === 'network') line('            → ' + await corsOrNetwork(url));
    }
    for (const n of notes) line('            · ' + n);
  };

  await probe('random', base + '/random/', async (r) => {
    const j = await r.json();
    return 'ok  lat=' + Number(j.lat).toFixed(3) + ' lon=' + Number(j.lon).toFixed(3);
  });
  await probe('layers', base + '/layers/', async (r) => {
    const j = await r.json();
    return 'ok  ' + Object.keys(j.available_layers || {}).length + ' layers';
  });
  const q = 'xmin=21.00&ymin=52.20&xmax=21.02&ymax=52.22';
  await probe('sc/build', base + '/sc/proposed_buildings?' + q, async (r) => {
    const j = await r.json();
    return 'ok  ' + (j.features || []).length + ' features';
  });
  await probe('sc/addr', base + '/sc/proposed_addresses?' + q, async (r) => {
    const j = await r.json();
    return 'ok  ' + (j.features || []).length + ' features';
  });
  await probe('josm_data', base + '/josm_data?filter_by=bbox&layers=addresses_to_import,buildings_to_import&' + q,
    async (r) => 'ok  ' + ((await r.text()).length / 1024).toFixed(0) + ' KB xml',
    { tries: 2, timeout: 45000 });
  await probe('overpass', 'https://overpass-api.de/api/interpreter?data=' +
    encodeURIComponent('[out:json][timeout:10];node(52.20,21.00,52.201,21.001);out count;'),
    async (r) => { await r.json(); return 'ok'; },
    { tries: 3, timeout: 30000 });

  const src = imagerySource();
  if (!src.xyz) {
    const u = imageryProbeUrl(src);
    await probe('imagery', u, async (r) => {
      const b = await r.blob();
      try {
        const bmp = await createImageBitmap(b);
        const cv = document.createElement('canvas');
        cv.width = cv.height = 32;
        const g = cv.getContext('2d', { willReadFrequently: true });
        g.drawImage(bmp, 0, 0);
        g.getImageData(0, 0, 1, 1);
        return 'ok  ' + (b.size / 1024).toFixed(1) + ' KB, pixels readable (auto-fit will work)';
      } catch (err) {
        return 'image ok but pixels blocked — auto-fit disabled';
      }
    }, { mode: 'cors', tries: 4, timeout: 25000, retryOn: transientImagery });

    // If the cors fetch above failed we cannot tell "no CORS header" from
    // "server unreachable". A plain <img> ignores CORS entirely, so it
    // separates the two: img ok + fetch failed = missing headers, meaning
    // tiles will still draw but auto-fit and the tile cache cannot work.
    // imgLoads, not a hand-rolled Image: its timeout aborts by pointing src at a
    // 1x1 gif, where `t.src = ''` left the request in flight for the full 25 s.
    const imgOk = await imgLoads(u, 25000);
    line('imagery<img> '.padEnd(12) + (imgOk
      ? 'ok — tiles will draw (if the fetch above failed, headers are missing)'
      : 'FAIL — the imagery endpoint itself is unreachable'));
  }

  // What a real screenful actually cost, rather than what the constants imply.
  line('tiles'.padEnd(12) + tileStatsLine());
  $('diagOut').textContent = out.join('\n');
  $('diagOut').style.display = 'block';
}

// fetchArea, which read /sc/proposed_buildings and /sc/proposed_addresses with a
// /josm_data fallback, has been removed. Every one of those paths is unreadable
// from a browser — /sc/* sends Access-Control-Allow-Origin twice on every single
// request, /josm_data sends none — so it could only ever fail, and keeping it
// meant "Load this area" always failed too. Vector tiles replace it below.
// Diagnostics still probes those endpoints, which is where to look if the
// upstream headers are ever fixed.

// ---- Mapbox Vector Tiles ---------------------------------------------------
// /sc/* and /josm_data cannot be read from a browser: the first sends
// Access-Control-Allow-Origin twice, the second not at all. /tiles/{z}/{x}/{y}.pbf
// sends it exactly once, so it is the one candidate source that works in-app,
// and it carries the same BDOT10k geometry with OSM-ready tags. Decoded by hand
// because the build inlines everything into a single file.
//
// Only the subset the buildings layers use: layers, features, string and numeric
// values, and MoveTo/LineTo/ClosePath geometry.

const TILE_DATA_Z = 14;   // deepest zoom served, and so the finest geometry
const CLUSTER_Z = 6;      // buildings_clustered, for finding somewhere busy
const POLAND = [[49.0, 14.1], [54.9, 24.2]];
const TD = new TextDecoder();

function pbVarint(r) {
  let shift = 0, out = 0, byte;
  do {
    byte = r.b[r.p++];
    // Multiplied rather than shifted: ids exceed 32 bits and << would wrap.
    out += (byte & 0x7f) * (shift ? Math.pow(2, shift) : 1);
    shift += 7;
  } while (byte & 0x80);
  return out;
}
const pbZigzag = (n) => (n >>> 1) ^ -(n & 1);

function pbSkip(r, wire) {
  if (wire === 0) pbVarint(r);
  else if (wire === 1) r.p += 8;
  else if (wire === 2) r.p += pbVarint(r);
  else if (wire === 5) r.p += 4;
  else throw new Error('mvt: unknown wire type ' + wire);
}

function mvtDecode(bytes) {
  const r = { b: bytes, p: 0 };
  const layers = {};
  while (r.p < bytes.length) {
    const key = pbVarint(r), field = key >> 3, wire = key & 7;
    if (field === 3 && wire === 2) {
      const len = pbVarint(r);
      const L = mvtLayer(bytes.subarray(r.p, r.p + len));
      r.p += len;
      if (L.name) layers[L.name] = L;
    } else pbSkip(r, wire);
  }
  return layers;
}

function mvtLayer(bytes) {
  const r = { b: bytes, p: 0 };
  const out = { name: '', extent: 4096, keys: [], values: [], features: [] };
  while (r.p < bytes.length) {
    const key = pbVarint(r), field = key >> 3, wire = key & 7;
    if (field === 5 && wire === 0) { out.extent = pbVarint(r); continue; }
    if (wire !== 2) { pbSkip(r, wire); continue; }
    const len = pbVarint(r);
    const sub = bytes.subarray(r.p, r.p + len);
    r.p += len;
    if (field === 1) out.name = TD.decode(sub);
    else if (field === 2) out.features.push(sub);
    else if (field === 3) out.keys.push(TD.decode(sub));
    else if (field === 4) out.values.push(mvtValue(sub));
  }
  return out;
}

function mvtValue(bytes) {
  const r = { b: bytes, p: 0 };
  let v = null;
  const dv = () => new DataView(bytes.buffer, bytes.byteOffset + r.p);
  while (r.p < bytes.length) {
    const key = pbVarint(r), field = key >> 3, wire = key & 7;
    if (field === 1 && wire === 2) {
      const n = pbVarint(r);
      v = TD.decode(bytes.subarray(r.p, r.p + n));
      r.p += n;
    } else if (field === 2 && wire === 5) { v = dv().getFloat32(0, true); r.p += 4; }
    else if (field === 3 && wire === 1) { v = dv().getFloat64(0, true); r.p += 8; }
    else if ((field === 4 || field === 5) && wire === 0) v = pbVarint(r);
    else if (field === 6 && wire === 0) v = pbZigzag(pbVarint(r));
    else if (field === 7 && wire === 0) v = pbVarint(r) !== 0;
    else pbSkip(r, wire);
  }
  return v;
}

function mvtFeature(bytes, layer) {
  const r = { b: bytes, p: 0 };
  let type = 0, geom = null;
  const tags = [];
  while (r.p < bytes.length) {
    const key = pbVarint(r), field = key >> 3, wire = key & 7;
    if (field === 3 && wire === 0) { type = pbVarint(r); continue; }
    if (wire !== 2) { pbSkip(r, wire); continue; }
    const len = pbVarint(r);
    const sub = bytes.subarray(r.p, r.p + len);
    r.p += len;
    if (field === 2) { const rr = { b: sub, p: 0 }; while (rr.p < sub.length) tags.push(pbVarint(rr)); }
    else if (field === 4) geom = sub;
  }
  const props = {};
  for (let i = 0; i + 1 < tags.length; i += 2) {
    const k = layer.keys[tags[i]], v = layer.values[tags[i + 1]];
    if (k !== undefined && v !== undefined) props[k] = v;
  }
  return { type, props, rings: geom ? mvtRings(geom) : [] };
}

function mvtRings(g) {
  const r = { b: g, p: 0 };
  const rings = [];
  let cur = null, x = 0, y = 0;
  while (r.p < g.length) {
    const cmd = pbVarint(r), id = cmd & 7, count = cmd >> 3;
    if (id === 1) {
      for (let i = 0; i < count; i++) {
        x += pbZigzag(pbVarint(r)); y += pbZigzag(pbVarint(r));
        if (cur && cur.length) rings.push(cur);
        cur = [[x, y]];
      }
    } else if (id === 2) {
      for (let i = 0; i < count; i++) {
        x += pbZigzag(pbVarint(r)); y += pbZigzag(pbVarint(r));
        if (cur) cur.push([x, y]);
      }
    } else if (id === 7) {
      if (cur && cur.length) { rings.push(cur); cur = null; }
    } else break;
  }
  if (cur && cur.length) rings.push(cur);
  return rings;
}

function tileXY(lat, lon, z) {
  const n = Math.pow(2, z);
  const rad = lat * Math.PI / 180;
  return [
    Math.floor((lon + 180) / 360 * n),
    Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n),
  ];
}

function tilePointToLatLon(z, tx, ty, px, py, extent) {
  const n = Math.pow(2, z);
  const lon = (tx + px / extent) / n * 360 - 180;
  const yy = 1 - 2 * (ty + py / extent) / n;
  return [Math.atan(Math.sinh(Math.PI * yy)) * 180 / Math.PI, lon];
}

function tilesCovering(b, z) {
  const [x0, y0] = tileXY(b.getNorth(), b.getWest(), z);
  const [x1, y1] = tileXY(b.getSouth(), b.getEast(), z);
  const out = [];
  for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) out.push([x, y]);
  }
  return out;
}

// Tile geometry is quantised to the extent grid, so report the resulting
// resolution honestly rather than implying the outlines are exact.
function tileQuantCm(lat, z) {
  return (40075017 * Math.cos(lat * Math.PI / 180) / Math.pow(2, z) / 4096) * 100;
}

const TILE_TAGS = ['building', 'amenity', 'man_made', 'leisure', 'historic', 'tourism'];

// The tile carries BDOT metadata beside the OSM tags; only the latter may go up.
// Matches what /josm_data emits for the same object: building, building:levels,
// source:building=BDOT.
function tagsFromTile(p) {
  const t = {};
  for (const k of TILE_TAGS) {
    if (p[k] !== undefined && p[k] !== null && p[k] !== '') t[k] = String(p[k]);
  }
  if (p.building_levels !== undefined && p.building_levels !== null && p.building_levels !== '') {
    t['building:levels'] = String(p.building_levels);
  }
  if (!t.building) t.building = 'yes';
  t['source:building'] = 'BDOT';
  return t;
}

function ringSignedArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  }
  return a / 2;
}

async function tileBytes(z, x, y, tries) {
  const r = await fetchOk(apiBase() + '/tiles/' + z + '/' + x + '/' + y + '.pbf',
    { tries: tries || 3, timeout: 20000 });
  return new Uint8Array(await r.arrayBuffer());
}

// Buildings for an area, straight from the vector tiles. Addresses are not
// available this way: the served pyramid is buildings_clustered (z<=10),
// buildings_centroids (z11-12) and buildings (z13-14) — the address layers the
// upstream style references are not generated, checked across 40 tiles in ten
// cities. Addresses still need the file or paste route.
async function fetchAreaTiles(bounds) {
  const tiles = tilesCovering(bounds, TILE_DATA_Z);
  const got = await Promise.all(tiles.map(async ([x, y]) => {
    try {
      const buf = await tileBytes(TILE_DATA_Z, x, y);
      return { x, y, layers: buf.length ? mvtDecode(buf) : {} };
    } catch (err) { return { x, y, err }; }
  }));

  let failed = 0, clipped = 0;
  const best = new Map();
  for (const t of got) {
    if (t.err) { failed++; continue; }
    const L = t.layers.buildings;
    if (!L) continue;
    for (const fb of L.features) {
      const f = mvtFeature(fb, L);
      if (f.type !== 3) continue;
      for (const ring of f.rings) {
        if (ring.length < 3) continue;
        // Exterior rings wind positive in tile coordinates; the rest are holes.
        if (ringSignedArea(ring) <= 0) continue;
        const cut = ring.some(([px, py]) =>
          px <= 0 || py <= 0 || px >= L.extent || py >= L.extent);
        const id = f.props.lokalnyid;
        const key = id || t.x + '/' + t.y + '/' + ring[0][0] + ',' + ring[0][1];
        const prev = best.get(key);
        if (prev) {
          // A polygon crossing a tile edge is clipped in one tile and whole in
          // its neighbour, so always prefer the uncut copy.
          const better = (!cut && prev.cut) ||
            (cut === prev.cut && ring.length > prev.ring.length);
          if (!better) continue;
        }
        best.set(key, {
          cut,
          kind: 'building',
          ring: ring.map(([px, py]) => tilePointToLatLon(TILE_DATA_Z, t.x, t.y, px, py, L.extent)),
          tags: tagsFromTile(f.props),
          srcId: id,
          // Provenance, kept off the uploaded tags but shown while reviewing.
          // BDOT10k geometry is frequently years old — measured across 644
          // buildings, a third dated from 2015 — which is why a demolished
          // building can still be in the data.
          srcDate: f.props.aktualnosc_geometrii ? String(f.props.aktualnosc_geometrii) : '',
          srcStatus: f.props.status_bdot ? String(f.props.status_bdot) : '',
        });
      }
    }
  }

  const out = [];
  for (const c of best.values()) {
    // A still-clipped outline is the wrong shape, and uploading it would be
    // worse than not having it. Those are reachable through the file route.
    if (c.cut) { clipped++; continue; }
    delete c.cut;
    out.push(c);
  }
  return { list: out, failed, clipped, tiles: tiles.length };
}

// Weighted pick from buildings_clustered, replacing the dead /random/. One z6
// tile is about 110 KB and covers a large slice of Poland, so it is fetched one
// at a time and cached rather than pulling the whole country.
async function clusterJump() {
  const order = tilesCovering(L.latLngBounds(POLAND[0], POLAND[1]), CLUSTER_Z);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = order[i]; order[i] = order[j]; order[j] = t;
  }
  for (const [x, y] of order.slice(0, 3)) {
    const ck = 'clusters/' + CLUSTER_Z + '/' + x + '/' + y;
    let buf = null;
    const hit = await dbGet('ctx', ck).catch(() => null);
    if (hit && hit.buf && Date.now() - hit.t < S.ctxTTLhours * 3600e3) {
      buf = new Uint8Array(hit.buf);
    } else {
      try {
        buf = await tileBytes(CLUSTER_Z, x, y, 2);
        dbPut('ctx', ck, { t: Date.now(), buf: buf.buffer }).catch(() => {});
      } catch (err) { continue; }
    }
    if (!buf.length) continue;
    const L = mvtDecode(buf).buildings_clustered;
    if (!L || !L.features.length) continue;
    const picks = [];
    let total = 0;
    for (const fb of L.features) {
      const f = mvtFeature(fb, L);
      if (!f.rings.length || !f.rings[0].length) continue;
      const w = Math.max(1, Number(f.props.no_of_points) || 1);
      total += w;
      picks.push({ w, pt: f.rings[0][0] });
    }
    if (!picks.length) continue;
    let r = Math.random() * total;
    let chosen = picks[picks.length - 1];
    for (const p of picks) { r -= p.w; if (r <= 0) { chosen = p; break; } }
    return tilePointToLatLon(CLUSTER_Z, x, y, chosen.pt[0], chosen.pt[1], L.extent);
  }
  return null;
}

async function loadArea() {
  if (areaTooBig()) return;
  const b = dataBounds();
  setStage('Fetching candidates');
  try {
    const res = await fetchAreaTiles(b);
    if (!res.list.length) {
      setStage('');
      const why = res.failed === res.tiles
        ? 'Could not reach the tile server (' + res.failed + '/' + res.tiles + ' tiles failed)'
        : 'No buildings left to import within ' + spanKm(b) + ' km of here';
      toast(why + '. Addresses need “Get this area\'s data”.', res.failed ? 'warn' : undefined);
      if (!res.failed) $('start').classList.add('expanded');
      return;
    }
    const q = tileQuantCm(b.getCenter().lat, TILE_DATA_Z).toFixed(0);
    const notes = [];
    if (res.clipped) notes.push(res.clipped + ' cut by tile edges, skipped');
    if (res.failed) notes.push(res.failed + ' of ' + res.tiles + ' tiles failed');
    await ingest(res.list, res.list.length + ' buildings (±' + q + ' cm from tiles)' +
      (notes.length ? ' · ' + notes.join(' · ') : ''));
  } catch (err) {
    setStage('');
    toast('Could not load tiles: ' + classify(err), 'warn');
  }
}

// /random/ is not used: it answers 500 on every request and its error page
// carries no CORS header, so a browser sees only an opaque network failure.
// buildings_clustered gives the same "somewhere with work" answer, weighted by
// how much work is there, from a tile that the browser is allowed to read.
// quiet is for the automatic attempt at boot, so a fresh launch does not open
// with a warning if the tile server happens to be unreachable.
async function loadRandom(quiet) {
  setStage('Finding somewhere with work');
  try {
    const p = await clusterJump();
    if (!p) throw new Error('no clusters returned');
    map.setView(p, TILE_DATA_Z, { animate: false });
    await loadArea();
  } catch (err) {
    setStage('');
    if (quiet) return;
    toast('Could not find an area: ' + classify(err), 'warn');
  }
}

// Candidates are sparse, so a small bbox legitimately returns nothing at all —
// measured against /josm_data, a z18 viewport (~150 m) and even a z16 one come
// back as a bare `<osm version="0.6"/>`, 20 bytes, while 0.024° yields 56 nodes.
// Every data request is therefore widened to at least this span about the centre
// of the view, so neither route can hand back an empty result that looks like a
// server fault.
const MIN_DATA_SPAN = 0.03;

function dataBounds() {
  const b = map.getBounds();
  const c = b.getCenter();
  const halfLat = Math.max((b.getNorth() - b.getSouth()) / 2, MIN_DATA_SPAN / 2);
  const halfLon = Math.max((b.getEast() - b.getWest()) / 2, MIN_DATA_SPAN / 2);
  return L.latLngBounds([c.lat - halfLat, c.lng - halfLon], [c.lat + halfLat, c.lng + halfLon]);
}

function bboxQuery(b) {
  return 'xmin=' + b.getWest().toFixed(6) + '&ymin=' + b.getSouth().toFixed(6) +
    '&xmax=' + b.getEast().toFixed(6) + '&ymax=' + b.getNorth().toFixed(6);
}

// A browser *navigation* to this is not subject to CORS, which is why the
// download route works where fetch cannot: /josm_data sends no
// Access-Control-Allow-Origin at all.
function areaDataUrl() {
  return apiBase() + '/josm_data?filter_by=bbox' +
    '&layers=addresses_to_import,buildings_to_import&' + bboxQuery(dataBounds());
}

// Judged on the widened bounds, since those are what actually gets requested.
// There is no zoom test: span is the constraint the server cares about, and a
// zoom floor rejected legal requests from a short window.
function areaTooBig() {
  const b = dataBounds();
  const span = Math.max(b.getNorth() - b.getSouth(), b.getEast() - b.getWest());
  if (span > 0.2) {
    toast('Zoom in a bit — that area is too big to fetch', 'warn');
    return true;
  }
  return false;
}

// Rough N–S extent of the request, for telling the user what was asked for.
function spanKm(b) {
  return ((b.getNorth() - b.getSouth()) * 111.32).toFixed(1);
}

async function loadText(text, label) {
  setStage('Parsing ' + label);
  const t0 = performance.now();
  let list;
  try {
    list = /^\s*\{/.test(text) ? parseGeoJson(text) : parseOsmXml(text);
  } catch (err) {
    setStage('');
    toast('Could not parse ' + label + ': ' + (err.message || err), 'warn');
    return;
  }
  if (!list.length) {
    setStage('');
    toast('No candidates found in ' + label + ' — wrong file, or nothing left here', 'warn');
    return;
  }
  await ingest(list, list.length + ' candidates in ' + fmt(performance.now() - t0, 0) + ' ms');
}

async function loadFile(file) {
  await loadText(await file.text(), file.name);
}

async function loadPasted() {
  let text = ($('pasteBox').value || '').trim();
  if (!text && navigator.clipboard && navigator.clipboard.readText) {
    text = (await navigator.clipboard.readText().catch(() => '')).trim();
  }
  if (!text) {
    toast('Nothing to load — paste the data into the box first', 'warn');
    return;
  }
  $('pasteBox').value = '';
  await loadText(text, 'pasted data');
}

async function ingest(list, label) {
  const dec = new Map();
  for (const e of await dbAll('decisions')) dec.set(e.key, e.val.verdict);

  for (const c of list) {
    c.centroid = centroid(c.ring);
    c.key = c.srcId
      ? (c.kind === 'building' ? 'bdot:' : 'prg:') + c.srcId
      : hash(c.kind + '|' + c.centroid[0].toFixed(6) + ',' + c.centroid[1].toFixed(6) + '|' +
        (c.tags['addr:housenumber'] || '') + (c.tags['addr:street'] || ''));
    c.orig = c.ring.map((p) => p.slice());
  }
  const before = list.length;
  candidates = list.filter((c) => dec.get(c.key) !== 'reject' && dec.get(c.key) !== 'accept');
  const skipped = before - candidates.length;

  toast(label + (skipped ? ', ' + skipped + ' already decided' : ''));
  setStage('Fetching OSM context');
  await buildContext();
  orderCandidates();
  cursor = 0;
  $('start').style.display = 'none';
  setStage('');
  show();
}

async function reportReject(c) {
  if (!S.reportRejects || !c.srcId) return;
  const path = c.kind === 'building' ? '/sc/proposed_buildings/report' : '/sc/proposed_addresses/report';
  try {
    // Deliberately tries: 1. This removes the object for every other mapper,
    // so a bounded timeout is welcome but re-sending on a doubtful failure is
    // not — a silent no-op is the safer outcome of the two.
    await fetchRetry(apiBase() + path, {
      tries: 1, timeout: 15000,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([String(c.srcId)]),
    });
  } catch (err) {
    console.warn('reject report failed', err);
  }
}

async function buildContext() {
  if (!candidates.length) return;
  const [s, w, n, e] = bboxOf(candidates);
  const key = [s, w, n, e].map((v) => v.toFixed(3)).join(',');
  let data = await dbGet('ctx', key).catch(() => null);
  if (!data || Date.now() - data.t > S.ctxTTLhours * 3600e3) {
    const q = `[out:json][timeout:90];(way["building"](${s},${w},${n},${e});relation["building"](${s},${w},${n},${e}););out center;`;
    try {
      // Overpass sheds load with 429 and 504 routinely, and honours
      // Retry-After when it does. The client timeout sits just above the
      // 90 s server-side one so we do not give up before it answers.
      const r = await fetchOk('https://overpass-api.de/api/interpreter', {
        tries: 3, timeout: 95000,
        method: 'POST',
        body: 'data=' + encodeURIComponent(q),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      const j = await r.json();
      data = { t: Date.now(), pts: j.elements.filter((el) => el.center || el.lat).map((el) => [el.center ? el.center.lat : el.lat, el.center ? el.center.lon : el.lon]) };
      await dbPut('ctx', key, data).catch(() => {});
    } catch (err) {
      toast('OSM context unavailable (' + err.message + '), order will be file order', 'warn');
      ctxIndexReady = false;
      return;
    }
  }
  if (!data.pts || !data.pts.length) { ctxIndexReady = false; return; }
  const lat = W.f64(data.pts.map((p) => p[0]));
  const lon = W.f64(data.pts.map((p) => p[1]));
  wasm.indexBuild(lat, lon, data.pts.length, 0.002);
  ctxIndexReady = true;
  ctxPts = data.pts;
}
let ctxPts = [];

// Chain a list of candidates nearest-neighbour, so each step is the shortest one
// available from where you already are.
//
// This replaced a sort on latitude then longitude, which made consecutive
// candidates near in latitude and ARBITRARY in longitude — so essentially every
// step was a teleport. That matters for more than feel: a teleport makes Leaflet
// discard the whole screenful and refetch, where a short step keeps the tiles it
// already has and fetches only the newly exposed edge, and anything it does
// refetch is likely already in the IndexedDB cache. On an origin capped at six
// connections with 1-4 s per tile, that is the difference between waiting for a
// screenful and waiting for an edge.
//
// Greedy nearest-neighbour rather than a space-filling curve because it is what
// the shortest-step behaviour actually is, and a grid keeps it affordable: cells
// are about a screen wide at review zoom, and the search expands ring by ring
// from the current cell, so it touches a handful of cells per step instead of the
// whole list. Ring r+1 is checked after a hit in ring r because a candidate just
// across a cell boundary can be nearer than one in the far corner of the cell
// that hit.
function nearestChain(list) {
  if (list.length < 3) return list.slice();
  // ~65 m of latitude. Two candidates this close share most of their tiles.
  const CELL = 0.0006;
  const cells = new Map();
  const ck = (la, lo) => Math.floor(la / CELL) + ':' + Math.floor(lo / CELL);
  for (const c of list) {
    const k = ck(c.centroid[0], c.centroid[1]);
    let a = cells.get(k);
    if (!a) cells.set(k, a = []);
    a.push(c);
  }
  const left = new Set(list);
  // Start from the westernmost of the southernmost row, so the order is stable
  // across reloads rather than depending on however the tiles happened to arrive.
  let at = list.reduce((b, c) => (c.centroid[0] < b.centroid[0] ||
    (c.centroid[0] === b.centroid[0] && c.centroid[1] < b.centroid[1])) ? c : b, list[0]);
  const out = [];
  while (at) {
    out.push(at);
    left.delete(at);
    if (!left.size) break;
    const [la, lo] = at.centroid;
    const gi = Math.floor(la / CELL), gj = Math.floor(lo / CELL);
    let best = null, bestD = Infinity, foundAt = -1;
    for (let r = 0; r < 64; r++) {
      // One ring past the first hit is enough; two rings of slack would only
      // cost work.
      if (foundAt >= 0 && r > foundAt + 1) break;
      for (let i = gi - r; i <= gi + r; i++) {
        for (let j = gj - r; j <= gj + r; j++) {
          // Only the perimeter of ring r; the inside was covered by earlier rings.
          if (r && Math.abs(i - gi) !== r && Math.abs(j - gj) !== r) continue;
          const bucket = cells.get(i + ':' + j);
          if (!bucket) continue;
          for (const c of bucket) {
            if (!left.has(c)) continue;
            const d = metresBetween(at.centroid, c.centroid);
            if (d < bestD) { bestD = d; best = c; }
          }
        }
      }
      if (best && foundAt < 0) foundAt = r;
    }
    // A gap wider than 64 cells (~4 km) is possible in a sparse area; fall back to
    // a full scan rather than dropping the rest of the queue on the floor.
    if (!best) {
      for (const c of left) {
        const d = metresBetween(at.centroid, c.centroid);
        if (d < bestD) { bestD = d; best = c; }
      }
    }
    at = best;
  }
  return out;
}

function orderCandidates() {
  for (const c of candidates) {
    c.dist = ctxIndexReady ? wasm.nearestMeters(c.centroid[0], c.centroid[1], 400) : 1e9;
    c.tier = c.dist > S.clearRadius ? 0 : c.dist > 8 ? 1 : 2;
  }
  // One sweep over everything, tier included. Chaining each tier separately was
  // tried and measured worse: it fragments one sweep into three interleaved ones
  // and the concatenation adds a long jump at each seam — steps over 100 m went
  // from 1 to 16 on a 164-object field. Tier is not lost by this, because nothing
  // ever depended on the ORDER: it is a display label, and paintChrome overrides
  // it with the real geometric verdict from the /map cell as soon as that arrives.
  // The centroid-distance tier was already documented as "not enough" on its own.
  candidates = nearestChain(candidates);
}

let map, imgLayer, ctxLayer, pendingLayer, shape, vertexGroup, undoStack = [];

function imagerySource() {
  if (S.imagery === 'custom') return { url: S.customUrl, layers: S.customLayers, attr: 'custom' };
  return PRESETS[S.imagery];
}

// The GetMap that the capability probe and Run diagnostics both use. One helper
// so the two cannot drift: a probe asking a different question from the one
// diagnostics reports would be worse than no probe at all.
function imageryProbeUrl(src) {
  return src.url + (src.url.includes('?') ? '&' : '?') +
    'SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&CRS=EPSG:3857&FORMAT=image/jpeg&STYLES=&LAYERS=' +
    encodeURIComponent(src.layers) + '&WIDTH=32&HEIGHT=32&BBOX=2337000,6842000,2337100,6842100';
}

// Measured against the default source (GUGiK ORTO WMS HighResolution) on
// 2026-08-19, from a wired link — a phone will be worse:
//
//   * HTTP/1.1 only, no h2, so the browser caps this origin at 6 connections,
//     and fetch and <img> share that one pool. Requests, not bytes, are the
//     scarce resource.
//   * TTFB 1.0-8.6 s on a 256x256 GetMap, mean 1.13 s over 20 successes at
//     concurrency 6. The old 12 000 ms timeout was only 1.4x the worst success.
//   * 4 of 24 requests were dropped mid-connection (TLS EOF / connection reset).
//     Drops arrive fast; hangs are the expensive failure.
//   * Five back-to-back requests were dropped 5/5, and the same URLs succeeded
//     minutes later when spaced out. The flakiness is load dependent, so piling
//     retries on is self-harm rather than resilience.
//   * No Cache-Control, Expires, ETag or Last-Modified, so a second request for
//     the same tile is a second real download. Nothing here is free.
//
// So a tile takes exactly ONE request in the common case and at most three, and
// one retry is worth far more than a long timeout. Measured in a headless
// browser before this change, on a cold cache: nine tiles took 77 GetMaps and
// not one of them had painted after 30 seconds.
const TILE_FETCH_TIMEOUT = 6000;
const TILE_IMG_TIMEOUT = 8000;
const TILE_IMG_TRIES = 3;
const TILE_IMG_BACKOFF = 300;
const TILE_IMG_BACKOFF_CAP = 1500;
// Whatever the source, stop retrying a tile past this. A blank tile now beats a
// connection still tied up when the next screenful arrives.
const TILE_DEADLINE = 15000;
// Consecutive cors-fetch failures after which tiles stop paying for the fetch
// and go straight to <img>. Purely a performance latch: it never touches
// pixelMode and never disables auto-fit.
//
// It must be able to heal, and this is measured, not theoretical. At four, a
// cold boot's 30-tile burst tripped it against a source whose CORS headers are
// perfect — because the server throttles bursts, so consecutive failures cluster
// exactly there — and the latch being permanent then cost the session its entire
// tile cache: 21 tiles painted by <img>, 0 cached. Six is past the burst, and
// re-arming after a stretch of img-served tiles means a transient throttle costs
// one wasted request per stretch rather than every cached tile for the session.
const TILE_FETCH_GIVEUP = 6;
const TILE_FETCH_REARM = 24;

// Self-healing. A tile that has spent its fast attempts and gone blank keeps
// trying — spaced far apart, a fixed number of times, never in a burst.
//
// Justified from the same measurements as the constants above: five
// back-to-back requests were dropped 5/5 with zero bytes, and the SAME URLs
// answered 7/8 minutes later once they were spaced out. The recovery timescale
// of this origin is therefore tens of seconds to minutes, so the only retry
// worth making is a late one, and a schedule that finished inside 30 s would
// never once sample a recovered server. Four slots, 6 s doubling, each jittered
// +-30% by backoff, land at this much wall clock after the tile gave up:
//
//   1: 4.2-7.8 s     2: 12.6-23.4 s     3: 29.4-54.6 s     4: 63-117 s
//
// So the first attempt is soon enough to feel automatic and the last is out in
// the window the measurement says works. Four slots also cap a tile's
// whole-of-life cost at 1 fetch + 3 img + 4 heal = 8 requests, under the
// 8.6/tile of the pathology this branch replaced — a screenful that heals
// cannot cost more than one that used to sit there blank. The 60 s cap is a
// guard the fourth slot does not reach; it is here so that raising TRIES cannot
// silently produce a twenty-minute timer.
//
// There is deliberately no batch size and no shared timer: each tile heals in
// the async closure it already has, so a screenful of nine blanks makes at most
// nine attempts — the same shape as the burst any pan already makes — and the
// independent jitter smears them apart instead of aligning them. Higher
// concurrency measured better on this origin, so a limiter would be the same
// mistake here as it was in the pipeline.
const TILE_HEAL_TRIES = 4;
const TILE_HEAL_BASE = 6000;
const TILE_HEAL_CAP = 60000;
// Slots skipped while hidden or offline are NOT spent, they are waited out — see
// healTile. Bounded so a tab left in a pocket cannot keep a closure alive for
// ever; at the schedule above that is roughly twenty minutes of waiting.
const TILE_HEAL_WAITS = 20;

// 'probe' — not characterised yet, so tiles try the fetch, which is the one path
//           that both paints and fills the cache from a single request;
// 'fetch' — a cors fetch can obtain an image from this source;
// 'img'   — it cannot, so tiles go straight to <img> and there is no cache.
let tilePath = 'probe';
let tileFetchMisses = 0;
let tileImgRun = 0;
let probeToken = 0;

// What a screenful actually cost. This is the per-tile attempt count the notes
// asked for, and Run diagnostics prints it rather than needing new markup.
// heal/healed are counted apart from net/tiles on purpose: folding a repair
// into either would make 'requests per tile' read healthy exactly when a
// screenful is costing double, and that ratio is how this branch is judged.
const tileStats = { tiles: 0, cache: 0, fetch: 0, img: 0, blank: 0, cancel: 0, net: 0, ms: 0, n: 0, heal: 0, healed: 0, truncated: 0 };
function tileStatsLine() {
  const s = tileStats;
  const per = s.tiles ? (s.net / s.tiles).toFixed(2) : '0';
  const avg = s.n ? Math.round(s.ms / s.n) : 0;
  return s.tiles + ' tiles, ' + s.net + ' requests (' + per + '/tile), ' +
    s.cache + ' from cache, ' + s.fetch + ' by fetch, ' + s.img + ' by <img>, ' +
    s.blank + ' blank, ' + s.cancel + ' cancelled, ' + avg + ' ms mean, path=' + tilePath +
    (s.heal ? '; healing spent ' + s.heal + ' requests and recovered ' + s.healed : '') +
    (s.truncated ? '; ' + s.truncated + ' truncated bodies rejected' : '');
}

// An <img> has no AbortController, so the timeout cancels by pointing src at a
// 1x1 gif, which is what the spec says aborts the pending fetch — src = '' does
// not reliably abort anything.
//
// Listeners, never img.onload = / img.onerror =. Leaflet claims those two
// properties: TileLayer._abortLoading sets both to a no-op unconditionally and
// TileLayer._onTileRemove nulls onload. Assigning them meant every aborted tile's
// promise never settled and its async pipeline stayed suspended for the life of
// the session, holding the img, the Blob and the object URL.
function loadImg(img, url, ms) {
  return new Promise((res, rej) => {
    let done = false;
    const off = () => {
      clearTimeout(img._timer);
      img._timer = null;
      img.removeEventListener('load', ok);
      img.removeEventListener('error', bad);
    };
    const ok = () => { if (done) return; done = true; off(); res(); };
    const bad = (why) => { if (done) return; done = true; off(); rej(why || new Error('image failed')); };
    img.addEventListener('load', ok);
    img.addEventListener('error', bad);
    img._timer = setTimeout(() => {
      const e = new Error('image timeout after ' + ms + 'ms');
      e.kind = 'timeout';
      img.src = L.Util.emptyImageUrl;
      bad(e);
    }, ms);
    img.src = url;
  });
}

const imgLoads = (url, ms) => loadImg(new Image(), url, ms).then(() => true, () => false);

// Does this body actually contain a whole image?
//
// This exists because of a measured property of the source, not out of caution.
// It drops 12-17% of connections mid-body and answers with `Transfer-Encoding:
// chunked` and no Content-Length, so a dropped connection can deliver a 200 whose
// JPEG simply stops early. A browser fires `load` for that — it decodes the rows
// it received and fills the rest with WHITE — so nothing downstream can tell the
// difference, and the truncated body goes into the tile cache and is served from
// there until the TTL expires. Reported as "instead of black tiles i see white
// only tiles", and it only appeared once the fetch path started succeeding often
// enough to cache anything.
//
// A complete JPEG ends with the end-of-image marker FFD9 and a complete PNG with
// an IEND chunk. Both are cheap to check on the last few bytes and both are
// definitive, where size and decoded dimensions are not: a truncated JPEG still
// reports the full width and height from its header.
async function imageBlobOk(b) {
  if (!b || !b.size || !b.type || !b.type.startsWith('image/')) return false;
  const tailLen = Math.min(16, b.size);
  const tail = new Uint8Array(await b.slice(b.size - tailLen).arrayBuffer());
  if (b.type === 'image/jpeg' || b.type === 'image/jpg') {
    return tail[tailLen - 2] === 0xff && tail[tailLen - 1] === 0xd9;
  }
  if (b.type === 'image/png') {
    // ...IEND then its 4-byte CRC.
    for (let i = 0; i + 3 < tailLen; i++) {
      if (tail[i] === 0x49 && tail[i + 1] === 0x45 && tail[i + 2] === 0x4e && tail[i + 3] === 0x44) return true;
    }
    return false;
  }
  // An unrecognised image type is taken at its word rather than rejected, so a
  // source serving webp or avif keeps working.
  return true;
}

// One request per source selection, never per tile.
//
// This is the ONLY place allowed to conclude that a source sends no usable CORS
// headers, and it needs three independent signals to say so. A single
// network-shaped fetch rejection is also exactly what a dropped connection looks
// like, and this source was measured dropping about one request in eight — enough
// that inferring it per tile latched pixelMode = 'blocked' on roughly six
// screenfuls in ten of a source whose headers are in fact perfect, which disabled
// auto-fit and killed the tile cache for the session. A header fault is
// deterministic and origin-wide; a dropped connection is not, and only somewhere
// that can afford three requests can tell the two apart.
async function probeImagery(token) {
  const live = () => probeToken === token;
  const src = imagerySource();
  // An xyz source has no GetMap to probe, so let the tiles themselves decide
  // through the consecutive-miss latch.
  if (src.xyz || !src.url) { if (live()) tilePath = 'fetch'; return; }
  const url = imageryProbeUrl(src);

  let err = null;
  // Every attempt's failure kind, not just the last one's. The proxy answers 404
  // to about half its GetMaps and duplicates its CORS headers on the rest, so
  // reading only err.kind saw whichever failure happened to come last — measured
  // ending on 'http', which meant the probe never diagnosed the header fault at
  // all even though a CORS rejection had occurred on an earlier attempt.
  const kinds = [];
  try {
    // tries: 3 because of that same 404 rate — the headers cannot be judged until
    // a response that carries an image has actually been reached.
    const r = await fetchOk(url, {
      mode: 'cors', tries: 3, timeout: 8000, retryOn: transientImagery,
      onAttempt: (i, msg, kind) => kinds.push(kind),
    });
    await r.blob();
    if (live()) { tilePath = 'fetch'; tileFetchMisses = 0; }
    return;
  } catch (e) { err = e; }
  if (!live()) return;

  // A timeout or an HTTP status says nothing about CORS. Stay on the fetch path:
  // it is bounded now, and a slow or unwell server must not cost the session its
  // tile cache. The consecutive-miss latch handles it if it persists.
  if (err.kind !== 'network' && !kinds.includes('network')) return;

  // Signal two: a no-cors fetch that resolves proves the server was reached and
  // answered, so the fault is in its headers rather than out on the wire.
  try { await fetch(url, { mode: 'no-cors', cache: 'no-store' }); } catch (_) { return; }
  if (!live()) return;
  // Signal three: an <img> that loads proves the bytes really are there.
  if (!await imgLoads(url, 15000) || !live()) return;

  tilePath = 'img';
  markPixelsBlocked('imagery server sends no usable CORS headers');
}

function makeImagery() {
  const src = imagerySource();
  if (imgLayer) map.removeLayer(imgLayer);
  resetPixelMode();
  tilePath = 'probe';
  tileFetchMisses = 0;
  tileImgRun = 0;
  probeImagery(++probeToken).catch(() => {});
  // tileerror fires once per tile, when its fast attempts are exhausted, so a
  // handful of them is a real problem rather than transient noise. healTile
  // keeps working on those tiles afterwards and never calls done() again, so
  // this counter still means what it says and the advice is now "wait" first.
  let fails = 0;
  const onErr = () => {
    if (++fails === 4) {
      toast('Imagery is failing. Blank tiles keep retrying for the next minute ' +
        'or two — if they are still blank after that, pick another source in settings.', 'warn');
    }
  };
  // maxZoom must not sit below the map's. Leaflet's _setView nulls _tileZoom when
  // the rounded zoom exceeds the layer's maxZoom and then skips _update, and
  // _pruneTiles hits `zoom > options.maxZoom` and calls _removeAllTiles() — a
  // completely blank map. Measured in a headless browser: 6 tiles at z21, 0 at
  // z22, 6 again on the way back down. That is the whole of "imagery only comes
  // back after a rezoom", and since review sits at z20 it is two pinches away.
  // maxNativeZoom upscales the deepest real tile instead. At 52 degrees north z21
  // is ~4.6 cm/px against GUGiK's 5-10 cm ground sample distance, so z22 was pure
  // server-side upsampling at four times the requests.
  const common = {
    maxZoom: map.options.maxZoom,
    // Keeps a pinch from queueing a whole screenful at every integer zoom it
    // sweeps through. At 1-4 s per GetMap over six connections those are always
    // discarded before they arrive, so they cost nothing but contention.
    updateWhenZooming: false,
    attribution: src.attr,
  };
  if (src.xyz) {
    // tile.openstreetmap.org serves to z19. Without this the z20-21 tiles review
    // zoom asks for are 404s, and transientImagery treats a 404 as worth
    // retrying, so this preset burned several requests per tile to render nothing.
    imgLayer = cachedTileLayer(src.xyz, Object.assign({ maxNativeZoom: src.maxNativeZoom || 19 }, common));
  } else {
    imgLayer = cachedWmsLayer(src.url, Object.assign({
      layers: src.layers, format: 'image/jpeg', transparent: false,
      version: '1.3.0', maxNativeZoom: 21,
    }, common));
  }
  imgLayer.on('tileerror', onErr);
  // On the LAYER, not the map. GridLayer fires tileunload with no propagate flag
  // and Layer._layerAdd never makes the map an event parent, so the old
  // map.on('tileunload', ...) never ran even once — measured 0 on the map against
  // 9 on the layer for a single jump. That is why nothing was ever cancelled, and
  // why every tile that painted leaked its object URL for the life of the session.
  imgLayer.on('tileunload tileabort', (e) => { if (e.tile && e.tile._abort) e.tile._abort(); });
  imgLayer.addTo(map);
  imgLayer.bringToBack();
}

function tileCacheMixin(Base) {
  return Base.extend({
    createTile(coords, done) {
      const img = document.createElement('img');
      img.setAttribute('role', 'presentation');
      img.alt = '';
      const url = this.getTileUrl(coords);
      const t0 = performance.now();
      tileStats.tiles++;

      let settled = false;
      // Leaflet's _loading bookkeeping, its `load` event, and the deferred prune
      // that clears the previous zoom's tiles all hang off done() being called
      // exactly once. The abort paths used to skip it outright, which left the
      // layer permanently "loading" and the old zoom's tiles on screen until the
      // next setView — imagery that only reappeared after a rezoom.
      const finish = (err) => {
        if (settled) return;
        settled = true;
        img._settled = true;
        // done() before releasing the connection: TileLayer._tileReady discards
        // the callback when src is already the 1x1 gif, so pointing src there
        // first would swallow it and leave the tile marked unloaded for good.
        //
        // And clear it if something else got there first. loadImg's timeout
        // aborts by pointing src at that same gif before it rejects, so on a
        // timeout — the failure mode this origin's burst throttling actually
        // produces, five requests dropped with zero bytes after 15 s — src was
        // already the gif on this line, _tileReady returned immediately, and the
        // tile got no tileerror, no `loaded` stamp and no fade: the layer stayed
        // marked "loading" for the rest of the session and the "pick another
        // source" counter below never moved. Both failure modes now take the
        // same path. removeAttribute, not src = '': an empty src is a real URL
        // that some browsers fetch.
        if (err) img.removeAttribute('src');
        done(err || null, img);
        if (err) {
          tileStats.blank++;
          img.src = L.Util.emptyImageUrl;
        } else {
          tileStats.ms += performance.now() - t0;
          tileStats.n++;
        }
      };
      // Called synchronously by whoever abandons the tile, so its retry chain
      // stops at that moment rather than at whatever await it happens to be
      // parked on. done(null), not done(err): _tileReady fires tileerror before
      // it checks whether the tile still exists, so an error here would raise a
      // spurious tileerror on every pan and drive the "pick another source"
      // toast. A cancelled tile is not a failed one.
      img._abort = () => {
        if (img._cancelled) return;
        img._cancelled = true;
        tileStats.cancel++;
        clearTimeout(img._timer);
        revokeTile(img);
        if (!settled) {
          settled = true;
          img._settled = true;
          done(null, img);
        }
        img.src = L.Util.emptyImageUrl;
      };
      const gone = () => img._cancelled === true;
      const useBlob = (b) => {
        revokeTile(img);
        img._blob = URL.createObjectURL(b);
        return loadImg(img, img._blob, TILE_IMG_TIMEOUT);
      };

      (async () => {
        // 1. Cache. A read or a corrupt entry must never be fatal — it is only
        //    an optimisation.
        if (S.tileTTLdays > 0) {
          const hit = await dbGet('tiles', url).catch(() => null);
          if (gone()) return;
          // imageBlobOk on the way out as well as the way in, so an entry stored
          // by an earlier build — which did not check — is dropped the first time
          // it is read rather than shown white until its TTL runs out.
          if (hit && hit.blob && Date.now() - hit.t < S.tileTTLdays * 86400e3 && !await imageBlobOk(hit.blob)) {
            tileStats.truncated++;
            dbDel('tiles', url);
            hit.blob = null;
          }
          if (gone()) return;
          if (hit && hit.blob && Date.now() - hit.t < S.tileTTLdays * 86400e3) {
            try { await useBlob(hit.blob); tileStats.cache++; return finish(); } catch (_) {
              if (gone()) return;
              dbDel('tiles', url);
            }
          }
        }
        if (gone()) return;

        // 2. One cors fetch, on the sources where a fetch can return an image.
        //    It paints and fills the cache from the same request, which matters
        //    because the response carries no caching headers at all: painting
        //    from <img> and then fetching the same URL for the cache would
        //    download those bytes twice. tries: 1 — the retry lives on the <img>
        //    below, where it is both cheaper and independent of CORS.
        if (tilePath !== 'img') {
          try {
            tileStats.net++;
            const r = await fetchOk(url, {
              mode: 'cors', tries: 1, timeout: TILE_FETCH_TIMEOUT, retryOn: transientImagery,
            });
            const b = await r.blob();
            if (gone()) return;
            // A truncated body must not be painted and must never be cached. It
            // would render its missing rows white and then be served from the
            // cache that way for days.
            if (!await imageBlobOk(b)) {
              if (gone()) return;
              tileStats.truncated++;
              // Do NOT fall through to the <img> path. It would request the same
              // URL and paint the same partial bytes, because an <img> cannot
              // inspect what it received — measured: 9 bodies rejected here and
              // then 21 painted below, 12 visible partial tiles. A tile that is
              // half imagery and half fill is worse than a blank one: the whole
              // point of this app is judging a building against what is actually
              // on the ground, and a partial tile invites a verdict over a region
              // that was never seen. Blank, and let healTile ask again in a few
              // seconds, by which time the connection has usually recovered —
              // which is exactly what the burst measurements predict.
              return finish(new Error('incomplete image body'));
            }
            await useBlob(b);
            // Cached only now that it has provably decoded. Storing before the
            // decode meant a body that failed to render was still in the cache.
            if (S.tileTTLdays > 0) dbPut('tiles', url, { blob: b, t: Date.now() }).catch(() => {});
            tileFetchMisses = 0;
            tilePath = 'fetch';
            tileStats.fetch++;
            return finish();
          } catch (err) {
            if (gone()) return;
            // Deliberately no CORS conclusion here — that lives in probeImagery,
            // which can afford the three requests it takes to tell a missing
            // header from a dropped connection. This is a performance latch only
            // and must never touch pixelMode.
            if (++tileFetchMisses >= TILE_FETCH_GIVEUP) { tilePath = 'img'; tileImgRun = 0; }
          }
        } else if (++tileImgRun >= TILE_FETCH_REARM) {
          // Give the fetch another chance. A latch that cannot heal turns one bad
          // burst into a session with no tile cache at all.
          tilePath = 'probe';
          tileFetchMisses = 0;
          tileImgRun = 0;
        }

        // 3. Plain <img>: no CORS check at all, so it works on any source
        //    including the budynki proxy, but the bytes cannot be cached or read
        //    back as pixels.
        let last = null;
        for (let i = 1; i <= TILE_IMG_TRIES; i++) {
          if (i > 1) {
            if (performance.now() - t0 > TILE_DEADLINE) break;
            await sleep(backoff(i - 1, TILE_IMG_BACKOFF, TILE_IMG_BACKOFF_CAP));
            if (gone()) return;
          }
          try {
            tileStats.net++;
            await loadImg(img, url, TILE_IMG_TIMEOUT);
            tileStats.img++;
            return finish();
          } catch (err) {
            last = err;
            if (gone()) return;
          }
        }
        finish(last || new Error('tile failed'));

        // 4. Blank, but not necessarily unloadable. Keep the closure alive and
        //    retry slowly; see healTile.
        await healTile(img, url, gone);
      })();

      return img;
    },
    // NOT `!t.el.complete`: an <img> that has never been given a src reports
    // complete === true (measured), so the old test skipped exactly the tiles
    // still waiting on the cache read or the fetch — the ones whose retry chains
    // most needed stopping. Leaflet's own _abortLoading is blocked by the same
    // guard and so leaves those tiles in _tiles as well; removing them here
    // routes them through _removeTile, which fires tileunload and so reaches
    // _abort, releasing the connection and revoking the blob.
    _abortLoading() {
      const stale = [];
      for (const k in this._tiles) {
        const t = this._tiles[k];
        if (t.coords.z !== this._tileZoom && t.el && !t.el._settled) stale.push(k);
      }
      Base.prototype._abortLoading.call(this);
      for (const k of stale) if (this._tiles[k]) this._removeTile(k);
    },
  });
}

function revokeTile(el) {
  if (el && el._blob) { URL.revokeObjectURL(el._blob); el._blob = null; }
}

// "the tiles were loading, just not all, and after they failed to load i had to
// do sth so it retries" — the report this exists for. Nothing in Leaflet
// notices or repairs a failed tile: _tileOnError swaps in errorTileUrl, which
// defaults to '', and stops. So a blank tile stayed blank until a pan or a zoom
// rebuilt it.
//
// This is that repair, and it is deliberately the smallest thing that works: a
// continuation of the <img> loop above, in the same closure, on the same
// element, running after finish() has already told Leaflet the tile settled.
// No interval, no sweep over layer._tiles, no _removeTile, no second pipeline,
// no new state to reason about beyond "the loop carries on, slowly". It also
// inherits the cancellation that is already wired and measured: everything that
// ends a tile's life — pruned out of view, zoom changed, imagery source changed,
// layer removed — reaches _removeTile or _abortLoading, which fire tileunload
// or tileabort, which reach img._abort(), which is what gone() reads.
//
// Three details are load-bearing:
//   * Leaflet adds `leaflet-tile-loaded` at exactly one line and only when the
//     tile did not error, and .leaflet-tile is `visibility: hidden` until that
//     class arrives, so a repaired tile has to be revealed here. Re-calling
//     done() would not do it (_tileReady bails while src is the gif) and would
//     fire a second, spurious tileerror.
//   * healOnce, not loadImg directly. It prefers the cors fetch where that source
//     supports one, because only the fetch can check the body for completeness,
//     and it never lets the attempt vote on tileFetchMisses — a retry of a
//     known-bad tile is not evidence about the source, and letting nine blank
//     tiles vote latches tilePath to 'img' at six, which was measured costing a
//     session its entire tile cache.
//   * gone() is re-checked after every await, including after a successful load:
//     _abort() cancels by pointing src at the gif, which fires `load`, so a
//     cancelled tile can resolve loadImg looking like a success.
// Nothing here reads a status or infers anything at all about CORS, so
// pixelMode stays reachable only from probeImagery (regression 12).
// One heal attempt. Where a cors fetch can obtain an image, heal through it
// rather than through a plain <img>, because only the fetch can see whether the
// body it received was complete — an <img> paints whatever arrived, which is the
// fault imageBlobOk exists to stop, and healing is the one path that would
// otherwise still reintroduce it.
//
// It must still not vote on tileFetchMisses: a retry of a tile already known to
// have failed is not evidence about the source, and letting it vote was measured
// costing a session its entire tile cache. So the counter is deliberately left
// alone here, in both directions.
async function healOnce(img, url) {
  if (tilePath === 'img') return loadImg(img, url, TILE_IMG_TIMEOUT);
  const r = await fetchOk(url, {
    mode: 'cors', tries: 1, timeout: TILE_FETCH_TIMEOUT, retryOn: transientImagery,
  });
  const b = await r.blob();
  if (!await imageBlobOk(b)) {
    tileStats.truncated++;
    throw new Error('incomplete image body');
  }
  revokeTile(img);
  img._blob = URL.createObjectURL(b);
  await loadImg(img, img._blob, TILE_IMG_TIMEOUT);
  if (S.tileTTLdays > 0) dbPut('tiles', url, { blob: b, t: Date.now() }).catch(() => {});
}

async function healTile(img, url, gone) {
  // A cache hit whose blob then failed to decode leaves that object URL on the
  // element, and _abort only revokes it when the tile is finally pruned. Holding
  // it across the heal window is a decoded 256x256 bitmap nothing can reach.
  revokeTile(img);
  // i counts slots actually spent; waits counts slots skipped. A backgrounded tab
  // must not fire GetMaps at a source that punishes bursts, and offline is a
  // guaranteed waste — but a skipped slot must not be a SPENT one. On a phone,
  // switching away mid-review is the normal case, not an edge case, and spending
  // the slots meant coming back to tiles that would never try again until the map
  // moved. Waiting is safe: a hidden tab's timers are throttled by the browser, so
  // this paces itself instead of queueing a burst for the moment of unhide, and
  // backoff's jitter smears whatever does resume together.
  for (let i = 1, waits = 0; i <= TILE_HEAL_TRIES;) {
    await sleep(backoff(i, TILE_HEAL_BASE, TILE_HEAL_CAP));
    if (gone()) return;
    if (document.hidden || navigator.onLine === false) {
      if (++waits > TILE_HEAL_WAITS) return;
      continue;
    }
    i++;
    tileStats.heal++;
    try {
      await healOnce(img, url);
      if (gone()) return;
      L.DomUtil.addClass(img, 'leaflet-tile-loaded');
      tileStats.healed++;
      return;
    } catch (_) {
      if (gone()) return;
      // Back to the gif so a failed attempt is not left holding one of the six
      // connections this origin allows.
      img.src = L.Util.emptyImageUrl;
    }
  }
}

const CachedTile = tileCacheMixin(L.TileLayer);
const CachedWms = tileCacheMixin(L.TileLayer.WMS);
const cachedTileLayer = (u, o) => new CachedTile(u, o);
const cachedWmsLayer = (u, o) => new CachedWms(u, o);

function initMap() {
  map = L.map('map', {
    zoomControl: false, attributionControl: true, preferCanvas: false,
    maxZoom: 22, doubleClickZoom: false, keyboard: false,
    // Opens wide rather than at review zoom. show() re-frames each candidate
    // with fitBounds, so this only affects the initial hunt for an area — and at
    // z18 the first data request covered ~150 m and came back empty.
  }).setView([52.2, 21.0], 14);
  makeImagery();
  // Below ctxLayer so the OSM footprints and the queued-ochre outlines stay
  // readable over it, and above the imagery so it is visible at all.
  pendingLayer = L.layerGroup().addTo(map);
  ctxLayer = L.layerGroup().addTo(map);
  vertexGroup = L.layerGroup().addTo(map);
  // Redrawn on pan and zoom, not just per candidate: the point of this layer is
  // to answer "where does this go next", which is a question you ask by zooming
  // out, and selecting by the visible bounds is also what keeps it cheap.
  map.on('moveend zoomend', drawPending);
  watchMapSize();
}

// Leaflet caches the container size and re-measures it in exactly two places:
// Map.initialize, and invalidateSize — whose only internal caller is the window
// 'resize' handler. There is no ResizeObserver anywhere in Leaflet 1.9.4.
//
// #map is absolutely positioned inside #wrap, and #wrap is a flex sibling of
// #tags and #start, so hiding the start panel, expanding it, or painting a
// different number of tag chips changes the map's height with no resize event
// anywhere. Measured at 496x822: with #start expanded Leaflet believed the map
// was 434 px tall when it was 174, and with the panel hidden it believed 434
// against a real 535 — and it was still wrong two frames later. Either sign
// hurts: too tall requests up to 2.5x the visible area from a source capped at
// six connections, and too short leaves a blank strip along the bottom.
//
// pan: false so the view is never yanked out from under the reviewer.
// debounceMoveend so the moveend this fires cannot make GridLayer request a
// screenful for the pre-fit view microseconds before fitBounds moves it.
function syncMapSize() {
  if (map && map._loaded) map.invalidateSize({ pan: false, debounceMoveend: true });
}

// Observing the element Leaflet actually measures catches every layout change,
// including the ones nobody has written yet. It also fires once on observe, so
// boot is corrected for free. rAF-coalesced because a flex reflow can report
// several times in one frame.
function watchMapSize() {
  if (!window.ResizeObserver) return;
  let queued = false;
  new ResizeObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; syncMapSize(); });
  }).observe($('map'));
}

function cur() { return candidates[cursor]; }

function setControls(on) {
  for (const el of document.querySelectorAll('#pad button, #padTools button, #bar button')) {
    el.disabled = !on;
  }
  if (on) {
    $('undoBtn').disabled = !undoStack.length;
    if (pixelMode === 'blocked') $('autoBtn').disabled = true;
  }
}

function show() {
  const c = cur();
  if (!c) {
    setControls(false);
    $('start').style.display = 'flex';
    $('emptyMsg').textContent = candidates.length
      ? 'Queue finished — ' + candidates.length + ' reviewed'
      : 'Nothing queued';
    return;
  }
  setControls(true);
  undoStack = [];
  // Layout first, fit last. paintTags changes the height of #tags, which is a
  // flex sibling of the map, so running it after fitShape — as this used to —
  // re-staled the size immediately after the fit was computed from it.
  paintTags();
  paintChrome();
  drawShape();
  drawContext();
  drawPending();
  fitShape();
}

function drawShape() {
  const c = cur();
  if (shape) { map.removeLayer(shape); shape = null; }
  vertexGroup.clearLayers();
  if (!c) return;
  if (c.kind === 'building' || c.kind === 'area') {
    // Leaflet takes [outer, ...holes], so a hole is drawn as a hole rather than
    // being lost or filled in.
    const rings = [c.ring].concat((c.holes || []).filter((h) => h && h.length >= 3));
    const area = c.kind === 'area';
    shape = L.polygon(area ? rings : c.ring, {
      color: area ? '#a3e635' : '#ff2d95', weight: area ? 2 : 2.5,
      fillColor: area ? '#a3e635' : '#ff2d95', fillOpacity: area ? 0.08 : 0.12,
      className: 'cand',
    }).addTo(map);
    attachShapeDrag();
    drawVertices();
  } else {
    shape = L.circleMarker(c.ring[0], {
      color: '#ff2d95', weight: 3, radius: 11, fillColor: '#ff2d95', fillOpacity: 0.25,
    }).addTo(map);
    attachPointDrag();
  }
}

// Land-cover parcels routinely carry hundreds of vertices and their boundaries
// are shared with neighbours, conditioned upstream — dropping forty draggable
// markers on one is both useless and a way to break that shared edge by accident.
const VERTEX_LIMIT = 80;

function drawVertices() {
  const c = cur();
  vertexGroup.clearLayers();
  if (!c || c.kind !== 'building') return;
  if (c.ring.length > VERTEX_LIMIT) return;
  if (!$('vertexToggle').classList.contains('on')) return;
  c.ring.forEach((pt, i) => {
    const m = L.marker(pt, {
      draggable: true, keyboard: false,
      icon: L.divIcon({ className: 'vtx', html: '<i></i>', iconSize: [40, 40], iconAnchor: [20, 20] }),
    }).addTo(vertexGroup);
    m.on('dragstart', () => pushUndo());
    m.on('drag', (e) => {
      const ll = e.target.getLatLng();
      c.ring[i] = [ll.lat, ll.lng];
      shape.setLatLngs(c.ring);
    });
    m.on('dragend', () => { c.moved = true; paintChrome(); });
  });
}

function attachShapeDrag() {
  const el = shape.getElement();
  if (!el) return;
  let start = null, orig = null;
  el.style.cursor = 'move';
  el.addEventListener('pointerdown', (ev) => {
    if ($('vertexToggle').classList.contains('on')) return;
    ev.stopPropagation();
    el.setPointerCapture(ev.pointerId);
    map.dragging.disable();
    pushUndo();
    start = map.mouseEventToContainerPoint(ev);
    orig = cur().ring.map((p) => p.slice());
  });
  el.addEventListener('pointermove', (ev) => {
    if (!start) return;
    const now = map.mouseEventToContainerPoint(ev);
    const d = now.subtract(start);
    const c = cur();
    c.ring = orig.map(([la, lo]) => {
      const p = map.latLngToContainerPoint([la, lo]).add(d);
      const ll = map.containerPointToLatLng(p);
      return [ll.lat, ll.lng];
    });
    shape.setLatLngs(c.ring);
  });
  const end = (ev) => {
    if (!start) return;
    start = null;
    map.dragging.enable();
    try { el.releasePointerCapture(ev.pointerId); } catch (e) {}
    cur().moved = true;
    drawVertices();
    paintChrome();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

function attachPointDrag() {
  const el = shape.getElement();
  if (!el) return;
  let dragging = false;
  el.addEventListener('pointerdown', (ev) => {
    ev.stopPropagation();
    el.setPointerCapture(ev.pointerId);
    map.dragging.disable();
    pushUndo();
    dragging = true;
  });
  el.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const ll = map.containerPointToLatLng(map.mouseEventToContainerPoint(ev));
    cur().ring[0] = [ll.lat, ll.lng];
    shape.setLatLng(ll);
  });
  const end = (ev) => {
    if (!dragging) return;
    dragging = false;
    map.dragging.enable();
    try { el.releasePointerCapture(ev.pointerId); } catch (e) {}
    cur().moved = true;
    paintChrome();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

// Snapshots tags as well as geometry, so Z undoes a tag edit too. It used to
// store the ring alone, which meant an accidental tag change was unrecoverable.
function pushUndo() {
  const c = cur();
  if (!c) return;
  undoStack.push({ ring: c.ring.map((p) => p.slice()), tags: Object.assign({}, c.tags) });
  if (undoStack.length > 40) undoStack.shift();
  $('undoBtn').disabled = false;
}

function undo() {
  if (!undoStack.length || !cur()) return;
  const c = cur();
  const prev = undoStack.pop();
  c.ring = prev.ring;
  c.tags = prev.tags;
  if (c.kind === 'building') { shape.setLatLngs(c.ring); drawVertices(); }
  else shape.setLatLng(c.ring[0]);
  $('undoBtn').disabled = !undoStack.length;
  paintTags();
  paintChrome();
}

function nudge(dxm, dym) {
  const c = cur();
  if (!c) return;
  pushUndo();
  const mLat = 111320;
  const mLon = 111320 * Math.cos(c.centroid[0] * Math.PI / 180);
  c.ring = c.ring.map(([la, lo]) => [la + dym / mLat, lo + dxm / mLon]);
  if (c.kind === 'building') { shape.setLatLngs(c.ring); drawVertices(); }
  else shape.setLatLng(c.ring[0]);
  c.moved = true;
  paintChrome();
}

function metresBetween(a, b) {
  const mLat = 111320;
  const mLon = 111320 * Math.cos(a[0] * Math.PI / 180);
  return Math.hypot((b[0] - a[0]) * mLat, (b[1] - a[1]) * mLon);
}

function driftMeters() {
  const c = cur();
  if (!c) return 0;
  return metresBetween(centroid(c.orig), centroid(c.ring));
}

// ---- What is already in OSM here -------------------------------------------
// The centroid index above is enough to order the queue, but not to decide a
// verdict: a large existing building's centroid can sit 30 m away while its
// footprint covers the candidate completely, and the old query fetched no
// address nodes at all, so every PRG address was judged blind.
//
// Real geometry is therefore fetched lazily for a ~300 m cell around whichever
// candidate is on screen, snapped to a grid so neighbouring candidates share a
// cell, and cached. Measured: 26 KB and about a second per cell, against 4.2 MB
// for the whole 3 km candidate box — which is why this is per-cell and not
// fetched up front.
const CTX_CELL_LAT = 0.003;    // ~334 m
const CTX_CELL_LON = 0.005;    // ~308 m at 52 N
const ctxCells = new Map();    // key -> {ways, addrs} | 'loading' | 'failed'

function ctxCellKey(lat, lon) {
  return Math.floor(lat / CTX_CELL_LAT) + '/' + Math.floor(lon / CTX_CELL_LON);
}

async function loadCtxCell(lat, lon) {
  const key = ctxCellKey(lat, lon);
  const known = ctxCells.get(key);
  if (known) return known === 'loading' || known === 'failed' ? null : known;
  ctxCells.set(key, 'loading');

  const dbKey = 'osmctx/' + key;
  const hit = await dbGet('ctx', dbKey).catch(() => null);
  if (hit && Date.now() - hit.t < S.ctxTTLhours * 3600e3) {
    ctxCells.set(key, hit.data);
    return hit.data;
  }

  const s = Math.floor(lat / CTX_CELL_LAT) * CTX_CELL_LAT;
  const w = Math.floor(lon / CTX_CELL_LON) * CTX_CELL_LON;
  // The OSM API rather than Overpass. Overpass answered this exact query with
  // 504 Gateway Timeout under load, twice in a row, where /map returned in
  // 0.25-0.32 s on four consecutive tries. It is also authoritative and current,
  // and its XML goes through the wasm scanner the app already has. Its 50k node
  // ceiling is no obstacle at cell size — a 300 m cell holds around 1,100.
  const bbox = [w, s, w + CTX_CELL_LON, s + CTX_CELL_LAT].map((v) => v.toFixed(6)).join(',');
  try {
    const r = await fetchOk(API + '/map?bbox=' + bbox, { tries: 3, timeout: 25000 });
    const data = ctxFromOsmXml(await r.text());
    ctxCells.set(key, data);
    dbPut('ctx', dbKey, { t: Date.now(), data }).catch(() => {});
    return data;
  } catch (err) {
    // Leave it failed rather than retrying on every redraw; panning back later
    // clears nothing, but a reload will try again.
    ctxCells.set(key, 'failed');
    return null;
  }
}

// An OSM API /map response to the shape drawContext and the verdicts want, via
// the same wasm scanner used for candidate files. Kept separate from the fetch
// so it can be tested against a captured response.
//
// Only ways actually tagged building become footprints: /map returns everything
// in the box, and drawing every closed way would put car parks and hedges on
// screen as though they were buildings.
function ctxFromOsmXml(text) {
  RAW = text;
  const [p, len] = W.bytes(text);
  wasm.setSource(p, len);
  wasm.parse();
  const nc = wasm.nodeCount(), wc = wasm.wayCount();
  const nid = W.view64(wasm.ptrNodeId(), nc);
  const nlat = W.view64(wasm.ptrNodeLat(), nc);
  const nlon = W.view64(wasm.ptrNodeLon(), nc);
  const ntA = W.view32(wasm.ptrNodeTagA(), nc);
  const ntB = W.view32(wasm.ptrNodeTagB(), nc);
  const wA = W.view32(wasm.ptrWayNdA(), wc);
  const wN = W.view32(wasm.ptrWayNdN(), wc);
  const wtA = W.view32(wasm.ptrWayTagA(), wc);
  const wtB = W.view32(wasm.ptrWayTagB(), wc);
  const refs = W.view64(wasm.ptrRefs(), wasm.refsCount());

  const byId = new Map();
  for (let i = 0; i < nc; i++) byId.set(nid[i], i);

  const data = { ways: [], addrs: [] };
  for (let i = 0; i < wc; i++) {
    const tags = tagsIn(wtA[i], wtB[i]);
    if (!tags.building) continue;
    const ring = [];
    let ok = true;
    for (let k = 0; k < wN[i]; k++) {
      const idx = byId.get(refs[wA[i] + k]);
      if (idx === undefined) { ok = false; break; }
      ring.push([nlat[idx], nlon[idx]]);
    }
    if (!ok || ring.length < 3) continue;
    data.ways.push({ ring, hn: tags['addr:housenumber'] || '' });
  }
  for (let i = 0; i < nc; i++) {
    if (ntB[i] <= ntA[i]) continue;
    const tags = tagsIn(ntA[i], ntB[i]);
    if (!tags['addr:housenumber']) continue;
    data.addrs.push({
      lat: nlat[i], lon: nlon[i],
      hn: tags['addr:housenumber'],
      street: tags['addr:street'] || '',
    });
  }
  wasm.release(p);
  return data;
}

function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ay, ax] = ring[i], [by, bx] = ring[j];
    if ((ay > pt[0]) !== (by > pt[0]) &&
        pt[1] < (bx - ax) * (pt[0] - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

function ringCentroidSimple(ring) {
  let la = 0, lo = 0;
  for (const p of ring) { la += p[0]; lo += p[1]; }
  return [la / ring.length, lo / ring.length];
}

// Verdict from real geometry rather than centroid distance. Containment either
// way counts as an overlap: a candidate drawn inside an existing footprint is a
// duplicate, and so is an existing building sitting inside the candidate.
function overlapVerdict(c, cell, what) {
  if (!cell || !cell.ways.length) return null;
  const it = what || 'an OSM building';
  // Land cover legitimately contains buildings — a farmland parcel with a barn in
  // it is not a duplicate of the barn. Judging areas against building footprints
  // would flag essentially every field, so it is skipped. Comparing against
  // existing *land cover* would be the useful check and is not implemented.
  if (c.kind === 'area') return null;
  for (const w of cell.ways) {
    if (c.kind === 'address') {
      if (pointInRing(c.ring[0], w.ring)) {
        return { tier: 2, why: w.hn ? 'inside ' + it + ' ' + w.hn : 'inside ' + it };
      }
      continue;
    }
    if (pointInRing(ringCentroidSimple(c.ring), w.ring)) return { tier: 2, why: 'covered by ' + it };
    if (pointInRing(ringCentroidSimple(w.ring), c.ring)) return { tier: 2, why: 'contains ' + it };
    for (const v of c.ring) if (pointInRing(v, w.ring)) return { tier: 2, why: 'overlaps ' + it };
  }
  return { tier: null, why: '' };
}

// Same address already mapped nearby? That is the address equivalent of an
// overlapping footprint, and it was previously invisible.
function duplicateAddress(c, cell) {
  if (!cell || c.kind !== 'address') return '';
  // Compared case-insensitively but reported as tagged: "14a already in OSM"
  // for a candidate tagged 14A is needlessly confusing.
  const shown = String(c.tags['addr:housenumber'] || '');
  const hn = shown.toLowerCase();
  if (!hn) return '';
  const street = String(c.tags['addr:street'] || '').toLowerCase();
  const near = [];
  for (const a of cell.addrs) near.push({ lat: a.lat, lon: a.lon, hn: a.hn, street: a.street });
  for (const w of cell.ways) {
    if (w.hn) { const p = ringCentroidSimple(w.ring); near.push({ lat: p[0], lon: p[1], hn: w.hn, street: '' }); }
  }
  for (const a of near) {
    if (String(a.hn).toLowerCase() !== hn) continue;
    if (street && a.street && String(a.street).toLowerCase() !== street) continue;
    if (metresBetween(c.ring[0], [a.lat, a.lon]) < 30) return shown + ' already in OSM here';
  }
  return '';
}

// Accepted objects near this candidate, shaped like a ctx cell so overlapVerdict
// takes it without changes. Excludes the candidate itself, which matters after an
// undo: the object can be back under review while its queue entry still exists.
function queuedNear(c) {
  const centre = c.kind === 'address' ? c.ring[0] : c.centroid;
  const ways = [];
  for (const q of queuedShapes) {
    if (q.key === c.key) continue;
    if (q.kind === 'area') continue;
    if (metresBetween(centre, ringCentroidSimple(q.ring)) > 200) continue;
    ways.push({ ring: q.ring, hn: q.hn });
  }
  return { ways, addrs: [] };
}

// Everything still queued for review, faint, so the shape of the batch and the
// next few steps are visible instead of arriving one surprise at a time. Asked
// for as "display all suspected buildings ... so we know where prolly we will
// jump to next", and it pairs with the nearest-neighbour ordering: what you see
// nearby genuinely is what comes next now.
const PENDING_CAP = 400;

function drawPending() {
  if (!pendingLayer) return;
  pendingLayer.clearLayers();
  if (!candidates.length) return;
  const b = map.getBounds().pad(0.25);
  const c = cur();
  let n = 0;
  for (let i = cursor; i < candidates.length && n < PENDING_CAP; i++) {
    const p = candidates[i];
    if (p === c) continue;                       // the current one is drawn solid
    if (!b.contains(L.latLng(p.centroid))) continue;
    n++;
    // The same pink as the candidate, but thin, dashed and mostly transparent, so
    // it reads as "not this one yet" rather than competing with it.
    const opts = { color: '#ff2d95', weight: 1, opacity: 0.4, dashArray: '3,3',
                   fillColor: '#ff2d95', fillOpacity: 0.05, interactive: false };
    if (p.kind === 'address') L.circleMarker(p.ring[0], Object.assign({ radius: 5 }, opts)).addTo(pendingLayer);
    else L.polygon(p.ring, opts).addTo(pendingLayer);
  }
}

function drawContext() {
  ctxLayer.clearLayers();
  const c = cur();
  if (!c) return;
  const centre = c.kind === 'address' ? c.ring[0] : c.centroid;

  // Faint centroid dots for whatever the cheap area-wide index knows about,
  // so context outside the detailed cell is not simply absent.
  for (const [la, lo] of ctxPts) {
    if (metresBetween(centre, [la, lo]) > 150) continue;
    L.circleMarker([la, lo], {
      radius: 3, color: '#22d3ee', weight: 1, opacity: 0.5,
      fillOpacity: 0.2, fillColor: '#22d3ee', interactive: false,
    }).addTo(ctxLayer);
  }

  // Everything already accepted this session, in ochre. Without this the only way
  // to notice that a candidate overlaps one you accepted a moment ago was to
  // remember it: accepted objects are not in OSM yet, so they are absent from the
  // /map cell that supplies the cyan footprints, and nothing else drew them.
  for (const q of queuedShapes) {
    if (q.key === cur().key) continue;
    if (metresBetween(centre, ringCentroidSimple(q.ring)) > 250) continue;
    L.polygon(q.holes.length ? [q.ring, ...q.holes] : q.ring, {
      color: '#e0a326', weight: 2, dashArray: '6,2',
      fillColor: '#e0a326', fillOpacity: 0.12, interactive: false,
    }).addTo(ctxLayer);
  }

  const cell = ctxCells.get(ctxCellKey(centre[0], centre[1]));
  if (!cell || cell === 'loading' || cell === 'failed') {
    // Fetch, then redraw this same candidate if it is still the current one.
    loadCtxCell(centre[0], centre[1]).then((got) => {
      if (got && cur() === c) { drawContext(); paintChrome(); }
    });
    return;
  }

  for (const w of cell.ways) {
    L.polygon(w.ring, {
      color: '#22d3ee', weight: 1.5, dashArray: '4,3',
      fillColor: '#22d3ee', fillOpacity: 0.10, interactive: false,
    }).addTo(ctxLayer);
  }
  for (const a of cell.addrs) {
    L.circleMarker([a.lat, a.lon], {
      radius: 4, color: '#22d3ee', weight: 2, fillOpacity: 0.8,
      fillColor: '#0b1620', interactive: false,
    }).addTo(ctxLayer);
    L.marker([a.lat, a.lon], {
      interactive: false,
      icon: L.divIcon({ className: 'ctxHn', html: esc(String(a.hn)), iconSize: null }),
    }).addTo(ctxLayer);
  }
}

function fitShape() {
  const c = cur();
  if (!c) return;
  // ResizeObserver is reactive — it runs a frame later, while ingest hides the
  // start panel and re-fits inside a single synchronous task. Without this the
  // tiling would be right and the fit still computed against the old height.
  syncMapSize();
  if (c.kind === 'building') {
    map.fitBounds(L.latLngBounds(c.ring).pad(1.4), { animate: false, maxZoom: 20 });
  } else {
    map.setView(c.ring[0], 19, { animate: false });
  }
}

function paintChrome() {
  const c = cur();
  $('qCount').textContent = (cursor + 1) + ' / ' + candidates.length;
  $('locality').textContent = c ? (c.tags['addr:city'] || c.tags['addr:place'] || c.kind) : '';
  // The centroid index gives a first guess; real footprints from the detailed
  // cell override it, because containment is what actually decides a duplicate.
  let tier = c ? c.tier : 0;
  let note = '';
  if (c) {
    const centre = c.kind === 'address' ? c.ring[0] : c.centroid;
    const cell = ctxCells.get(ctxCellKey(centre[0], centre[1]));
    if (cell && cell !== 'loading' && cell !== 'failed') {
      const v = overlapVerdict(c, cell);
      if (v && v.tier !== null) { tier = v.tier; note = v.why; }
      const dup = duplicateAddress(c, cell);
      if (dup) { tier = 2; note = dup; }
    } else if (cell === 'loading') note = 'checking OSM…';
    else if (cell === 'failed') note = 'OSM check failed';
    // Checked last so it wins the label: overlapping something you accepted a
    // moment ago is a mistake you can still fix, where overlapping OSM might be a
    // considered decision. This check does not depend on the /map cell at all, so
    // it still reports while that is loading or after it has failed.
    const q = overlapVerdict(c, queuedNear(c), 'a building you already accepted');
    if (q && q.tier !== null) { tier = q.tier; note = q.why; }
  }
  $('tier').textContent = ['clear', 'near', 'overlap'][tier];
  $('tier').className = 'tier t' + tier;
  $('dist').textContent = note ? note
    : c && c.dist < 1e8 ? fmt(c.dist, 0) + ' m' : 'no OSM near';
  const d = c ? driftMeters() : 0;
  $('drift').textContent = d > 0.05 ? '+' + fmt(d, 1) + ' m moved' : '';
  paintSrcAge(c);
  $('stepLbl').textContent = fmt(S.driftStep, 2).replace(/0$/, '') + ' m';
}

// How old the source geometry is, and whether BDOT thought the building was
// still going up. Neither is an OSM tag and neither is uploaded, but both change
// what a reviewer should conclude from the imagery:
//
//  - `aktualnosc_geometrii` is the currency date of the outline. Across 644
//    sampled buildings roughly half were 2018 or older and a third dated from
//    2015, so a building demolished for a road built since then is still in the
//    data, correctly, as far as BDOT is concerned. BDOT10k is not the cadastre
//    (EGiB), and the two disagree.
//  - `status_bdot = w budowie` means it was under construction at survey time.
//    It may now be finished, altered, or never completed, and `building=yes` is
//    probably the wrong tag for it.
const YEAR_MS = 365.25 * 24 * 3600e3;

function paintSrcAge(c) {
  const el = $('srcAge');
  if (!c || (!c.srcDate && !c.srcStatus)) { el.textContent = ''; el.className = ''; return; }
  const parts = [];
  let cls = 'fresh';
  if (c.srcDate) {
    const t = Date.parse(c.srcDate);
    if (Number.isFinite(t)) {
      const yrs = (Date.now() - t) / YEAR_MS;
      parts.push('geom ' + c.srcDate.slice(0, 4) + ' · ' + yrs.toFixed(0) + ' yr');
      cls = yrs >= 7 ? 'stale' : yrs >= 3 ? 'aging' : 'fresh';
    } else {
      parts.push('geom ' + c.srcDate);
    }
  }
  if (c.srcStatus && c.srcStatus !== 'eksploatowany') {
    parts.push(c.srcStatus);
    cls = 'stale';
  }
  el.textContent = parts.join(' · ');
  el.className = cls;
  el.title = 'BDOT10k geometry currency' +
    (c.srcStatus ? ', status ' + c.srcStatus : '') +
    '. Not the cadastre (EGiB) — the two can disagree.';
}

function paintTags() {
  const c = cur();
  const box = $('tags');
  box.innerHTML = '';
  if (!c) return;
  const keys = Object.keys(c.tags).filter((k) => !S.dropKeys.includes(k));
  for (const k of keys) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.innerHTML = '<b>' + esc(k) + '</b>' + esc(c.tags[k]);
    // Opens the editor focused on this tag. It used to delete the tag outright
    // on a single tap, with no confirmation and no undo — far too easy to hit by
    // accident on a phone, and the only tag interaction there was.
    chip.onclick = () => openTagEditor(k);
    box.appendChild(chip);
  }
  const add = document.createElement('button');
  add.className = 'chip add';
  add.textContent = keys.length ? '+ tag' : '+ add tags';
  add.onclick = () => openTagEditor(null);
  box.appendChild(add);
}

// Keys worth one tap on a phone: what BDOT/PRG candidates routinely need
// corrected or completed against the imagery.
const TAG_PRESETS = [
  'building', 'building:levels', 'addr:housenumber', 'addr:street', 'addr:city',
  'addr:postcode', 'amenity', 'shop', 'man_made', 'note', 'fixme', 'demolished:building',
];

let tagDraft = null;   // [[key, value], ...] while the sheet is open

function openTagEditor(focusKey) {
  const c = cur();
  if (!c) return;
  tagDraft = Object.entries(c.tags).map(([k, v]) => [k, String(v)]);
  if (!tagDraft.length) tagDraft.push(['', '']);
  paintTagRows(focusKey);
  $('tagSheet').classList.add('open');
}

function closeTagEditor() {
  $('tagSheet').classList.remove('open');
  tagDraft = null;
}

function paintTagRows(focusKey) {
  const box = $('tagRows');
  box.innerHTML = '';
  const seen = new Map();
  for (const [k] of tagDraft) {
    const t = k.trim();
    if (t) seen.set(t, (seen.get(t) || 0) + 1);
  }
  tagDraft.forEach(([k, v], i) => {
    const row = document.createElement('div');
    row.className = 'tagRow';
    const ki = document.createElement('input');
    ki.className = 'k';
    ki.value = k;
    ki.placeholder = 'key';
    ki.autocapitalize = 'none';
    ki.spellcheck = false;
    if (k.trim() && seen.get(k.trim()) > 1) ki.classList.add('dup');
    ki.oninput = () => { tagDraft[i][0] = ki.value; };
    // Re-render on blur so duplicate highlighting stays honest without
    // stealing focus mid-typing.
    ki.onblur = () => paintTagRows(null);
    const vi = document.createElement('input');
    vi.value = v;
    vi.placeholder = 'value';
    vi.autocapitalize = 'none';
    vi.spellcheck = false;
    vi.oninput = () => { tagDraft[i][1] = vi.value; };
    const del = document.createElement('button');
    del.textContent = '×';
    del.title = 'Remove this tag';
    del.onclick = () => { tagDraft.splice(i, 1); paintTagRows(null); };
    row.appendChild(ki);
    row.appendChild(vi);
    row.appendChild(del);
    box.appendChild(row);
    if (focusKey !== null && k === focusKey) setTimeout(() => vi.focus(), 30);
  });

  const pre = $('tagPresets');
  pre.innerHTML = '';
  const have = new Set(tagDraft.map(([k]) => k.trim()));
  for (const k of TAG_PRESETS) {
    if (have.has(k)) continue;
    const b = document.createElement('button');
    b.textContent = '+ ' + k;
    b.onclick = () => {
      tagDraft.push([k, '']);
      paintTagRows(k);
    };
    pre.appendChild(b);
  }
}

// Draft rows to a tag object. Pure, so it can be tested without a DOM.
// A key with no value is not a tag OSM will accept and an empty key is
// meaningless, so both are dropped rather than uploaded as junk; a half-filled
// row is counted as dropped so the user is told, while a wholly blank row is
// just an unused input and is silent. On a duplicate key the last row wins,
// matching the visible top-to-bottom reading of the sheet.
function tagsFromDraft(draft) {
  const tags = {};
  let dropped = 0;
  for (const [k, v] of draft) {
    const key = String(k).trim();
    const val = String(v).trim();
    if (!key || !val) { if (key || val) dropped++; continue; }
    tags[key] = val;
  }
  return { tags, dropped };
}

function commitTags() {
  const c = cur();
  if (!c || !tagDraft) { closeTagEditor(); return; }
  const { tags: next, dropped } = tagsFromDraft(tagDraft);
  const before = JSON.stringify(c.tags);
  if (JSON.stringify(next) === before) { closeTagEditor(); return; }
  pushUndo();
  c.tags = next;
  c.tagsEdited = true;
  closeTagEditor();
  paintTags();
  paintChrome();
  toast(Object.keys(next).length + ' tags' + (dropped ? ', ' + dropped + ' incomplete dropped' : ''));
}

async function autoAlign() {
  const c = cur();
  if (!c) return;
  if (c.kind === 'area') {
    toast('Auto-fit correlates building edges against imagery — not meaningful for land cover');
    return;
  }
  if (c.kind !== 'building') { toast('Auto-fit works on outlines only'); return; }
  const btn = $('autoBtn');
  btn.classList.add('busy');
  try {
    const src = imagerySource();
    if (src.xyz) throw new Error('Auto-align needs a WMS source, not XYZ tiles');
    const cen = centroid(c.ring);
    let ext = 0;
    for (const [la, lo] of c.ring) {
      ext = Math.max(ext, Math.hypot((la - cen[0]) * 111320, (lo - cen[1]) * 111320 * Math.cos(cen[0] * Math.PI / 180)));
    }
    const half = Math.max(ext * 2.2, 32);
    const [cx, cy] = merc(cen[0], cen[1]);
    const scale = 1 / Math.cos(cen[0] * Math.PI / 180);
    const hm = half * scale;
    const bbox = [cx - hm, cy - hm, cx + hm, cy + hm];
    const SZ = 384;
    const url = src.url + (src.url.includes('?') ? '&' : '?') +
      'SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&CRS=EPSG:3857&FORMAT=image/jpeg' +
      '&STYLES=&LAYERS=' + encodeURIComponent(src.layers) +
      '&WIDTH=' + SZ + '&HEIGHT=' + SZ + '&BBOX=' + bbox.join(',');

    const resp = await fetchOk(url, {
      mode: 'cors', tries: 4, timeout: 20000, retryOn: transientImagery,
    });
    const bmp = await createImageBitmap(await resp.blob());
    const cv = document.createElement('canvas');
    cv.width = SZ; cv.height = SZ;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0, SZ, SZ);
    const data = g.getImageData(0, 0, SZ, SZ).data;

    const rp = wasm.alloc(data.length);
    new Uint8Array(wasm.memory.buffer, rp, data.length).set(data);
    wasm.gradientFrom(rp, SZ, SZ);
    wasm.release(rp);

    const toPx = ([la, lo]) => {
      const [x, y] = merc(la, lo);
      return [(x - bbox[0]) / (bbox[2] - bbox[0]) * SZ, (bbox[3] - y) / (bbox[3] - bbox[1]) * SZ];
    };
    let ringPx = c.ring.map(toPx);
    let p = W.f64(ringPx.flat());
    wasm.edgeSamples(p, c.ring.length, 1.0);
    wasm.alignOffset(S.maxShift, 1.0);
    let ox = wasm.outFA(), oy = wasm.outFB();
    const z = wasm.outIA() / 100;
    const gain = wasm.outIB() / 100;
    wasm.release(p);

    ringPx = ringPx.map(([x, y]) => [x + ox, y + oy]);
    p = W.f64(ringPx.flat());
    wasm.edgeSamples(p, c.ring.length, 1.0);
    wasm.alignOffset(3, 0.25);
    ox += wasm.outFA(); oy += wasm.outFB();
    wasm.release(p);

    if (z < 1.6 || gain < 1.03) {
      toast('Low confidence (z=' + fmt(z, 1) + '), left as-is — nudge by hand', 'warn');
      return;
    }
    const mppx = (bbox[2] - bbox[0]) / SZ / scale;
    pushUndo();
    const mLat = 111320, mLon = 111320 * Math.cos(cen[0] * Math.PI / 180);
    const dxm = ox * mppx, dym = -oy * mppx;
    c.ring = c.ring.map(([la, lo]) => [la + dym / mLat, lo + dxm / mLon]);
    c.moved = true;
    shape.setLatLngs(c.ring);
    drawVertices();
    paintChrome();
    toast('Shifted ' + fmt(Math.hypot(dxm, dym), 1) + ' m  ·  z=' + fmt(z, 1) + '  ·  ' + fmt(gain, 2) + '× edge gain');
  } catch (err) {
    // A tainted canvas, or a network-shaped rejection that survived every
    // retry, means CORS. A timeout or an HTTP status does not — those are
    // worth reporting but auto-fit stays available.
    if (/tainted|SecurityError/i.test(String(err)) || err.kind === 'network') {
      markPixelsBlocked('imagery server blocks pixel reads');
    } else {
      toast('Auto-fit failed: ' + String(err.message || err), 'warn');
    }
  } finally {
    btn.classList.remove('busy');
  }
}

async function verdict(kind) {
  const c = cur();
  if (!c) return;
  await dbPut('decisions', c.key, { verdict: kind, t: Date.now() });
  if (kind === 'reject') reportReject(c);
  if (kind === 'accept') {
    await dbPut('queue', c.key, {
      kind: c.kind, ring: c.ring, tags: c.tags, t: Date.now(),
      // Without holes here an approved forest-island-in-farmland uploads solid.
      holes: (c.holes || []).filter((h) => h && h.length >= 3),
      moved: !!c.moved, city: c.tags['addr:city'] || '',
    });
  }
  const el = $('map');
  el.classList.add(kind === 'accept' ? 'flickR' : kind === 'reject' ? 'flickL' : 'flickU');
  setTimeout(() => el.classList.remove('flickR', 'flickL', 'flickU'), 130);
  cursor++;
  await refreshQueueBadge();
  show();
}

// Geometry of everything accepted but not yet uploaded. Held in memory because
// drawContext runs on every candidate and must not wait on IndexedDB, and kept in
// step here because refreshQueueBadge already runs after every verdict, after a
// drop from the review sheet, after an upload and at boot.
let queuedShapes = [];

async function refreshQueueBadge() {
  const q = await dbAll('queue');
  queuedShapes = q
    .filter((e) => e.val && Array.isArray(e.val.ring) && e.val.ring.length >= 3)
    .map((e) => ({
      key: e.key, kind: e.val.kind, ring: e.val.ring,
      holes: e.val.holes || [],
      hn: (e.val.tags && e.val.tags['addr:housenumber']) || '',
    }));
  $('upCount').textContent = q.length;
  $('uploadBtn').disabled = !q.length;
}

function osmChange(items, changesetId) {
  let id = -1;
  const create = [];

  // One node per coordinate for the whole changeset, keyed at OSM's own 7-decimal
  // limit. Adjacent land-cover parcels are conditioned upstream to share exact
  // boundary coordinates, and emitting a fresh node per ring would have thrown
  // that away — leaving duplicate coincident nodes and no shared topology, which
  // is the gap-versus-overlap problem the importer works hard to avoid. It also
  // shrinks a farmland changeset considerably.
  const nodeIds = new Map();
  const nodeFor = ([la, lo]) => {
    const key = la.toFixed(7) + ',' + lo.toFixed(7);
    let nid = nodeIds.get(key);
    if (nid === undefined) {
      nid = id--;
      nodeIds.set(key, nid);
      create.push(`<node id="${nid}" lat="${la.toFixed(7)}" lon="${lo.toFixed(7)}" changeset="${changesetId}" version="0"/>`);
    }
    return nid;
  };
  const wayFor = (ring, tagXml) => {
    const ids = ring.map(nodeFor);
    const nds = ids.concat([ids[0]]).map((r) => `<nd ref="${r}"/>`).join('');
    const wid = id--;
    create.push(`<way id="${wid}" changeset="${changesetId}" version="0">${nds}${tagXml || ''}</way>`);
    return wid;
  };

  for (const it of items) {
    const tagXml = Object.entries(it.tags).filter(([k]) => !S.dropKeys.includes(k))
      .map(([k, v]) => `<tag k="${esc(k)}" v="${esc(v)}"/>`).join('');
    if (it.kind === 'address') {
      const [la, lo] = it.ring[0];
      create.push(`<node id="${id--}" lat="${la.toFixed(7)}" lon="${lo.toFixed(7)}" changeset="${changesetId}" version="0">${tagXml}</node>`);
      continue;
    }
    const holes = (it.holes || []).filter((h) => h && h.length >= 3);
    if (!holes.length) {
      wayFor(it.ring, tagXml);
      continue;
    }
    // Holes present, so the tags belong on a type=multipolygon relation and the
    // rings stay untagged. Tagging the outer way instead would fill the hole in.
    const outer = wayFor(it.ring, '');
    const members = ['<member type="way" ref="' + outer + '" role="outer"/>'];
    for (const h of holes) {
      members.push('<member type="way" ref="' + wayFor(h, '') + '" role="inner"/>');
    }
    create.push('<relation id="' + (id--) + '" changeset="' + changesetId + '" version="0">' +
      members.join('') + '<tag k="type" v="multipolygon"/>' + tagXml + '</relation>');
  }
  return `<osmChange version="0.6" generator="orto-review"><create>${create.join('')}</create></osmChange>`;
}

const OSM = 'https://www.openstreetmap.org';
const API = OSM + '/api/0.6';

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The authorize and token requests must send a byte-identical redirect_uri, and
// it must equal the registered one. These were computed in two places and did
// not agree: login stripped any fragment, finishLogin did not.
function redirectUri() {
  return location.href.split('?')[0].split('#')[0];
}

async function login() {
  if (!S.clientId) { openSettings(); toast('Paste an OAuth client ID first', 'warn'); return; }
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  sessionStorage.setItem('pkce', verifier);
  const redirect = redirectUri();
  location.href = OSM + '/oauth2/authorize?client_id=' + encodeURIComponent(S.clientId) +
    '&redirect_uri=' + encodeURIComponent(redirect) + '&response_type=code' +
    '&scope=' + encodeURIComponent('read_prefs write_api') +
    '&code_challenge=' + challenge + '&code_challenge_method=S256';
}

async function finishLogin() {
  const p = new URLSearchParams(location.search);
  const code = p.get('code');
  if (!code) return;
  const verifier = sessionStorage.getItem('pkce');
  const redirect = redirectUri();
  history.replaceState({}, '', redirect);
  if (!verifier) {
    // sessionStorage is per-tab, so finishing the flow in a different tab or
    // window loses the verifier. This used to return in silence.
    authFail('the PKCE verifier was lost — start and finish sign-in in the same tab');
    return;
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code', code, redirect_uri: redirect,
    client_id: S.clientId, code_verifier: verifier,
  });
  const r = await fetch(OSM + '/oauth2/token', { method: 'POST', body });
  if (!r.ok) {
    // The status alone was all this used to report, which hid the one thing
    // that identifies the fault. OSM answers 401 invalid_client when the app is
    // registered as confidential, or when the client id is simply unknown.
    const j = await r.json().catch(() => null);
    const err = (j && j.error) || ('HTTP ' + r.status);
    let hint;
    if (r.status === 401 || err === 'invalid_client') {
      hint = 'the OAuth app must be a public client — edit it on openstreetmap.org and untick ' +
        '“Confidential application?”, and check the client ID matches exactly';
    } else if (err === 'invalid_grant') {
      hint = 'the redirect URI must equal ' + redirect +
        ' exactly, and an authorization code can only be used once — start sign-in again';
    } else {
      hint = (j && j.error_description) || 'see the browser console for the response';
    }
    console.warn('oauth token exchange failed', r.status, j);
    authFail(err + ' — ' + hint);
    return;
  }
  const j = await r.json();
  await dbPut('kv', 'token', j.access_token);
  sessionStorage.removeItem('pkce');
  await dbDel('kv', 'authError');
  paintUser();
  toast('Signed in to OpenStreetMap');
}

// A toast lasts three seconds and this needs reading while you fix the
// registration, so the reason is also parked in settings beside the client ID.
async function authFail(msg) {
  await dbPut('kv', 'authError', msg).catch(() => {});
  const el = $('authNote');
  if (el) { el.textContent = 'Last sign-in attempt: ' + msg; el.style.color = 'var(--ochre)'; }
  toast('Sign-in failed: ' + msg, 'warn');
  openSettings();
}

async function token() { return await dbGet('kv', 'token'); }

async function paintUser() {
  const t = await token();
  $('userBtn').textContent = t ? 'signed in' : 'sign in';
  $('userBtn').className = t ? 'ok' : '';
}

// The tags every changeset carries. Built as pairs so the review sheet can show
// exactly what will be sent instead of describing it.
//
// There is no `hashtags` tag. It read `#orto-review`, which tells a reviewer
// nothing they cannot see from `created_by`, and hashtags are for campaigns that
// someone is actually coordinating. `host` and `repo` replace it: `host` is what
// iD and Rapid use for the editor's address, and `repo` points at the source so
// anyone querying an edit can read the code that made it.
function csTags(count, city) {
  const t = [
    ['created_by', 'orto-review'],
    ['comment', S.comment + ' — ' + city],
    ['source', S.source],
    ['host', location.href.split('?')[0].split('#')[0]],
  ];
  if (S.repo) t.push(['repo', S.repo]);
  if (S.importTag) t.push(['import', 'yes']);
  t.push(['review_count', String(count)]);
  return t;
}

// ---- Land cover, from the importer's own server -----------------------------
// Kept deliberately separate from the buildings path. Buildings come from vector
// tiles and need nothing here, so with no server configured or reachable the
// building review still works in full — that separation is a requirement, not a
// side effect, so do not fold these together.
//
// The geometry work stays in vibe-osm-importer: it clips against fresh Overpass,
// de-overlaps exactly, preserves holes and drops slivers. serve_review.py only
// indexes and serves what it wrote. Nothing is re-derived here; this fetches,
// filters by class, and reviews.

// Every class the importer emits. Order is the order shown in settings.
const LC_CLASSES = [
  'landuse=farmland', 'landuse=meadow', 'landuse=grass',
  'landuse=forest', 'natural=wood', 'natural=scrub',
  'landuse=orchard', 'landuse=vineyard', 'landuse=allotments',
  'natural=sand', 'natural=bare_rock', 'natural=tree', 'building=yes',
];

function lcServer() {
  return (S.lcServer || '').trim().replace(/\/+$/, '');
}

// A class is reviewed unless it has been switched off, so a class the importer
// starts emitting later shows up rather than being silently dropped.
function lcEnabled(cls) {
  return !(S.lcOff || []).includes(cls);
}

function candidateClass(c) {
  for (const k of AREA_KEYS.concat(['building'])) {
    if (c.tags[k]) return k + '=' + c.tags[k];
  }
  return '';
}

async function lcIndex() {
  const base = lcServer();
  if (!base) throw new Error('no land-cover server set');
  const r = await fetchOk(base + '/index', { tries: 2, timeout: 20000 });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error('unexpected index shape');
  return j;
}

const bboxHits = (tiles, b) => tiles.filter((t) => {
  const q = t.bbox;
  return Array.isArray(q) && q.length === 4 &&
    q[0] <= b.getEast() && q[2] >= b.getWest() &&
    q[1] <= b.getNorth() && q[3] >= b.getSouth();
});

async function loadLandCover() {
  const base = lcServer();
  if (!base) { openSettings(); toast('Set the land-cover server first', 'warn'); return; }
  setStage('Asking the land-cover server');
  try {
    const tiles = await lcIndex();
    const b = dataBounds();
    let hits = bboxHits(tiles, b);
    if (!hits.length) {
      setStage('');
      // Being told where the work actually is beats "nothing here".
      const near = tiles.slice().sort((x, y) =>
        metresBetween([b.getCenter().lat, b.getCenter().lng], [(x.bbox[1] + x.bbox[3]) / 2, (x.bbox[0] + x.bbox[2]) / 2]) -
        metresBetween([b.getCenter().lat, b.getCenter().lng], [(y.bbox[1] + y.bbox[3]) / 2, (y.bbox[0] + y.bbox[2]) / 2]))[0];
      toast(tiles.length
        ? 'No land-cover tile covers this view. Nearest of ' + tiles.length + ' is at ' +
          ((near.bbox[1] + near.bbox[3]) / 2).toFixed(3) + ', ' + ((near.bbox[0] + near.bbox[2]) / 2).toFixed(3)
        : 'The server has no tiles — run the importer first', 'warn');
      return;
    }
    // Cap the work: a whole voivodeship of tiles would be a very long download.
    hits = hits.slice(0, 12);
    const list = [];
    let failed = 0;
    for (let i = 0; i < hits.length; i++) {
      setStage('Land cover ' + (i + 1) + ' / ' + hits.length);
      try {
        const r = await fetchOk(base + '/tile/' + encodeURIComponent(hits[i].id) + '.osm',
          { tries: 2, timeout: 40000 });
        // parseOsmXml handles the relations, so holes survive as holes.
        for (const c of parseOsmXml(await r.text())) list.push(c);
      } catch (err) { failed++; }
    }
    const kept = list.filter((c) => {
      const cls = candidateClass(c);
      return cls ? lcEnabled(cls) : true;
    });
    const dropped = list.length - kept.length;
    if (!kept.length) {
      setStage('');
      toast(list.length
        ? 'All ' + list.length + ' features are in classes you have switched off'
        : 'Those tiles held nothing reviewable', 'warn');
      return;
    }
    const holes = kept.reduce((n, c) => n + ((c.holes || []).length ? 1 : 0), 0);
    await ingest(kept, kept.length + ' land-cover features from ' + hits.length + ' tile' +
      (hits.length > 1 ? 's' : '') +
      (holes ? ' · ' + holes + ' with holes' : '') +
      (dropped ? ' · ' + dropped + ' filtered out' : '') +
      (failed ? ' · ' + failed + ' tile(s) failed' : ''));
  } catch (err) {
    setStage('');
    toast('Land-cover server: ' + classify(err) +
      ' — check the https URL in settings and that cloudflared is up', 'warn');
  }
}


function paintLcClasses() {
  const box = $('lcClasses');
  if (!box) return;
  box.innerHTML = '';
  for (const cls of LC_CLASSES) {
    const id = 'lc_' + cls.replace(/[^a-z0-9]/gi, '_');
    const lab = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = id;
    cb.checked = lcEnabled(cls);
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(cls));
    box.appendChild(lab);
  }
}

async function paintLcStatus() {
  const el = $('lcStatus');
  const btn = $('lcBtn');
  const base = lcServer();
  if (!base) {
    if (el) el.textContent = '';
    if (btn) { btn.disabled = true; btn.title = 'Set a land-cover server in settings'; }
    return;
  }
  if (btn) { btn.disabled = false; btn.title = ''; }
  if (!el) return;
  el.textContent = 'Checking…';
  try {
    const r = await fetchOk(base + '/health', { tries: 1, timeout: 12000 });
    const j = await r.json();
    el.textContent = 'Server ok — ' + j.tiles + ' tile(s) in ' + (j.dir || '?');
    el.style.color = 'var(--verify)';
  } catch (err) {
    el.textContent = 'Not reachable: ' + classify(err);
    el.style.color = 'var(--ochre)';
  }
}

// ---- Open in iD ------------------------------------------------------------
// For the times when this app's one-object-at-a-time view is the wrong tool:
// iD has the imagery switcher, measurement, history, relation editing and so on.
//
// Ids are from the editor-layer-index, which is the same catalogue iD reads, so
// iD opens on the imagery you were just reviewing against rather than its
// default. An unrecognised id is ignored by iD rather than breaking, so a stale
// entry here degrades to "iD picks its own background".
const ID_BACKGROUND = {
  'orto-high': 'Geoportal2-PL-HighResolution-aerial_image_WMS',
  'orto-std': 'Geoportal2-PL-aerial_image_WMS',
  'orto-archive': 'Geoportal2-PL-aerial_archival_image_WMS',
  // The budynki proxy fronts StandardResolution, so this is the same picture.
  'orto-proxy': 'Geoportal2-PL-aerial_image_WMS',
};

function idEditorUrl(c) {
  const centre = c.kind === 'address' ? c.ring[0] : centroid(c.ring);
  const z = Math.max(17, Math.min(21, map.getZoom()));
  const hash = ['map=' + z.toFixed(0) + '/' + centre[0].toFixed(5) + '/' + centre[1].toFixed(5)];
  const bg = ID_BACKGROUND[S.imagery];
  if (bg) hash.push('background=' + encodeURIComponent(bg));
  // Prefill the changeset fields so an edit made over there is still attributed
  // the same way as one made here.
  const city = c.tags['addr:city'] || c.tags['addr:place'] || '';
  if (S.comment) hash.push('comment=' + encodeURIComponent(S.comment + (city ? ' — ' + city : '')));
  if (S.source) hash.push('source=' + encodeURIComponent(S.source));
  return OSM + '/edit?editor=id#' + hash.join('&');
}

// Google's documented Maps URLs form, not a scraped /maps/@lat,lon,19z/data=…
// path — the latter encodes the view in an undocumented blob that has changed
// before. basemap=satellite because a second, usually differently dated aerial
// image is the point; Street View is one tap away once it is open.
function googleMapsUrl(c) {
  const centre = c.kind === 'address' ? c.ring[0] : centroid(c.ring);
  const z = Math.max(17, Math.min(21, map.getZoom()));
  return 'https://www.google.com/maps/@?api=1&map_action=map' +
    '&center=' + centre[0].toFixed(6) + ',' + centre[1].toFixed(6) +
    '&zoom=' + z.toFixed(0) + '&basemap=satellite';
}

function openInGoogleMaps() {
  const c = cur();
  if (!c) return;
  window.open(googleMapsUrl(c), '_blank', 'noopener');
}

function openInId() {
  const c = cur();
  if (!c) return;
  // A new tab, deliberately: navigating away would discard the in-memory queue
  // of candidates, and only the verdicts are persisted.
  window.open(idEditorUrl(c), '_blank', 'noopener');
  // Worth saying once: the candidate is not in OSM yet, so iD cannot select it.
  toast('Opened iD at this spot. The candidate itself is not in OSM yet, so only ' +
    'existing objects are editable there.');
}

// ---- Review before sending -------------------------------------------------
// The up-arrow used to upload immediately. Nothing between an accidental tap and
// a live changeset, and no way to see what had accumulated across sessions.

function queueLabel(it) {
  const t = it.tags || {};
  if (it.kind === 'address') {
    const hn = t['addr:housenumber'] || '?';
    const st = t['addr:street'] || t['addr:place'] || '';
    return { title: hn + (st ? ' ' + st : ''), what: 'address' };
  }
  if (it.kind === 'area') {
    const key = AREA_KEYS.find((k) => t[k]) || 'landuse';
    const holes = (it.holes || []).length;
    return {
      title: key + '=' + t[key] + (holes ? '  (' + holes + ' hole' + (holes > 1 ? 's' : '') + ')' : ''),
      what: 'area',
    };
  }
  return { title: 'building=' + (t.building || 'yes'), what: 'building' };
}

function changesetPreview(count, city) {
  return csTags(count, city).map(([k, v]) => k + ' = ' + v).join('\n');
}

async function openQueueSheet() {
  const rows = (await dbAll('queue')).map((e) => Object.assign({ key: e.key }, e.val));
  rows.sort((a, b) => (a.city || '').localeCompare(b.city || '') || (a.t || 0) - (b.t || 0));
  const box = $('queueList');
  box.innerHTML = '';
  if (!rows.length) {
    box.innerHTML = '<p class="hint">Nothing queued.</p>';
  }
  for (const it of rows) {
    const { title, what } = queueLabel(it);
    const row = document.createElement('div');
    row.className = 'qRow';
    const main = document.createElement('div');
    main.className = 'qMain';
    const tags = Object.entries(it.tags || {})
      .filter(([k]) => !S.dropKeys.includes(k))
      .map(([k, v]) => k + '=' + v).join('  ');
    main.innerHTML = '<div class="qTitle"><span class="k">' + esc(what) + '</span> ' + esc(title) +
      (it.moved ? ' <span class="qMoved">· nudged</span>' : '') + '</div>' +
      '<div class="qSub">' + esc(it.city || 'no city') + ' · ' + esc(tags || 'no tags') + '</div>';
    const del = document.createElement('button');
    del.textContent = '×';
    del.title = 'Drop from the upload';
    del.onclick = async () => {
      await dbDel('queue', it.key);
      // Forget the accept too, or the object is silently dropped for good: it
      // would be filtered out of every future load as "already decided".
      await dbDel('decisions', it.key);
      await refreshQueueBadge();
      openQueueSheet();
    };
    row.appendChild(main);
    row.appendChild(del);
    box.appendChild(row);
  }
  const city = rows.length ? (rows[0].city || 'Poland') : 'Poland';
  $('csPreview').textContent = rows.length
    ? 'First changeset would carry:\n' + changesetPreview(Math.min(rows.length, S.batchSize), city)
    : '';
  $('queueUpload').textContent = rows.length ? 'Upload ' + rows.length : 'Upload';
  $('queueUpload').disabled = !rows.length;
  $('queueSheet').classList.add('open');
}

function closeQueueSheet() { $('queueSheet').classList.remove('open'); }

async function uploadQueue() {
  const t = await token();
  if (!t) { toast('Sign in first', 'warn'); return; }
  const all = (await dbAll('queue')).map((e) => Object.assign({ key: e.key }, e.val));
  if (!all.length) return;
  closeQueueSheet();
  all.sort((a, b) => (a.city || '').localeCompare(b.city || '') || a.ring[0][0] - b.ring[0][0]);
  const H = { Authorization: 'Bearer ' + t, 'Content-Type': 'text/xml' };
  let done = 0;
  setStage('Uploading 0 / ' + all.length);
  for (let i = 0; i < all.length; i += S.batchSize) {
    const batch = all.slice(i, i + S.batchSize);
    const city = batch[0].city || 'Poland';
    const cs = '<osm><changeset>' +
      csTags(batch.length, city).map(([k, v]) => `<tag k="${esc(k)}" v="${esc(v)}"/>`).join('') +
      '</changeset></osm>';
    try {
      let r = await fetch(API + '/changeset/create', { method: 'PUT', headers: H, body: cs });
      if (!r.ok) throw new Error('changeset ' + r.status + ' ' + (await r.text()).slice(0, 120));
      const id = (await r.text()).trim();
      r = await fetch(API + '/changeset/' + id + '/upload', {
        method: 'POST', headers: H, body: osmChange(batch, id),
      });
      if (!r.ok) throw new Error('upload ' + r.status + ' ' + (await r.text()).slice(0, 200));
      await fetch(API + '/changeset/' + id + '/close', { method: 'PUT', headers: H });
      for (const b of batch) await dbDel('queue', b.key);
      done += batch.length;
      setStage('Uploading ' + done + ' / ' + all.length);
    } catch (err) {
      toast('Upload stopped: ' + (err.message || err), 'warn');
      break;
    }
  }
  setStage('');
  await refreshQueueBadge();
  if (done) toast('Uploaded ' + done + ' objects');
}

function setStage(s) {
  $('stage').textContent = s;
  $('stage').style.display = s ? 'block' : 'none';
}

function openSettings() { $('sheet').classList.add('open'); paintSettings(); }
function closeSettings() { $('sheet').classList.remove('open'); }

function paintSettings() {
  $('sImagery').value = S.imagery;
  $('sCustomUrl').value = S.customUrl;
  $('sCustomLayers').value = S.customLayers;
  $('sTileTTL').value = S.tileTTLdays;
  $('sCtxTTL').value = S.ctxTTLhours;
  $('sBatch').value = S.batchSize;
  $('sComment').value = S.comment;
  $('sSource').value = S.source;
  $('sRepo').value = S.repo;
  $('sLcServer').value = S.lcServer;
  paintLcClasses();
  paintLcStatus();
  $('sImportTag').checked = !!S.importTag;
  $('sClient').value = S.clientId;
  dbGet('kv', 'authError').then((m) => {
    const el = $('authNote');
    if (!el) return;
    el.textContent = m ? 'Last sign-in attempt: ' + m : '';
    el.style.color = 'var(--ochre)';
  }).catch(() => {});
  $('sApiBase').value = S.apiBase;
  $('sReport').checked = !!S.reportRejects;
  $('sSelfUrl').value = location.href.split('?')[0].split('#')[0];
  $('sShift').value = S.maxShift;
  $('sClear').value = S.clearRadius;
  cacheStats().then((c) => {
    $('cacheInfo').textContent = c.tiles + ' tiles, ' + fmt(c.bytes / 1048576, 1) + ' MB, ' + c.ctx + ' context sets';
  });
}

async function saveSettings() {
  S.imagery = $('sImagery').value;
  S.customUrl = $('sCustomUrl').value.trim();
  S.customLayers = $('sCustomLayers').value.trim();
  S.tileTTLdays = +$('sTileTTL').value || DEF.tileTTLdays;
  S.ctxTTLhours = +$('sCtxTTL').value || DEF.ctxTTLhours;
  S.batchSize = Math.max(1, Math.min(500, +$('sBatch').value || DEF.batchSize));
  S.comment = $('sComment').value;
  S.source = $('sSource').value;
  S.repo = $('sRepo').value.trim();
  S.lcServer = $('sLcServer').value.trim();
  S.lcOff = LC_CLASSES.filter((cls) => {
    const box = $('lc_' + cls.replace(/[^a-z0-9]/gi, '_'));
    return box && !box.checked;
  });
  S.importTag = $('sImportTag').checked;
  S.clientId = $('sClient').value.trim();
  S.apiBase = $('sApiBase').value.trim() || DEF.apiBase;
  S.reportRejects = $('sReport').checked;
  S.maxShift = Math.max(2, Math.min(24, +$('sShift').value || DEF.maxShift));
  S.clearRadius = Math.max(5, +$('sClear').value || DEF.clearRadius);
  await dbPut('kv', 'settings', S);
  makeImagery();
  if (candidates.length) { orderCandidates(); paintChrome(); }
  closeSettings();
  toast('Settings saved');
}

function bindUI() {
  $('file').onchange = (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); };
  // The markup ships this button disabled and labelled "Loading…", and nothing
  // used to turn it back on — setControls only touches #pad, #padTools and
  // #bar, so the file picker was permanently dead. Parsing needs wasm, and
  // bindUI runs after initWasm, so this is the right point to enable it.
  $('pickBtn').disabled = false;
  $('pickBtn').textContent = 'Open a .osm or GeoJSON file';
  $('pickBtn').onclick = () => $('file').click();
  $('loadAreaBtn').onclick = loadArea;
  $('lcBtn').onclick = loadLandCover;
  paintLcStatus();
  $('getDataBtn').onclick = () => {
    if (areaTooBig()) return;
    const b = dataBounds();
    window.open(areaDataUrl(), '_blank', 'noopener');
    toast('Asked for a ' + spanKm(b) + ' km box. If it is just <osm version="0.6"/> ' +
      'there is nothing pending here — pan elsewhere and try again.');
  };
  $('pasteBtn').onclick = loadPasted;
  $('randomBtn').onclick = loadRandom;
  $('moreBtn').onclick = () => $('start').classList.toggle('expanded');
  $('diagBtn').onclick = () => { $('diagOut').textContent = 'Running…'; $('diagOut').style.display = 'block'; diagnose(); };
  $('rejectBtn').onclick = () => verdict('reject');
  $('laterBtn').onclick = () => verdict('later');
  $('acceptBtn').onclick = () => verdict('accept');
  $('undoBtn').onclick = undo;
  $('autoBtn').onclick = autoAlign;
  $('idBtn').onclick = openInId;
  $('gmBtn').onclick = openInGoogleMaps;
  $('vertexToggle').onclick = (e) => {
    e.currentTarget.classList.toggle('on');
    drawVertices();
  };
  $('stepBtn').onclick = () => {
    const steps = [0.25, 0.5, 1, 2, 5];
    S.driftStep = steps[(steps.indexOf(S.driftStep) + 1) % steps.length];
    dbPut('kv', 'settings', S);
    paintChrome();
  };
  for (const b of document.querySelectorAll('[data-dir]')) {
    const [dx, dy] = b.dataset.dir.split(',').map(Number);
    b.onclick = () => nudge(dx * S.driftStep, dy * S.driftStep);
  }
  $('tagAdd').onclick = () => { tagDraft.push(['', '']); paintTagRows(null); };
  $('tagCancel').onclick = closeTagEditor;
  $('tagDone').onclick = commitTags;
  // Tapping the dimmed backdrop cancels, matching the settings sheet.
  $('tagSheet').onclick = (e) => { if (e.target === $('tagSheet')) closeTagEditor(); };
  $('gearBtn').onclick = openSettings;
  $('sheetClose').onclick = closeSettings;
  $('sheetSave').onclick = saveSettings;
  $('userBtn').onclick = login;
  $('uploadBtn').onclick = openQueueSheet;
  $('queueClose').onclick = closeQueueSheet;
  $('queueUpload').onclick = uploadQueue;
  $('queueSheet').onclick = (e) => { if (e.target === $('queueSheet')) closeQueueSheet(); };
  $('clearTiles').onclick = async () => {
    const before = await cacheStats().catch(() => ({ tiles: 0, ctx: 0 }));
    await dbClear('tiles');
    await dbClear('ctx');
    ctxCells.clear();
    // Rebuilding the layer is what makes the purge visible. Emptying the store on
    // its own changes nothing on screen until something happens to re-request a
    // tile, which made the button look like it had done nothing — and this button
    // exists precisely for when what is on screen is wrong.
    makeImagery();
    paintSettings();
    if (cur()) { drawContext(); paintChrome(); }
    toast('Cleared ' + before.tiles + ' tiles and ' + before.ctx +
      ' context sets, and refetching what is on screen');
  };
  $('clearDecisions').onclick = async () => {
    if (!confirm('Forget every accept/reject/later decision?')) return;
    await dbClear('decisions'); toast('Decision history cleared');
  };

  const NUDGE = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  addEventListener('keydown', (e) => {
    if ($('sheet').classList.contains('open')) return;
    if ($('tagSheet').classList.contains('open')) {
      if (e.key === 'Escape') closeTagEditor();
      return;
    }
    // TEXTAREA was missing, so typing in the paste box fired verdicts and
    // nudged the outline — an 'a' in pasted text would accept the candidate.
    const tn = e.target.tagName;
    if (tn === 'INPUT' || tn === 'SELECT' || tn === 'TEXTAREA' || e.target.isContentEditable) return;
    const k = e.key;
    if (NUDGE[k]) {
      e.preventDefault();
      const [dx, dy] = NUDGE[k];
      nudge(dx * S.driftStep, dy * S.driftStep);
      return;
    }
    const low = k.toLowerCase();
    if (low === 'a' || k === 'Enter') verdict('accept');
    else if (low === 'r' || k === 'Backspace') verdict('reject');
    else if (low === 'l' || k === ' ') { e.preventDefault(); verdict('later'); }
    else if (low === 'z') undo();
    else if (low === 'g') autoAlign();
    else if (low === 'v') $('vertexToggle').click();
    else if (low === 'e') openInId();
    else if (low === 'm') openInGoogleMaps();
  });

  let sx = 0;
  const bar = $('bar');
  bar.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; }, { passive: true });
  bar.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - sx;
    if (Math.abs(dx) > 70) verdict(dx > 0 ? 'accept' : 'reject');
  });
}

(async function main() {
  db = await idb();
  const saved = await dbGet('kv', 'settings');
  if (saved) S = Object.assign({}, DEF, saved);

  // Saved settings win over DEF, so correcting the default was not enough:
  // anyone who had ever tapped Save stayed pinned to orto-proxy, which cannot
  // return a pixel-readable tile at all. Move them across once.
  let migrated = false;
  if (S.imagery === 'orto-proxy' && !S.offProxy) {
    S.imagery = DEF.imagery;
    S.offProxy = true;
    await dbPut('kv', 'settings', S).catch(() => {});
    migrated = true;
  }

  // Earlier builds cached whatever the fetch returned without checking that it
  // was a whole image, and the source truncates about one body in seven. Those
  // entries render their missing rows white and would be served from the cache
  // for the rest of the TTL, so the arriving build cannot vouch for any of them.
  // imageBlobOk now rejects them on read as well, but that leaves the first view
  // of each one white; purging once is a few seconds of refetching instead.
  if (!S.tilesChecked) {
    await dbClear('tiles').catch(() => {});
    S.tilesChecked = true;
    await dbPut('kv', 'settings', S).catch(() => {});
  }

  await initWasm();
  initMap();
  bindUI();
  await finishLogin();
  await paintUser();
  await refreshQueueBadge();
  const n = await evictExpired();
  if (n) console.log('evicted', n, 'stale cache entries');
  setControls(false);
  if (migrated) {
    toast('Imagery moved off the budynki proxy — its CORS headers block pixel reads', 'warn');
  }
  const env = envReport();
  if (env.framed) {
    $('start').classList.add('sandboxed');
    $('emptyMsg').innerHTML = 'Preview sandbox (origin <b>null</b>) — the network is blocked here. ' +
      'Upload this file to your own https origin and open it there.';
    $('loadAreaBtn').disabled = true;
    $('randomBtn').disabled = true;
  }
  const v = await dbGet('kv', 'view');
  if (v) map.setView([v.lat, v.lon], v.z, { animate: false });
  else if (!env.framed) await loadRandom(true).catch(() => {});
  map.on('moveend', () => {
    const c = map.getCenter();
    dbPut('kv', 'view', { lat: c.lat, lon: c.lng, z: map.getZoom() });
  });
  // Only when there is nothing to review. This used to run unconditionally, so
  // a successful boot auto-load left the start panel on screen beside a live
  // candidate — contradicting ingest, which had just hidden it — and cost the map
  // a hundred pixels that Leaflet never learned about.
  if (!cur()) $('start').style.display = 'flex';
})();
