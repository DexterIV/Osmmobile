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
//     concurrency 6. A 6 s fetch timeout cut off legitimate slow responses,
//     so the fetch timeout is raised to 10 s and the  timeout to 12 s.
//     The retry/heal mechanism is the real safety net for flaky connections.
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
const TILE_FETCH_TIMEOUT = 10000;
const TILE_IMG_TIMEOUT = 12000;
const TILE_IMG_TRIES = 3;
const TILE_IMG_BACKOFF = 300;
const TILE_IMG_BACKOFF_CAP = 1500;
// Whatever the source, stop retrying a tile past this. A blank tile now beats a
// connection still tied up when the next screenful arrives.
const TILE_DEADLINE = 20000;
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

// Background prefetch of the next candidate's screenful. The chain already
// keeps steps short, so most of that screenful is in the cache or still in
// Leaflet's tile grid; these maps only carry the genuinely new edge. A promise
// is kept while the bytes are in flight so a verdict that lands mid-prefetch
// reuses them instead of asking for the same URL twice; the brief in-memory
// cache covers the microsecond race between the promise settling and the tile
// layer's earlier IndexedDB read.
const prefetches = new Map();
const prefetched = new Map();
let prefetchTimer = 0;
let prefetchAgain = false;
let prefetchBusy = false;
let prefetchEpoch = 0;

// What a screenful actually cost. This is the per-tile attempt count the notes
// asked for, and Run diagnostics prints it rather than needing new markup.
// heal/healed are counted apart from net/tiles on purpose: folding a repair
// into either would make 'requests per tile' read healthy exactly when a
// screenful is costing double, and that ratio is how this branch is judged.
// prefetch is likewise separate: those requests are background work for the
// next candidate, not part of the current screenful's cost.
const tileStats = { tiles: 0, cache: 0, fetch: 0, img: 0, blank: 0, cancel: 0, net: 0, ms: 0, n: 0, heal: 0, healed: 0, truncated: 0, prefetch: 0 };
function tileStatsLine() {
  const s = tileStats;
  const per = s.tiles ? (s.net / s.tiles).toFixed(2) : '0';
  const avg = s.n ? Math.round(s.ms / s.n) : 0;
  return s.tiles + ' tiles, ' + s.net + ' requests' +
    (s.prefetch ? ' + ' + s.prefetch + ' prefetched' : '') +
    ' (' + per + '/tile), ' +
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

// Why a tile ended up blank, in words short enough to draw on it. The transport
// errors already carry .kind; the rest is the small set of messages this file
// produces. "network error" vs "offline" matters because the remedy differs:
// wait for signal, or try another source.
function tileWhy(err, online) {
  if (online === undefined) online = typeof navigator === 'undefined' || navigator.onLine !== false;
  if (!err) return 'imagery failed';
  // The <img> fallback only ever says "image failed", but if the browser knows
  // it is offline, the reason is not a mystery. An HTTP answer proves the link
  // is up even when navigator.onLine disagrees, so do not hide the status.
  if (online === false && err.kind !== 'http') return 'offline';
  if (err.kind === 'timeout') return 'timed out';
  if (err.kind === 'http') return /^HTTP \d+/.test(err.message || '') ? err.message : 'server error';
  if (err.kind === 'network') return online ? 'network error' : 'offline';
  const msg = err.message || '';
  if (msg === 'incomplete image body') return 'incomplete image';
  if (msg === 'tile failed' || msg === 'image failed') return 'image failed';
  return msg || 'imagery failed';
}

// The fetch error is usually the only one that knows the HTTP status; the <img>
// attempts that follow it fail with a bare "image failed". Keep the more
// specific reason instead of letting the last, least informative error win.
function preferErr(a, b) {
  const score = (e) => {
    if (!e) return 0;
    if (e.kind === 'http' || (e.message || '') === 'incomplete image body') return 4;
    if (e.kind === 'timeout') return 3;
    if (e.kind === 'network') return 2;
    return 1;
  };
  return score(b) >= score(a) ? b : a;
}

function xmlEsc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[c]));
}

