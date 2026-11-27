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
const ctxCellTries = new Map(); // key -> failed attempts so far
const ctxWarned = new Set();   // keys whose repeated failure was already announced
const ctxLastFail = new Map(); // key -> when the last load failed; retries cool down

function ctxCellKey(lat, lon) {
  return Math.floor(lat / CTX_CELL_LAT) + '/' + Math.floor(lon / CTX_CELL_LON);
}

// drawContext draws centroid dots within 150 m of the current candidate, so the
// footprints behind those dots must load at least that far. A single cell
// cannot guarantee it: the grid can split a hair's breadth to the left of a
// candidate, putting a building 18 m away in a cell that never loads while this
// candidate is current. PRG 37A at lon 19.1749996 loads the cell ending at lon
// 19.175; the next building east lives at 19.17525, in the following cell — and
// showed as its bare Overpass-centroid dot with no outline, read as
// "a dot instead of a building".
const CTX_VIEW_M = 150;                     // same radius the dot loop filters on
const CTX_VIEW_LAT = CTX_VIEW_M / 111320;   // ~0.00135 deg
const CTX_VIEW_LON = CTX_VIEW_M / 69500;    // ~0.00216 deg at 52 N

// The cells whose intersection with that view must be loaded: the one holding
// the candidate plus every neighbour the view spills into (usually 1, at most 4).
function ctxCellsNear(lat, lon) {
  const out = [];
  const y0 = Math.floor((lat - CTX_VIEW_LAT) / CTX_CELL_LAT);
  const y1 = Math.floor((lat + CTX_VIEW_LAT) / CTX_CELL_LAT);
  const x0 = Math.floor((lon - CTX_VIEW_LON) / CTX_CELL_LON);
  const x1 = Math.floor((lon + CTX_VIEW_LON) / CTX_CELL_LON);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++)
      out.push({ key: y + '/' + x, lat: (y + 0.5) * CTX_CELL_LAT, lon: (x + 0.5) * CTX_CELL_LON });
  return out;
}

// Everything already loaded around the candidate, merged into one pseudo-cell
// so overlapVerdict, duplicateAddress, snapping and drawContext work uniformly.
// Ways/features with positive OSM ids are deduplicated so an object straddling
// a cell boundary is not drawn twice or duplicated as a snap target.
function ctxNear(lat, lon) {
  const ways = [], addrs = [], features = [];
  const seenW = new Set(), seenF = new Set();
  for (const it of ctxCellsNear(lat, lon)) {
    const cell = ctxCells.get(it.key);
    if (!cell || cell === 'loading' || cell === 'failed') continue;
    for (const w of cell.ways) {
      if (w.id > 0) { if (seenW.has(w.id)) continue; seenW.add(w.id); }
      ways.push(w);
    }
    for (const a of cell.addrs) addrs.push(a);
    if (cell.features) {
      for (const f of cell.features) {
        if (f.id > 0) { if (seenF.has(f.id)) continue; seenF.add(f.id); }
        features.push(f);
      }
    }
  }
  return { ways, addrs, features };
}

// Which cells the candidate on screen actually needs loaded: its own cell, the
// cells a 30 m duplicate-check radius bubbles into across a split, and every
// cell holding a context dot inside the 150 m view — dots mark buildings whose
// footprint the reviewer is about to need. Everything already loaded still
// counts in the verdicts; this only decides fetches. A rural candidate usually
// needs just its own cell, which is what keeps a fast walk through the queue
// from sending enough /map calls per step for the OSM API to start throttling
// (a throttled cell reads on screen as a missing outline). Without the Overpass
// dot index — it fails at boot now and then — the filter is impossible, so the
// whole envelope is needed, as before.
const CTX_DUP_M = 30;                       // duplicateAddress's search radius
const CTX_DUP_LAT = CTX_DUP_M / 111320;
const CTX_DUP_LON = CTX_DUP_M / 69500;
function ctxCellsNeeded(lat, lon, pts) {
  const envelope = ctxCellsNear(lat, lon);
  if (!pts || !pts.length) return envelope;
  const need = new Set([ctxCellKey(lat, lon)]);
  for (const ya of [Math.floor((lat - CTX_DUP_LAT) / CTX_CELL_LAT),
                    Math.floor((lat + CTX_DUP_LAT) / CTX_CELL_LAT)])
    for (const xa of [Math.floor((lon - CTX_DUP_LON) / CTX_CELL_LON),
                      Math.floor((lon + CTX_DUP_LON) / CTX_CELL_LON)])
      need.add(ya + '/' + xa);
  for (const [pla, plo] of pts) {
    if (metresBetween([lat, lon], [pla, plo]) > CTX_VIEW_M) continue;
    need.add(ctxCellKey(pla, plo));
  }
  return envelope.filter((it) => need.has(it.key));
}

