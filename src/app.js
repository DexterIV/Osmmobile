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
  hashtags: '#orto-review',
  importTag: false,
  clientId: '',
  maxShift: 8,
  driftStep: 0.5,
  clearRadius: 50,
  dropKeys: [],
  // Set once the one-time move off orto-proxy has happened, so choosing it
  // again by hand is respected rather than silently undone on every launch.
  offProxy: false,
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
let pixelMode = 'unknown';
// Number of times a cors fetch failed on a tile that a plain <img> then
// loaded. That pairing, and only that pairing, means "no CORS headers".
let corsSignals = 0;

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

async function evictExpired() {
  const now = Date.now();
  const tileMax = S.tileTTLdays * 86400e3;
  const ctxMax = S.ctxTTLhours * 3600e3;
  let n = 0;
  for (const e of await dbAll('tiles')) {
    if (now - e.val.t > tileMax) { await dbDel('tiles', e.key); n++; }
  }
  for (const e of await dbAll('ctx')) {
    if (now - e.val.t > ctxMax) { await dbDel('ctx', e.key); n++; }
  }
  return n;
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

  for (let i = 0; i < wc; i++) {
    const n = wN[i];
    if (n < 4) continue;
    const ring = [];
    for (let k = 0; k < n; k++) {
      const idx = byId.get(refs[wA[i] + k]);
      if (idx === undefined) { ring.length = 0; break; }
      usedInWay.add(refs[wA[i] + k]);
      ring.push([nlat[idx], nlon[idx]]);
    }
    if (ring.length < 4) continue;
    const a = ring[0], z = ring[ring.length - 1];
    if (a[0] === z[0] && a[1] === z[1]) ring.pop();
    if (ring.length < 3) continue;
    out.push({ kind: 'building', ring, tags: tagsIn(wtA[i], wtB[i]) });
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
        if (onAttempt) onAttempt(i, last.msg);
        continue;
      }
      r.attempts = i;
      return r;
    } catch (err) {
      last = timedOut
        ? { msg: 'timeout after ' + timeout + 'ms', kind: 'timeout' }
        : { msg: classify(err), kind: 'network' };
      if (onAttempt) onAttempt(i, last.msg);
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
  corsSignals = 0;
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
    const u = src.url + (src.url.includes('?') ? '&' : '?') +
      'SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&CRS=EPSG:3857&FORMAT=image/jpeg&STYLES=&LAYERS=' +
      encodeURIComponent(src.layers) + '&WIDTH=32&HEIGHT=32&BBOX=2337000,6842000,2337100,6842100';
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
    const imgOk = await new Promise((res) => {
      const t = new Image();
      const timer = setTimeout(() => { t.src = ''; res(false); }, 25000);
      t.onload = () => { clearTimeout(timer); res(true); };
      t.onerror = () => { clearTimeout(timer); res(false); };
      t.src = u;
    });
    line('imagery<img> '.padEnd(12) + (imgOk
      ? 'ok — tiles will draw (if the fetch above failed, headers are missing)'
      : 'FAIL — the imagery endpoint itself is unreachable'));
  }

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

function orderCandidates() {
  for (const c of candidates) {
    c.dist = ctxIndexReady ? wasm.nearestMeters(c.centroid[0], c.centroid[1], 400) : 1e9;
    c.tier = c.dist > S.clearRadius ? 0 : c.dist > 8 ? 1 : 2;
  }
  candidates.sort((a, b) => (a.tier - b.tier) || (a.centroid[0] - b.centroid[0]) || (a.centroid[1] - b.centroid[1]));
}

let map, imgLayer, ctxLayer, shape, vertexGroup, undoStack = [];

function imagerySource() {
  if (S.imagery === 'custom') return { url: S.customUrl, layers: S.customLayers, attr: 'custom' };
  return PRESETS[S.imagery];
}

function makeImagery() {
  const src = imagerySource();
  if (imgLayer) map.removeLayer(imgLayer);
  resetPixelMode();
  // tileerror now only fires once a tile has exhausted every retry, so a
  // handful of them is a real problem rather than transient noise.
  let fails = 0;
  const onErr = () => {
    if (++fails === 4) {
      toast('Imagery still failing after ' + TILE_TRIES + ' retries per tile. Open settings and pick another source.', 'warn');
    }
  };
  if (src.xyz) {
    imgLayer = cachedTileLayer(src.xyz, { maxZoom: 21, attribution: src.attr });
  } else {
    imgLayer = cachedWmsLayer(src.url, {
      layers: src.layers, format: 'image/jpeg', transparent: false,
      version: '1.3.0', maxZoom: 21, attribution: src.attr,
    });
  }
  imgLayer.on('tileerror', onErr);
  imgLayer.addTo(map);
  imgLayer.bringToBack();
}