// A tile is an <img>, so the reason and the retry affordance have to be pixels.
// An SVG data URI keeps it crisp at any DPR and rides the tile's own transform
// through pans and zooms without a second overlay layer to keep in sync.
function blankTileImage(reason, hint, retry) {
  let why = String(reason || 'imagery failed');
  if (why.length > 24) why = why.slice(0, 21) + '...';
  const button = retry
    ? '<rect x="80" y="150" width="96" height="34" rx="7" fill="#18222c" stroke="#2a3542"/>' +
      '<text x="128" y="172" fill="#e6edf3" font-family="monospace" font-size="11" ' +
      'font-weight="600" letter-spacing="1" text-anchor="middle">RETRY</text>'
    : '';
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">' +
    '<rect width="256" height="256" fill="#0e141a"/>' +
    '<rect x="8.5" y="8.5" width="239" height="239" fill="none" stroke="#22303c" ' +
    'stroke-dasharray="7 6"/>' +
    '<text x="128" y="112" fill="#e6edf3" font-family="sans-serif" font-size="18" ' +
    'font-weight="600" text-anchor="middle">' + xmlEsc(why) + '</text>' +
    '<text x="128" y="136" fill="#7d8fa0" font-family="monospace" font-size="11" ' +
    'text-anchor="middle">' + xmlEsc(hint || '') + '</text>' +
    button + '</svg>';
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

// done(err) leaves the tile hidden: Leaflet adds leaflet-tile-loaded only on
// success, and reveal it has to be done here or the placeholder is invisible.
function showBlankTile(img, err, hint, retry) {
  if (!img || img._cancelled) return;
  revokeTile(img);
  img._blank = true;
  img._retryReady = !!retry;
  img._why = tileWhy(err);
  img.src = blankTileImage(img._why, hint, retry);
  img.title = 'Imagery failed: ' + img._why + (retry ? ' - click to retry' : '');
  img.classList.add('tile-blank');
  if (retry) img.classList.add('tile-retry');
  else img.classList.remove('tile-retry');
  if (retry) {
    img.setAttribute('role', 'button');
    img.setAttribute('aria-label', 'Imagery failed: ' + img._why + '. Retry this tile.');
    img.tabIndex = 0;
  } else {
    img.setAttribute('role', 'presentation');
    img.removeAttribute('aria-label');
    img.removeAttribute('tabindex');
  }
  // _tileReady already started its fade at opacity 0 for the failed tile. In a
  // visible tab the fade reaches 1 a frame later, but a backgrounded tab can
  // leave it at 0 indefinitely; the reason must not depend on that animation.
  L.DomUtil.setOpacity(img, 1);
  L.DomUtil.addClass(img, 'leaflet-tile-loaded');
}

// The placeholder draws a 96x34 button at (80,150) in the 256px tile. Only that
// rectangle (plus a small touch margin) is a retry target; the rest of the tile
// must keep dragging the map, or a screenful of blanks would make the map
// unpannable once they all reached the final state.
function retryHit(img, x, y) {
  if (!img || !img._retryReady || typeof x !== 'number' || typeof y !== 'number') return false;
  const r = img.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const sx = r.width / 256, sy = r.height / 256, pad = 6;
  const left = r.left + 80 * sx - pad, top = r.top + 150 * sy - pad;
  return x >= left && x <= left + 96 * sx + pad * 2 &&
    y >= top && y <= top + 34 * sy + pad * 2;
}

function clearBlankTile(img) {
  img._blank = false;
  img._retryReady = false;
  img._why = '';
  img.classList.remove('tile-blank', 'tile-retry');
  img.setAttribute('role', 'presentation');
  img.removeAttribute('aria-label');
  img.removeAttribute('title');
  img.removeAttribute('tabindex');
}

// Recreate the tile through Leaflet rather than keeping a second loader beside
// the pipeline: the new element gets the cache read, the promoted fetch, the
// body check, the fast <img> attempts and a fresh heal window for free.
function retryBlankTile(img) {
  if (!img || !img._retryReady || !imgLayer) return;
  let key = null;
  for (const k in imgLayer._tiles) {
    const t = imgLayer._tiles[k];
    if (t && t.el === img) { key = k; break; }
  }
  if (!key) return;
  img._retryReady = false;
  img.classList.remove('tile-retry');
  imgLayer._removeTile(key);
  imgLayer._forceVisible = imgLayer._forceVisible || new Set();
  imgLayer._forceVisible.add(key);
  imgLayer._update(map.getCenter());
  if (!imgLayer._tiles[key]) imgLayer._forceVisible.delete(key);
}

// The tile range a view covers, with Leaflet's own edge rule: floor the
// north-west pixel and ceil the south-east one minus one. Getting this wrong by
// a column would prefetch a tile the layer never asks for and miss one it does,
// which is worse than not prefetching at all.
function tileRangeAt(cx, cy, w, h, tw, th) {
  return {
    x0: Math.floor((cx - w / 2) / tw),
    x1: Math.ceil((cx + w / 2) / tw) - 1,
    y0: Math.floor((cy - h / 2) / th),
    y1: Math.ceil((cy + h / 2) / th) - 1,
  };
}

// Prefetch is a convenience, not part of the review path: it must never run
// when the browser says the user is saving data, while the tab is hidden, until
// a cors fetch has been proven to work (the <img> fallback cannot be cached), or
// with the cache switched off.
function prefetchAllowed() {
  return S.tileTTLdays > 0 && !!map && !!imgLayer && tilePath === 'fetch' &&
    candidates.length > cursor + 1 && !document.hidden &&
    !(navigator.connection && navigator.connection.saveData);
}

// The prefetch has to produce exactly the URL the tile layer will request, so
// derive it with getTileUrl rather than rebuilding the XYZ/WMS template here.
// Leaflet's getTileUrl reads _tileZoom for {z}, and the next view can be a zoom
// level away from the current one, so point it at the target zoom for the
// duration of the call and put it back afterwards.
function prefetchView(c) {
  let bounds, zoom;
  if (c.kind === 'building') {
    bounds = L.latLngBounds(c.ring).pad(1.4);
    zoom = Math.min(20, Math.round(map.getBoundsZoom(bounds)));
  } else {
    bounds = L.latLngBounds([c.ring[0]]);
    zoom = 19;
  }
  const z = imgLayer._clampZoom(zoom);
  // fitBounds centres on the midpoint of the projected corners, not on the
  // average latitude, so reproduce that here.
  const center = map.unproject(
    map.project(bounds.getSouthWest(), z)
      .add(map.project(bounds.getNorthEast(), z)).divideBy(2), z);
  const px = map.project(center, z).floor();
  const size = map.getSize();
  const ts = imgLayer.getTileSize();
  const r = tileRangeAt(px.x, px.y, size.x, size.y, ts.x, ts.y);

  const live = imgLayer._tileZoom === z ? imgLayer._tiles : null;
  const urls = [];
  const prevZoom = imgLayer._tileZoom;
  imgLayer._tileZoom = z;
  try {
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) {
        // Already on screen, loaded or still loading. Asking for it again would
        // be the duplicate this whole path exists to avoid.
        if (live && live[x + ':' + y + ':' + z]) continue;
        // WMS's getTileUrl calls coords.scaleBy, so this must be a real Point
        // with a z, not a plain object.
        const coords = L.point(x, y);
        coords.z = z;
        urls.push(imgLayer.getTileUrl(coords));
      }
    }
  } finally {
    imgLayer._tileZoom = prevZoom;
  }
  return urls;
}