async function loadCtxCell(lat, lon) {
  const key = ctxCellKey(lat, lon);
  const known = ctxCells.get(key);
  if (known) return known === 'loading' || known === 'failed' ? null : known;
  ctxCells.set(key, 'loading');

  const dbKey = 'osmctx2/' + key;
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
    // Leave it failed rather than retrying on every redraw; drawContext retries
    // after a cool-down instead, because the OSM API 503s in bursts and a
    // give-up that lasts until reload loses an outline the reviewer needs.
    ctxCells.set(key, 'failed');
    ctxLastFail.set(key, Date.now());
    const tries = (ctxCellTries.get(key) || 0) + 1;
    ctxCellTries.set(key, tries);
    // One quiet failure is a normal burst; say something only once a second
    // attempt has failed too, and only once for the session.
    if (tries >= 2 && !ctxWarned.has(key)) {
      ctxWarned.add(key);
      toast('OSM context unavailable here — existing footprints may be missing', 'warn');
    }
    return null;
  }
}

// Stitch a list of resolved member ways ({ id, ring, nodeIds, closed }) into
// closed rings. Already-closed ways pass through with their single OSM way id
// intact; open segments stitch end-to-end by matching node ids (reversing when
// needed) so multipolygon buildings split across multiple ways still draw.
function stitchMemberRings(parts) {
  const out = [];
  const open = [];
  for (const p of parts) {
    if (p.closed && p.ring.length >= 3) {
      out.push({ id: p.id, ring: p.ring, nodeIds: p.nodeIds });
    } else if (p.ring.length >= 2) {
      open.push({ ring: p.ring.slice(), nodeIds: p.nodeIds.slice() });
    }
  }
  while (open.length) {
    const cur = open.shift();
    let changed = true;
    while (changed && cur.nodeIds[0] !== cur.nodeIds[cur.nodeIds.length - 1]) {
      changed = false;
      const head = cur.nodeIds[0];
      const tail = cur.nodeIds[cur.nodeIds.length - 1];
      for (let i = 0; i < open.length; i++) {
        const seg = open[i];
        const sh = seg.nodeIds[0], st = seg.nodeIds[seg.nodeIds.length - 1];
        if (tail === sh) {
          cur.ring.push(...seg.ring.slice(1));
          cur.nodeIds.push(...seg.nodeIds.slice(1));
        } else if (tail === st) {
          cur.ring.push(...seg.ring.slice(0, -1).reverse());
          cur.nodeIds.push(...seg.nodeIds.slice(0, -1).reverse());
        } else if (head === st) {
          cur.ring.unshift(...seg.ring.slice(0, -1));
          cur.nodeIds.unshift(...seg.nodeIds.slice(0, -1));
        } else if (head === sh) {
          cur.ring.unshift(...seg.ring.slice(1).reverse());
          cur.nodeIds.unshift(...seg.nodeIds.slice(1).reverse());
        } else continue;
        open.splice(i, 1);
        changed = true;
        break;
      }
    }
    if (cur.nodeIds.length >= 4 && cur.nodeIds[0] === cur.nodeIds[cur.nodeIds.length - 1]) {
      cur.ring.pop();
      cur.nodeIds.pop();
      out.push({ id: 0, ring: cur.ring, nodeIds: cur.nodeIds });
    }
  }
  return out;
}

