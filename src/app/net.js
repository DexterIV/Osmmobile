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
  if (apiBase() === DEF.apiBase) {
    out.push('api base    default (budynki.openstreetmap.org.pl — upstream v2)');
    out.push('');
    out.push('!! Upstream v2 (2026-10 rework) sends no Access-Control-Allow-Origin');
    out.push('   on ANY endpoint, so from this origin every cross-origin fetch is');
    out.push('   refused before the body is ever seen. Data loads either through');
    out.push('   Settings → API base pointed at a mirror that adds the header, or');
    out.push('   once upstream sends it again (it did, on v1). The /package');
    out.push('   download route and the imagery tiles are the two things that');
    out.push('   work without a mirror.');
  } else {
    out.push('api base    mirror: ' + apiBase());
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
      // A probe reads the way fetches do, but not every feature does; where a
      // failure here does not mean the feature is dead, say so.
      if (o.failNote) line('            → ' + o.failNote);
    }
    for (const n of notes) line('            · ' + n);
  };

  // v2 dropped /random/, /layers/, /sc/* and /josm_data outright (404), so the
  // probes are the endpoints a built fetch actually uses: the tiles (there an
  // empty 404 means "no bin here", which a hit-free carry would never see),
  // liveness (/status), and the very thing the paste route ingests.
  await probe('tiles', base + '/tiles/6/34/20', async (r) => {
    const b = await r.blob();
    return 'ok  ' + (b.size / 1024).toFixed(0) + ' KB mvt';
  }, { tries: 2, timeout: 20000 });
  await probe('status', base + '/status', async (r) => {
    const j = await r.json();
    const osm = (j.jobs || []).find((x) => x.name === 'osm_update') || {};
    return 'ok  v' + (j.version || '?') + ', osm_update last ' +
      ((osm.last_outcome && osm.last_outcome.kind) || '?');
  });
  await probe('package', base + '/package?bbox=21.0,52.2,21.02,52.22&datasets=bdot10k,egib,prg',
    async (r) => {
      const j = await r.json();
      return 'ok  ' + ((j.features || []).length) + ' features geojson';
    }, { tries: 2, timeout: 30000,
      // GET /package fails this probe with the others under v2's CORS-less
      // headers, but the app never fetches it: the button is a navigation,
      // which no CORS policy restricts. The data route works; only the probe's
      // own read does not.
      failNote: 'the "Get this area\'s data" button navigates instead of ' +
        'fetching, so it downloads the file even when this probe fails' });
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
// /josm_data fallback, was deleted twice over: those endpoints failed CORS
// outright in v1, and the 2026-10 v2 rewrite (Rust "osmpbudynkiv2") dropped them
// entirely. Replaced by vector tiles for in-app loading and /package for the
// exact-geometry download route.