// Kept until the tile layer consumes it, so a show() that races the prefetch's
// cache write still finds the bytes. Bounded: an unused screenful is a few MB,
// not a session-long leak.
function rememberPrefetch(url, blob) {
  if (prefetched.size >= 24) prefetched.delete(prefetched.keys().next().value);
  prefetched.set(url, blob);
}

// One request, never a retry chain: a background miss costs nothing because the
// visible tile will ask again through its own path, with retries and <img>
// fallback. That is also why this never votes on tilePath or tileFetchMisses —
// it is speculative work, not evidence that the source is failing.
async function prefetchTile(url, epoch) {
  try {
    const r = await fetchOk(url, {
      mode: 'cors', tries: 1, timeout: TILE_FETCH_TIMEOUT, retryOn: transientImagery,
      // Respects the queue for the imagery the reviewer is actually looking at.
      // Chromium understands the hint; browsers that do not simply ignore it.
      priority: 'low',
    });
    const b = await r.blob();
    if (!await imageBlobOk(b)) return null;
    if (epoch === prefetchEpoch) {
      if (S.tileTTLdays > 0) {
        await dbPut('tiles', url, { blob: b, t: Date.now() }).catch(() => {});
      }
      rememberPrefetch(url, b);
      tileStats.prefetch++;
    }
    return b;
  } catch (_) {
    return null;
  } finally {
    prefetches.delete(url);
  }
}