// An OSM API /map response to the shape drawContext, snapping and the verdicts
// want, via the same wasm scanner used for candidate files. Kept separate from
// the fetch so it can be tested against a captured response.
//
// Buildings (simple ways, multipolygon relations, and building:part) go into
// `ways` with their positive OSM way id and per-vertex node ids so snapping can
// share real OSM topology. Non-building features (highways, railways, water,
// barriers, structures and mapped areas) go into `features` so nothing mapped
// in OSM is invisible over the orthophoto.
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

  // Read OSM way ids in document order (matching parseOsmXml's verified pattern).
  const wayIds = [];
  const wayIdxById = new Map();
  let wayOrderOk = true;
  {
    let i = 0;
    for (const m of RAW.matchAll(WAY_ID_RE)) {
      const id = Number(m[1]);
      if (i < wc) { wayIds.push(id); wayIdxById.set(id, i); }
      i++;
    }
    if (i !== wc) wayOrderOk = false;
  }

  const resolveWay = (i) => {
    const n = wN[i];
    if (n < 2) return null;
    const ring = [];
    const nodeIds = [];
    for (let k = 0; k < n; k++) {
      const refId = refs[wA[i] + k];
      const idx = byId.get(refId);
      if (idx === undefined) return null;
      ring.push([nlat[idx], nlon[idx]]);
      nodeIds.push(refId);
    }
    const closed = ring.length >= 4 &&
      (nodeIds[0] === nodeIds[nodeIds.length - 1] ||
       (ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]));
    if (closed) { ring.pop(); nodeIds.pop(); }
    return { id: wayOrderOk ? wayIds[i] : 0, ring, nodeIds, closed };
  };

  const data = { ways: [], addrs: [], features: [] };
  const consumedWays = new Set();

  // Multipolygon relations (buildings with courtyards or multi-wing outlines,
  // plus mapped water/landuse/natural areas). Without this pass, any building
  // whose tags live on a multipolygon relation is completely invisible and
  // skipped by overlap and duplicate-address checks.
  for (const m of (wayOrderOk ? RAW.matchAll(REL_RE) : [])) {
    const body = m[0];
    const tags = tagsIn(m.index, m.index + body.length);
    if (tags.type !== 'multipolygon') continue;
    const isBldg = !!tags.building;
    const isWater = tags.natural === 'water';
    const isArea = !!(tags.landuse || tags.natural || tags.leisure || tags.amenity);
    if (!isBldg && !isWater && !isArea) continue;

    const outerParts = [], innerParts = [];
    for (const mm of body.matchAll(MEMBER_RE)) {
      if (mm[1] !== 'way') continue;
      const idx = wayIdxById.get(Number(mm[2]));
      if (idx === undefined) continue;
      const rw = resolveWay(idx);
      if (!rw) continue;
      (mm[3] === 'inner' ? innerParts : outerParts).push(rw);
      if (isBldg) consumedWays.add(idx);
    }
    const outers = stitchMemberRings(outerParts);
    const inners = stitchMemberRings(innerParts).map((x) => x.ring);
    if (!outers.length) continue;

    if (isBldg) {
      for (const o of outers) {
        data.ways.push({
          id: o.id,
          ring: o.ring,
          nodeIds: o.nodeIds,
          holes: inners,
          hn: tags['addr:housenumber'] || '',
          street: tags['addr:street'] || '',
          part: false,
        });
      }
    } else {
      for (const o of outers) {
        data.features.push({
          id: o.id,
          kind: isWater ? 'water' : 'area',
          ring: o.ring,
          holes: inners,
          closed: true,
        });
      }
    }
  }

  for (let i = 0; i < wc; i++) {
    const tags = tagsIn(wtA[i], wtB[i]);
    const rw = resolveWay(i);
    if (!rw) continue;

    if (tags.building) {
      if (rw.ring.length < 3) continue;
      data.ways.push({
        id: rw.id,
        ring: rw.ring,
        nodeIds: rw.nodeIds,
        holes: [],
        hn: tags['addr:housenumber'] || '',
        street: tags['addr:street'] || '',
        part: false,
      });
      continue;
    }
    if (consumedWays.has(i)) continue;

    if (tags['building:part'] && rw.closed && rw.ring.length >= 3) {
      data.ways.push({
        id: rw.id,
        ring: rw.ring,
        nodeIds: rw.nodeIds,
        holes: [],
        hn: tags['addr:housenumber'] || '',
        street: tags['addr:street'] || '',
        part: true,
      });
      continue;
    }

    if (tags.highway && tags.highway !== 'proposed') {
      const covered = !!(
        (tags.tunnel && tags.tunnel !== 'no') ||
        (tags.covered && tags.covered !== 'no') ||
        (tags.indoor && tags.indoor !== 'no') ||
        (tags.layer && Number(tags.layer) < 0)
      );
      data.features.push({
        id: rw.id,
        kind: 'highway',
        sub: tags.highway,
        ring: rw.ring,
        closed: rw.closed && tags.area === 'yes',
        covered,
      });
    } else if (tags.railway && tags.railway !== 'proposed') {
      data.features.push({ id: rw.id, kind: 'railway', ring: rw.ring, closed: false });
    } else if (tags.waterway || tags.natural === 'water') {
      data.features.push({
        id: rw.id,
        kind: 'water',
        ring: rw.ring,
        closed: rw.closed && tags.natural === 'water',
      });
    } else if (tags.barrier) {
      data.features.push({ id: rw.id, kind: 'barrier', ring: rw.ring, closed: false });
    } else if (tags.man_made || tags.power) {
      data.features.push({ id: rw.id, kind: 'structure', ring: rw.ring, closed: rw.closed });
    } else if (tags.landuse || tags.leisure || tags.amenity || tags.natural) {
      if (rw.closed && rw.ring.length >= 3) {
        data.features.push({ id: rw.id, kind: 'area', ring: rw.ring, closed: true });
      }
    }
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

function pointInPolygon(pt, ring, holes) {
  if (!pointInRing(pt, ring)) return false;
  if (holes && holes.length) {
    for (const h of holes) if (h && h.length >= 3 && pointInRing(pt, h)) return false;
  }
  return true;
}

// Minimum distance in metres from pt to any edge of ring. Used so a vertex
// cleanly snapped onto a neighbouring building's wall is not falsely flagged as
// overlapping that building by ray-casting boundary ambiguity.
function distToRingEdgeM(pt, ring) {
  const mLat = 111320;
  const mLon = 111320 * Math.cos(pt[0] * Math.PI / 180);
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    const bx = (b[1] - a[1]) * mLon, by = (b[0] - a[0]) * mLat;
    const px = (pt[1] - a[1]) * mLon, py = (pt[0] - a[0]) * mLat;
    const len2 = bx * bx + by * by;
    let t = len2 > 1e-12 ? (px * bx + py * by) / len2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const d = Math.hypot(px - t * bx, py - t * by);
    if (d < best) best = d;
  }
  return best;
}

