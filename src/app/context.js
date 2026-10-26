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