async function prefetchNext() {
  if (!prefetchAllowed()) return;
  const c = candidates[cursor + 1];
  if (!c) return;
  const urls = prefetchView(c);
  const epoch = prefetchEpoch;
  const jobs = [];
  for (const url of urls) {
    // A verdict moves the target. Finish what is in flight, but do not keep
    // loading the screenful of a candidate the reviewer has already left.
    if (epoch !== prefetchEpoch || candidates[cursor + 1] !== c || !prefetchAllowed()) break;
    if (prefetches.has(url) || prefetched.has(url)) continue;
    const hit = await dbGet('tiles', url).catch(() => null);
    if (hit && hit.blob && Date.now() - hit.t < S.tileTTLdays * 86400e3) continue;
    const p = prefetchTile(url, epoch);
    prefetches.set(url, p);
    jobs.push(p);
  }
  await Promise.all(jobs);
}

// Debounced so the current screenful gets the connections first, and reset on
// every verdict: a fast reviewer should not stack one prefetch on another.
function schedulePrefetch() {
  prefetchAgain = true;
  if (prefetchBusy) return;
  clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => {
    prefetchTimer = 0;
    runPrefetch().catch(() => {});
  }, 1000);
}

async function runPrefetch() {
  if (!prefetchAgain) return;
  prefetchAgain = false;
  if (prefetchBusy || !prefetchAllowed()) return;
  prefetchBusy = true;
  try {
    await prefetchNext();
  } finally {
    prefetchBusy = false;
    if (prefetchAgain) schedulePrefetch();
  }
}

// A new source or a new area invalidates both the URLs and any pending screenful.
function cancelPrefetch() {
  prefetchEpoch++;
  prefetchAgain = false;
  clearTimeout(prefetchTimer);
  prefetchTimer = 0;
  prefetched.clear();
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
  cancelPrefetch();
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
  schedulePrefetch();
}