// Attempts on the <img> path, which is what actually paints the map. Four, not
// three, because a source can transiently 404 around half its requests, and
// three would still leave better than one tile in ten blank on a screenful.
const TILE_TRIES = 4;
// Attempts on the cors fetch, which only exists to populate the tile cache and
// keep pixels readable. Display does not depend on it, so it gets fewer tries:
// against a source with duplicated CORS headers it can never succeed at all,
// and spending four requests per tile to discover that is wasteful on mobile.
const TILE_FETCH_TRIES = 2;

function tileCacheMixin(Base) {
  return Base.extend({
    createTile(coords, done) {
      const img = document.createElement('img');
      img.setAttribute('role', 'presentation');
      img.alt = '';
      const url = this.getTileUrl(coords);

      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        img.onload = img.onerror = null;
        done(err || null, img);
      };
      // Leaflet may abort this tile while we are between retries.
      const gone = () => {
        if (!img._cancelled) return false;
        revokeTile(img);
        return true;
      };
      const paint = (src) => new Promise((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error('decode failed'));
        img.src = src;
      });
      const useBlob = (b) => {
        revokeTile(img);
        img._blob = URL.createObjectURL(b);
        return paint(img._blob);
      };

      (async () => {
        // 1. Cache. A read or a corrupt entry must never be fatal — it is
        //    only an optimisation, and letting it reject used to poison the
        //    CORS diagnosis below.
        if (S.tileTTLdays > 0) {
          const hit = await dbGet('tiles', url).catch(() => null);
          if (gone()) return;
          if (hit && hit.blob && Date.now() - hit.t < S.tileTTLdays * 86400e3) {
            try { await useBlob(hit.blob); return finish(); } catch (_) {
              if (gone()) return;
              dbDel('tiles', url);
            }
          }
        }
        if (gone()) return;

        // 2. CORS fetch, so the bytes are cacheable and stay pixel-readable.
        let corsShaped = false;
        if (pixelMode !== 'blocked' && corsSignals < 2) {
          try {
            const r = await fetchOk(url, {
              mode: 'cors', tries: TILE_FETCH_TRIES, timeout: 12000, retryOn: transientImagery,
            });
            const b = await r.blob();
            if (gone()) return;
            if (S.tileTTLdays > 0) dbPut('tiles', url, { blob: b, t: Date.now() }).catch(() => {});
            await useBlob(b);
            return finish();
          } catch (err) {
            if (gone()) return;
            // Only a hard network rejection can mean "no CORS header".
            // A timeout or a 5xx is the server being slow or unwell.
            corsShaped = err.kind === 'network';
          }
        }

        // 3. Plain <img>, which loads regardless of CORS but yields tiles
        //    that cannot be cached or read back as pixels.
        let last = null;
        for (let i = 1; i <= TILE_TRIES; i++) {
          if (i > 1) await sleep(backoff(i - 1, 500));
          if (gone()) return;
          try {
            await paint(url);
            if (corsShaped && pixelMode === 'unknown' && ++corsSignals >= 2) {
              markPixelsBlocked('imagery server sends no CORS headers');
            }
            return finish();
          } catch (err) { last = err; }
        }
        finish(last || new Error('tile failed after ' + TILE_TRIES + ' tries'));
      })();

      return img;
    },
    _abortLoading() {
      for (const k in this._tiles) {
        const t = this._tiles[k];
        if (t.coords.z !== this._tileZoom && t.el && !t.el.complete) t.el._cancelled = true;
      }
      Base.prototype._abortLoading.call(this);
    },
  });
}

function revokeTile(el) {
  if (el && el._blob) { URL.revokeObjectURL(el._blob); el._blob = null; }
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
  ctxLayer = L.layerGroup().addTo(map);
  vertexGroup = L.layerGroup().addTo(map);
  // Marking the element cancelled stops any retry chain still in flight for
  // a tile that has been panned off screen, which on a phone is most of them.
  map.on('tileunload', (e) => {
    if (e.tile) e.tile._cancelled = true;
    revokeTile(e.tile);
  });
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
  drawShape();
  drawContext();
  fitShape();
  paintChrome();
  paintTags();
}