function ringCentroidSimple(ring) {
  let la = 0, lo = 0;
  for (const p of ring) { la += p[0]; lo += p[1]; }
  return [la / ring.length, lo / ring.length];
}

// Verdict from real geometry rather than centroid distance. Containment either
// way counts as an overlap: a candidate drawn inside an existing footprint is a
// duplicate, and so is an existing building sitting inside the candidate.
// Vertices sitting directly on an existing wall (within 15 cm, e.g. snapped
// semi-detached houses) do not trigger a false overlap.
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
      if (pointInPolygon(c.ring[0], w.ring, w.holes)) {
        return { tier: 2, why: w.hn ? 'inside ' + it + ' ' + w.hn : 'inside ' + it };
      }
      continue;
    }
    if (pointInPolygon(ringCentroidSimple(c.ring), w.ring, w.holes)) return { tier: 2, why: 'covered by ' + it };
    if (pointInPolygon(ringCentroidSimple(w.ring), c.ring, c.holes)) return { tier: 2, why: 'contains ' + it };
    for (const v of c.ring) {
      if (pointInPolygon(v, w.ring, w.holes) && distToRingEdgeM(v, w.ring) > 0.15) {
        return { tier: 2, why: 'overlaps ' + it };
      }
    }
  }
  return { tier: null, why: '' };
}