function tileCacheMixin(Base) {
  return Base.extend({
    createTile(coords, done) {
      const img = document.createElement('img');
      img.setAttribute('role', 'presentation');
      img.alt = '';
      const key = this._tileCoordsToKey(coords);
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
        const forced = this._forceVisible && this._forceVisible.delete(key);
        done(err || null, img);
        if (err) {
          tileStats.blank++;
          showBlankTile(img, err, 'auto-retrying', false);
        } else {
          tileStats.ms += performance.now() - t0;
          tileStats.n++;
          // A tile recreated from the retry button gets the same fade as any
          // other, but a backgrounded tab can leave that fade parked at opacity
          // 0. The user explicitly asked for this one, so show it now.
          if (forced) L.DomUtil.setOpacity(img, 1);
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

      // An <img> cannot contain a button, so the placeholder draws one and the
      // image checks that small rectangle. Only the final state takes pointer
      // events; while it is auto-retrying, a drag that starts on it still pans
      // the map, and even in the final state only the button area does not.
      img.addEventListener('click', (e) => {
        if (!img._retryReady) return;
        // browser automation and .click() have no coordinates; a real pointer
        // must land on the drawn button, not just anywhere on the tile.
        if ((e.clientX || e.clientY) && !retryHit(img, e.clientX, e.clientY)) return;
        L.DomEvent.stop(e);
        retryBlankTile(img);
      });
      img.addEventListener('keydown', (e) => {
        if (!img._retryReady || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        L.DomEvent.stopPropagation(e);
        retryBlankTile(img);
      });
      const hold = (e) => {
        if (!img._retryReady) return;
        const p = e.touches && e.touches[0] ? e.touches[0] : e;
        if (retryHit(img, p.clientX, p.clientY)) L.DomEvent.stopPropagation(e);
      };
      img.addEventListener('mousedown', hold);
      img.addEventListener('touchstart', hold, { passive: true });

      (async () => {
        // 0. A background prefetch for this exact URL. Reuse it instead of
        //    asking for the same bytes twice: first the in-memory result, then
        //    a fetch still in flight. The 1 s debounce normally means neither
        //    is needed by the time the candidate is shown, but a verdict can
        //    land sooner.
        const hot = prefetched.get(url);
        if (hot) {
          prefetched.delete(url);
          if (gone()) return;
          try {
            await useBlob(hot);
            tileStats.cache++;
            return finish();
          } catch (_) { /* fall through to the normal path */ }
        }
        const pending = prefetches.get(url);
        if (pending) {
          const b = await pending.catch(() => null);
          if (gone()) return;
          if (b) {
            prefetched.delete(url);
            try {
              await useBlob(b);
              tileStats.cache++;
              return finish();
            } catch (_) { /* fall through to the normal path */ }
          }
        }
        if (gone()) return;

        // 1. Cache. A read or a corrupt entry must never be fatal - it is only
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
        let fetchErr = null;
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
            fetchErr = err;
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
        // The fetch is the only attempt that can report a status; the <img>
        // retries after it fail with a bare "image failed". Keep whichever
        // reason says more, rather than letting the last one erase an HTTP 502.
        const reason = preferErr(fetchErr, last) || new Error('tile failed');
        finish(reason);

        // 4. Blank, but not necessarily unloadable. Keep the closure alive and
        //    retry slowly; see healTile.
        await healTile(img, url, gone, reason);
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

async function healTile(img, url, gone, firstErr) {
  // A cache hit whose blob then failed to decode leaves that object URL on the
  // element, and _abort only revokes it when the tile is finally pruned. Holding
  // it across the heal window is a decoded 256x256 bitmap nothing can reach.
  revokeTile(img);
  let lastErr = firstErr;
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
      if (++waits > TILE_HEAL_WAITS) break;
      continue;
    }
    i++;
    tileStats.heal++;
    try {
      await healOnce(img, url);
      if (gone()) return;
      clearBlankTile(img);
      L.DomUtil.addClass(img, 'leaflet-tile-loaded');
      tileStats.healed++;
      return;
    } catch (err) {
      if (gone()) return;
      lastErr = preferErr(lastErr, err);
      showBlankTile(img, lastErr, 'auto-retrying', false);
    }
  }
  // All automatic attempts are spent. Only now does the tile offer a manual
  // retry, so the click cannot race a heal attempt that is still in flight and
  // turn one request into two for the same bytes.
  if (gone()) return;
  showBlankTile(img, lastErr, 'tap to retry', true);
}

const CachedTile = tileCacheMixin(L.TileLayer);
const CachedWms = tileCacheMixin(L.TileLayer.WMS);
const cachedTileLayer = (u, o) => new CachedTile(u, o);
const cachedWmsLayer = (u, o) => new CachedWms(u, o);