function drawShape() {
  const c = cur();
  if (shape) { map.removeLayer(shape); shape = null; }
  vertexGroup.clearLayers();
  if (!c) return;
  if (c.kind === 'building') {
    shape = L.polygon(c.ring, {
      color: '#ff2d95', weight: 2.5, fillColor: '#ff2d95', fillOpacity: 0.12,
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

function drawVertices() {
  const c = cur();
  vertexGroup.clearLayers();
  if (!c || c.kind !== 'building') return;
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
function overlapVerdict(c, cell) {
  if (!cell || !cell.ways.length) return null;
  for (const w of cell.ways) {
    if (c.kind === 'address') {
      if (pointInRing(c.ring[0], w.ring)) {
        return { tier: 2, why: w.hn ? 'inside OSM building ' + w.hn : 'inside an OSM building' };
      }
      continue;
    }
    if (pointInRing(ringCentroidSimple(c.ring), w.ring)) return { tier: 2, why: 'covered by an OSM building' };
    if (pointInRing(ringCentroidSimple(w.ring), c.ring)) return { tier: 2, why: 'contains an OSM building' };
    for (const v of c.ring) if (pointInRing(v, w.ring)) return { tier: 2, why: 'overlaps an OSM building' };
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
  }
  $('tier').textContent = ['clear', 'near', 'overlap'][tier];
  $('tier').className = 'tier t' + tier;
  $('dist').textContent = note ? note
    : c && c.dist < 1e8 ? fmt(c.dist, 0) + ' m' : 'no OSM near';
  const d = c ? driftMeters() : 0;
  $('drift').textContent = d > 0.05 ? '+' + fmt(d, 1) + ' m moved' : '';
  $('stepLbl').textContent = fmt(S.driftStep, 2).replace(/0$/, '') + ' m';
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

async function refreshQueueBadge() {
  const q = await dbAll('queue');
  $('upCount').textContent = q.length;
  $('uploadBtn').disabled = !q.length;
}

function osmChange(items, changesetId) {
  let id = -1;
  const create = [];
  for (const it of items) {
    const tags = Object.entries(it.tags).filter(([k]) => !S.dropKeys.includes(k))
      .map(([k, v]) => `<tag k="${esc(k)}" v="${esc(v)}"/>`).join('');
    if (it.kind === 'address') {
      const [la, lo] = it.ring[0];
      create.push(`<node id="${id--}" lat="${la.toFixed(7)}" lon="${lo.toFixed(7)}" changeset="${changesetId}" version="0">${tags}</node>`);
    } else {
      const ids = [];
      for (const [la, lo] of it.ring) {
        const nid = id--;
        ids.push(nid);
        create.push(`<node id="${nid}" lat="${la.toFixed(7)}" lon="${lo.toFixed(7)}" changeset="${changesetId}" version="0"/>`);
      }
      const nds = ids.concat([ids[0]]).map((r) => `<nd ref="${r}"/>`).join('');
      create.push(`<way id="${id--}" changeset="${changesetId}" version="0">${nds}${tags}</way>`);
    }
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

async function uploadQueue() {
  const t = await token();
  if (!t) { toast('Sign in first', 'warn'); return; }
  const all = (await dbAll('queue')).map((e) => Object.assign({ key: e.key }, e.val));
  if (!all.length) return;
  all.sort((a, b) => (a.city || '').localeCompare(b.city || '') || a.ring[0][0] - b.ring[0][0]);
  const H = { Authorization: 'Bearer ' + t, 'Content-Type': 'text/xml' };
  let done = 0;
  setStage('Uploading 0 / ' + all.length);
  for (let i = 0; i < all.length; i += S.batchSize) {
    const batch = all.slice(i, i + S.batchSize);
    const city = batch[0].city || 'Poland';
    const extra = (S.hashtags ? `<tag k="hashtags" v="${esc(S.hashtags)}"/>` : '') +
      (S.importTag ? '<tag k="import" v="yes"/>' : '') +
      `<tag k="review_count" v="${batch.length}"/>`;
    const cs = `<osm><changeset>
      <tag k="created_by" v="orto-review"/>
      <tag k="comment" v="${esc(S.comment + ' — ' + city)}"/>
      <tag k="source" v="${esc(S.source)}"/>
      ${extra}
    </changeset></osm>`;
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
  $('sHashtags').value = S.hashtags;
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
  S.hashtags = $('sHashtags').value.trim();
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
  $('uploadBtn').onclick = uploadQueue;
  $('clearTiles').onclick = async () => {
    await dbClear('tiles'); await dbClear('ctx'); paintSettings(); toast('Cache cleared');
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
  $('start').style.display = 'flex';
})();