function segsCross(a, b, c, d) {
  const ccw = (p, q, r) => (r[0] - p[0]) * (q[1] - p[1]) - (q[0] - p[0]) * (r[1] - p[1]);
  const d1 = ccw(a, b, c), d2 = ccw(a, b, d);
  const d3 = ccw(c, d, a), d4 = ccw(c, d, b);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
         ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

// Warn if a candidate building sits on top of a mapped OSM road/highway.
// Covered/underground passages and indoor corridors are ignored.
const ROAD_SKIP = { steps: 1, corridor: 1, elevator: 1, platform: 1, proposed: 1 };
function highwayOverlap(c, cell) {
  if (!cell || !cell.features || !cell.features.length || c.kind !== 'building') return null;
  const ring = c.ring;
  if (!ring || ring.length < 3) return null;
  for (const f of cell.features) {
    if (f.kind !== 'highway' || f.covered || ROAD_SKIP[f.sub]) continue;
    const pts = f.ring;
    if (!pts || pts.length < 2) continue;
    for (const pt of pts) {
      if (pointInPolygon(pt, ring, c.holes) && distToRingEdgeM(pt, ring) > 0.2) {
        return { tier: 2, why: 'overlaps an OSM road' };
      }
    }
    for (let k = 0; k + 1 < pts.length; k++) {
      const p1 = pts[k], p2 = pts[k + 1];
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        if (segsCross(p1, p2, ring[j], ring[i])) {
          return { tier: 2, why: 'crosses an OSM road' };
        }
      }
    }
  }
  return null;
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
    if (w.hn) {
      const p = ringCentroidSimple(w.ring);
      near.push({ lat: p[0], lon: p[1], hn: w.hn, street: w.street || '' });
    }
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
    ways.push({ ring: q.ring, holes: q.holes || [], hn: q.hn });
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
    else L.polygon(p.holes && p.holes.length ? [p.ring, ...p.holes] : p.ring, opts).addTo(pendingLayer);
  }
}

const CTX_FEATURE_STYLE = {
  area:      { color: '#94a3b8', weight: 1,   opacity: 0.35, fillColor: '#94a3b8', fillOpacity: 0.05 },
  water:     { color: '#38bdf8', weight: 1.5, opacity: 0.55, fillColor: '#38bdf8', fillOpacity: 0.12 },
  barrier:   { color: '#94a3b8', weight: 1,   opacity: 0.38, dashArray: '2,3' },
  railway:   { color: '#c084fc', weight: 1.5, opacity: 0.55, dashArray: '5,4' },
  highway:   { color: '#fde68a', weight: 2,   opacity: 0.52, fillColor: '#fde68a', fillOpacity: 0.08 },
  structure: { color: '#67e8f9', weight: 1.5, opacity: 0.55, dashArray: '3,3', fillColor: '#67e8f9', fillOpacity: 0.08 },
};

