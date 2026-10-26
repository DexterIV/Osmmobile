async function ingest(list, label) {
  const dec = new Map();
  for (const e of await dbAll('decisions')) dec.set(e.key, e.val.verdict);

  for (const c of list) {
    c.centroid = centroid(c.ring);
    // The registry prefix separates the id spaces: bdot10k ids are uuids and
    // egib ids are TERYT file references, so a collision is conceivable.
    // `bdot` (one token, not `bdot10k`) keeps decisions made against v1's
    // lokalnyid uuids valid, because those are the same id space.
    c.key = c.srcId
      ? (c.kind === 'building' ? (c.reg || 'bdot') : 'prg') + ':' + c.srcId
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
  if (!S.reportRejects || !c.report) return;
  try {
    // Deliberately tries: 1. This vetoes the object for every other mapper, so
    // a bounded timeout is welcome but re-sending on a doubtful failure is
    // not — a silent no-op is the safer outcome of the two.
    await fetchRetry(apiBase() + '/report', {
      tries: 1, timeout: 15000,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ objects: [c.report] }),
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

