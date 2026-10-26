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