function drawContext() {
  ctxLayer.clearLayers();
  const c = cur();
  if (!c) return;
  const centre = c.kind === 'address' ? c.ring[0] : c.centroid;

  // Load just the cells this candidate needs (normally its own; see
  // ctxCellsNeeded), one at a time, newest candidate wins. Whatever is cached
  // or already loaded draws immediately; each settle repaint upgrades dots to
  // footprints as the missing cells arrive. Waiting for every envelope cell
  // before drawing anything was tried and read as a regression: one slow cell
  // blanked the whole context layer for up to ~75 s per candidate. Firing all
  // of them concurrently was also tried: a fast walk through the queue steps a
  // cell or two per candidate, and 4-way /map bursts per step get throttled —
  // at the buildings the reviewer is heading for next, no less.
  {
    const now = Date.now();
    const need = ctxCellsNeeded(centre[0], centre[1], ctxPts).filter((it) => {
      const have = ctxCells.get(it.key);
      // Loaded or in flight: leave it alone (kicking a cached cell here would
      // resolve immediately, repaint, and recurse into itself forever).
      if (have && have !== 'failed') return false;
      // A failed cell cools down for a minute before the next try, so a burst
      // of 503s costs one request a minute instead of one per pan.
      if (have === 'failed' && now - (ctxLastFail.get(it.key) || 0) < 60000) return false;
      ctxCells.delete(it.key);
      return true;
    });
    (async () => {
      while (need.length) {
        const it = need.shift();
        if (cur() !== c) return; // the reviewer moved on; the next draw re-plans
        await loadCtxCell(it.lat, it.lon).catch(() => {});
        if (cur() === c) { drawContext(); paintChrome(); }
      }
    })();
  }

  const near = ctxNear(centre[0], centre[1]);

  // Draw non-building OSM context underneath footprints (roads, railways,
  // waterways, barriers, mapped landuse/amenity areas) so mapped features are
  // never invisible over the orthophoto.
  for (const f of (near.features || [])) {
    const st = Object.assign({ interactive: false }, CTX_FEATURE_STYLE[f.kind] || CTX_FEATURE_STYLE.area);
    if (f.closed) {
      const rings = f.holes && f.holes.length ? [f.ring, ...f.holes] : f.ring;
      L.polygon(rings, st).addTo(ctxLayer);
    } else {
      L.polyline(f.ring, st).addTo(ctxLayer);
    }
  }

  // Faint centroid dots for whatever the cheap area-wide index knows about,
  // so context outside the loaded cells is not simply absent.
  // A dot that falls inside a loaded footprint is skipped: the outline explains
  // the building better than its centroid does, and far from the current
  // candidate a bare dot over blank ortho reads as a bug —
  // "a dot instead of a building".
  for (const [la, lo] of ctxPts) {
    if (metresBetween(centre, [la, lo]) > 150) continue;
    if (near.ways.some((w) => pointInPolygon([la, lo], w.ring, w.holes))) continue;
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

  for (const w of near.ways) {
    const rings = w.holes && w.holes.length ? [w.ring, ...w.holes] : w.ring;
    L.polygon(rings, {
      // Heavy enough to read on its own: over uncovered ortho (white tiles) the
      // old thin dashed line all but disappeared, leaving only the centroid
      // dot — "a dot instead of a building".
      color: '#22d3ee',
      weight: w.part ? 1.5 : 2,
      opacity: w.part ? 0.65 : 0.9,
      dashArray: w.part ? '2,3' : '4,3',
      fillColor: '#22d3ee',
      fillOpacity: w.part ? 0.07 : 0.14,
      interactive: false,
    }).addTo(ctxLayer);
    // In Poland the house number often lives on the building rather than on a
    // separate node, and an unlabelled footprint hid those addresses: the map
    // showed a building with no sign it was already numbered. Same cyan label as
    // an address node, placed on the footprint it belongs to.
    if (w.hn) {
      const [la, lo] = ringCentroidSimple(w.ring);
      L.marker([la, lo], {
        interactive: false,
        icon: L.divIcon({ className: 'ctxHn way', html: esc(String(w.hn)), iconSize: null }),
      }).addTo(ctxLayer);
    }
  }
  for (const a of near.addrs) {
    L.circleMarker([a.lat, a.lon], {
      radius: 4, color: '#22d3ee', weight: 2, fillOpacity: 0.8,
      fillColor: '#0b1620', interactive: false,
    }).addTo(ctxLayer);
    L.marker([a.lat, a.lon], {
      interactive: false,
      icon: L.divIcon({ className: 'ctxHn', html: esc(String(a.hn)), iconSize: null }),
    }).addTo(ctxLayer);
  }

  if (typeof refreshAutoSnaps === 'function') refreshAutoSnaps();
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

