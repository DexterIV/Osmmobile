// ---- Snapping buildings to existing OSM nodes and walls --------------------
// Uploading a semi-detached house, garage, or annex without sharing nodes with
// the adjacent OSM building leaves microscopic gaps or overlaps that OSM QA
// tools flag immediately. These helpers snap candidate vertices to nearby
// existing building corners (reusing positive OSM node IDs) or wall segments
// (recording an edge attachment so uploadQueue can insert the shared node into
// the existing way via <modify>), and also snap against buildings already
// accepted in the current session.
//
// Buildings snap ONLY to buildings (never to highways, barriers or landuse —
// gluing a building to a road or landuse is an OSM mapping error).
//
// Pure geometry functions live at the top (no DOM/Leaflet) so test/snap.test.mjs
// can slice and test them directly.

const SNAP_NODE_TOL_M = 1.2;    // explicit Snap (S) corner tolerance
const SNAP_EDGE_TOL_M = 1.0;    // explicit Snap (S) wall-segment tolerance
const SNAP_REV_TOL_M = 0.7;     // reverse T-junction: existing corner onto candidate edge
const SNAP_END_MERGE_M = 0.35;  // snap to endpoint instead of creating a tiny wall stub
const SNAP_AUTO_TOL_M = 0.35;   // tight auto-glue threshold on accept / display

// Project pt [lat, lon] onto segment a -> b in local isotropic metres.
function projectOnSeg(pt, a, b) {
  const mLat = 111320;
  const mLon = 111320 * Math.cos(a[0] * Math.PI / 180);
  const bx = (b[1] - a[1]) * mLon, by = (b[0] - a[0]) * mLat;
  const px = (pt[1] - a[1]) * mLon, py = (pt[0] - a[0]) * mLat;
  const len2 = bx * bx + by * by;
  if (len2 < 1e-12) {
    const d = Math.hypot(px, py);
    return { pt: [a[0], a[1]], distM: d, t: 0, distA: d, distB: d, lenM: 0 };
  }
  const lenM = Math.sqrt(len2);
  let t = (px * bx + py * by) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const qx = t * bx, qy = t * by;
  const distM = Math.hypot(px - qx, py - qy);
  return {
    pt: [a[0] + qy / mLat, a[1] + qx / mLon],
    distM,
    t,
    distA: t * lenM,
    distB: (1 - t) * lenM,
    lenM,
  };
}

function ringOpen(ring) {
  if (!ring || ring.length < 2) return ring ? ring.slice() : [];
  const a = ring[0], z = ring[ring.length - 1];
  if (a[0] === z[0] && a[1] === z[1]) return ring.slice(0, -1);
  return ring.slice();
}

function ringAreaM2(ring) {
  const r = ringOpen(ring);
  if (r.length < 3) return 0;
  const la0 = r[0][0], lo0 = r[0][1];
  const mLat = 111320;
  const mLon = 111320 * Math.cos(la0 * Math.PI / 180);
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length];
    const ax = (a[1] - lo0) * mLon, ay = (a[0] - la0) * mLat;
    const bx = (b[1] - lo0) * mLon, by = (b[0] - la0) * mLat;
    s += ax * by - bx * ay;
  }
  return Math.abs(s) / 2;
}

// Find the best snap target for a single vertex pt [lat, lon] across building
// targets. Each target is either:
//   { source: 'osm', wayId, ring, nodeIds }
//   { source: 'queue', key, ring }
// Corners (nodes) always take priority over wall segments within nodeTolM so a
// corner near an existing corner glues cleanly instead of creating a short stub.
function snapPointToTargets(pt, targets, opts) {
  if (!targets || !targets.length) return null;
  const nodeTol = (opts && opts.nodeTolM != null) ? opts.nodeTolM : SNAP_NODE_TOL_M;
  const edgeTol = (opts && opts.edgeTolM != null) ? opts.edgeTolM : SNAP_EDGE_TOL_M;
  const endMerge = (opts && opts.endMergeM != null) ? opts.endMergeM : SNAP_END_MERGE_M;

  let bestNode = null;
  let bestEdge = null;

  for (const tgt of targets) {
    const r = ringOpen(tgt.ring);
    const n = r.length;
    if (n < 3) continue;
    const nids = tgt.nodeIds || null;

    for (let i = 0; i < n; i++) {
      const v = r[i];
      const d = metresBetween(pt, v);
      if (d <= nodeTol && (!bestNode || d < bestNode.distM)) {
        const nid = nids && nids[i] > 0 ? nids[i] : 0;
        bestNode = {
          pt: [v[0], v[1]],
          kind: tgt.source === 'osm' && nid > 0 ? 'node' : 'qnode',
          nodeId: nid,
          wayId: tgt.wayId || 0,
          qKey: tgt.key || '',
          distM: d,
        };
      }
    }

    if (edgeTol <= 0) continue;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = r[i], b = r[j];
      const proj = projectOnSeg(pt, a, b);
      if (proj.lenM < 0.05 || proj.distM > edgeTol) continue;
      if (bestEdge && proj.distM >= bestEdge.distM) continue;

      // Near either endpoint of the segment: upgrade to a corner snap rather
      // than inserting a node 15 cm away from an existing corner.
      if (proj.distA <= endMerge || proj.distB <= endMerge) {
        const idx = proj.distA <= proj.distB ? i : j;
        const v = r[idx];
        const nid = nids && nids[idx] > 0 ? nids[idx] : 0;
        const dEnd = metresBetween(pt, v);
        if (!bestNode || dEnd < bestNode.distM) {
          bestNode = {
            pt: [v[0], v[1]],
            kind: tgt.source === 'osm' && nid > 0 ? 'node' : 'qnode',
            nodeId: nid,
            wayId: tgt.wayId || 0,
            qKey: tgt.key || '',
            distM: dEnd,
          };
        }
        continue;
      }

      if (tgt.source === 'osm') {
        const aId = nids && nids[i] > 0 ? nids[i] : 0;
        const bId = nids && nids[j] > 0 ? nids[j] : 0;
        bestEdge = {
          pt: proj.pt,
          kind: (tgt.wayId > 0 && aId > 0 && bId > 0) ? 'edge' : 'qedge',
          wayId: tgt.wayId || 0,
          aNodeId: aId,
          bNodeId: bId,
          t: proj.t,
          distM: proj.distM,
        };
      } else {
        bestEdge = {
          pt: proj.pt,
          kind: 'qedge',
          qKey: tgt.key || '',
          segIdx: i,
          t: proj.t,
          distM: proj.distM,
        };
      }
    }
  }

  return bestNode || bestEdge;
}

// Snap an entire building ring to nearby building targets:
//   1. Snap candidate vertices to nearby target corners or wall segments.
//   2. Insert target corners that sit along a candidate wall (reverse T-junction)
//      so the candidate shares those existing corners without modifying the
//      neighbouring way.
//   3. Deduplicate collapsed consecutive vertices and reject degenerate output.
function snapRingToTargets(ring, targets, opts) {
  const open = ringOpen(ring);
  if (open.length < 3 || !targets || !targets.length) return null;
  const revTol = (opts && opts.revTolM != null) ? opts.revTolM : SNAP_REV_TOL_M;
  const endMerge = (opts && opts.endMergeM != null) ? opts.endMergeM : SNAP_END_MERGE_M;

  const origArea = ringAreaM2(open);
  const work = [];
  const snaps = [];
  let nodeHits = 0, edgeHits = 0, inserted = 0;

  for (let i = 0; i < open.length; i++) {
    const hit = snapPointToTargets(open[i], targets, opts);
    if (hit) {
      work.push(hit.pt);
      snaps.push(hit);
      if (hit.kind === 'node' || hit.kind === 'qnode') nodeHits++;
      else edgeHits++;
    } else {
      work.push(open[i].slice());
      snaps.push(null);
    }
  }

  // Reverse T-junctions: check if any target building corner sits cleanly on
  // one of the candidate's edges and insert it into the candidate ring.
  const usedCoords = new Set(work.map(([la, lo]) => la.toFixed(7) + ',' + lo.toFixed(7)));
  const finalPts = [];
  const finalSnaps = [];

  for (let i = 0; i < work.length; i++) {
    const a = work[i];
    const b = work[(i + 1) % work.length];
    finalPts.push(a);
    finalSnaps.push(snaps[i]);

    if (revTol <= 0) continue;
    const extras = [];
    for (const tgt of targets) {
      const r = ringOpen(tgt.ring);
      const nids = tgt.nodeIds || null;
      for (let k = 0; k < r.length; k++) {
        const v = r[k];
        const key = v[0].toFixed(7) + ',' + v[1].toFixed(7);
        if (usedCoords.has(key)) continue;
        const proj = projectOnSeg(v, a, b);
        if (proj.lenM < endMerge * 2) continue;
        if (proj.distM <= revTol && proj.distA > endMerge && proj.distB > endMerge) {
          const nid = nids && nids[k] > 0 ? nids[k] : 0;
          extras.push({
            t: proj.t,
            key,
            pt: [v[0], v[1]],
            snap: {
              pt: [v[0], v[1]],
              kind: tgt.source === 'osm' && nid > 0 ? 'node' : 'qnode',
              nodeId: nid,
              wayId: tgt.wayId || 0,
              qKey: tgt.key || '',
              distM: proj.distM,
            },
          });
        }
      }
    }
    extras.sort((x, y) => x.t - y.t);
    for (const ex of extras) {
      if (usedCoords.has(ex.key)) continue;
      usedCoords.add(ex.key);
      finalPts.push(ex.pt);
      finalSnaps.push(ex.snap);
      inserted++;
    }
  }

  // Deduplicate consecutive near-identical vertices (< 5 cm), keeping snapped
  // vertices over unsnapped ones when two collapse onto the same corner.
  const outPts = [];
  const outSnaps = [];
  for (let i = 0; i < finalPts.length; i++) {
    const prev = outPts[outPts.length - 1];
    if (prev && metresBetween(prev, finalPts[i]) < 0.05) {
      if (!outSnaps[outSnaps.length - 1] && finalSnaps[i]) {
        outPts[outPts.length - 1] = finalPts[i];
        outSnaps[outSnaps.length - 1] = finalSnaps[i];
      }
      continue;
    }
    outPts.push(finalPts[i]);
    outSnaps.push(finalSnaps[i]);
  }
  while (outPts.length > 1 && metresBetween(outPts[0], outPts[outPts.length - 1]) < 0.05) {
    if (!outSnaps[0] && outSnaps[outSnaps.length - 1]) {
      outPts[0] = outPts[outPts.length - 1];
      outSnaps[0] = outSnaps[outSnaps.length - 1];
    }
    outPts.pop();
    outSnaps.pop();
  }

  if (outPts.length < 3) return null;
  if (origArea > 0 && ringAreaM2(outPts) < Math.max(1, origArea * 0.5)) return null;
  if (!nodeHits && !edgeHits && !inserted) return null;

  return {
    ring: outPts,
    snaps: outSnaps,
    stats: { nodes: nodeHits, edges: edgeHits, inserted },
  };
}

// Tight auto-snap pass used on accept and for live green snap indicators:
// only attaches vertices already within tolM (default 35 cm, under the z14 MVT
// quantisation step) so detached buildings with a narrow alley are never
// pulled together by surprise.
function computeAutoSnaps(ring, targets, tolM) {
  const tol = tolM != null ? tolM : SNAP_AUTO_TOL_M;
  return snapRingToTargets(ring, targets, {
    nodeTolM: tol,
    edgeTolM: tol * 0.85,
    revTolM: tol * 0.85,
    endMergeM: Math.min(0.25, tol),
  });
}

// Parse live OSM XML returned by GET /api/0.6/nodes?nodes=... and
// GET /api/0.6/ways?ways=... into { nodes: Map, ways: Map } for osmChange.
// Uses unesc() on tag values so Polish characters and XML entities round-trip
// cleanly when osmChange re-escapes them.
function parseLiveOsmXml(text) {
  const nodes = new Map();
  const ways = new Map();
  if (!text) return { nodes, ways };

  const nodeRe = /<node\b([^>]*?)(?:\/>|>[\s\S]*?<\/node>)/g;
  let m;
  while ((m = nodeRe.exec(text))) {
    const attrs = m[1];
    if (/visible="false"/.test(attrs)) continue;
    const idM = /\bid="(-?\d+)"/.exec(attrs);
    const latM = /\blat="([-\d.]+)"/.exec(attrs);
    const lonM = /\blon="([-\d.]+)"/.exec(attrs);
    if (!idM || !latM || !lonM) continue;
    nodes.set(Number(idM[1]), { lat: parseFloat(latM[1]), lon: parseFloat(lonM[1]) });
  }

  const wayRe = /<way\b([^>]*)>([\s\S]*?)<\/way>/g;
  while ((m = wayRe.exec(text))) {
    const attrs = m[1];
    const body = m[2];
    if (/visible="false"/.test(attrs)) continue;
    const idM = /\bid="(-?\d+)"/.exec(attrs);
    const verM = /\bversion="(\d+)"/.exec(attrs);
    if (!idM || !verM) continue;
    const nds = [];
    const ndRe = /<nd\s+ref="(-?\d+)"\s*\/>/g;
    let n;
    while ((n = ndRe.exec(body))) nds.push(Number(n[1]));
    const tags = [];
    const tagRe = /<tag\s+k=(["'])(.*?)\1\s+v=(["'])([\s\S]*?)\3\s*\/?>/g;
    let t;
    while ((t = tagRe.exec(body))) tags.push([unesc(t[2]), unesc(t[4])]);
    ways.set(Number(idM[1]), { id: Number(idM[1]), version: Number(verM[1]), nds, tags });
  }

  return { nodes, ways };
}

// ---- App integration (uses map, ctxNear, queuedShapes, cur, etc.) -----------

function snapTargetsFor(c) {
  if (!c || c.kind !== 'building') return [];
  const centre = c.centroid || ringCentroidSimple(c.ring);
  const targets = [];
  const near = ctxNear(centre[0], centre[1]);
  for (const w of near.ways) {
    if (!w.ring || w.ring.length < 3) continue;
    targets.push({ source: 'osm', wayId: w.id || 0, ring: w.ring, nodeIds: w.nodeIds || null });
  }
  for (const q of queuedShapes) {
    if (q.key === c.key || q.kind !== 'building') continue;
    if (metresBetween(centre, ringCentroidSimple(q.ring)) > 150) continue;
    targets.push({ source: 'queue', key: q.key, ring: q.ring, nodeIds: null });
  }
  return targets;
}

function drawSnapMarkers(liveHit) {
  if (!snapLayer) return;
  snapLayer.clearLayers();
  const c = cur();
  if (!c || c.kind !== 'building') return;

  const snaps = c.snaps || [];
  for (let i = 0; i < c.ring.length; i++) {
    const s = snaps[i];
    if (!s) continue;
    const isNode = s.kind === 'node' || s.kind === 'qnode';
    L.circleMarker(c.ring[i], {
      radius: isNode ? 6 : 5,
      color: '#34d399',
      weight: 2.5,
      fillColor: isNode ? '#34d399' : '#0b1620',
      fillOpacity: isNode ? 0.45 : 0.85,
      interactive: false,
    }).addTo(snapLayer);
  }

  // Show an active magnetic highlight ring while dragging a vertex onto a snap.
  if (liveHit && liveHit.pt) {
    L.circleMarker(liveHit.pt, {
      radius: 10,
      color: '#34d399',
      weight: 2.5,
      dashArray: liveHit.kind === 'edge' || liveHit.kind === 'qedge' ? '3,3' : null,
      fillColor: '#34d399',
      fillOpacity: 0.25,
      interactive: false,
    }).addTo(snapLayer);
  }
}

function refreshAutoSnaps() {
  const c = cur();
  if (!c || c.kind !== 'building') { drawSnapMarkers(); return; }
  const targets = snapTargetsFor(c);
  if (!targets.length) { drawSnapMarkers(); return; }
  // Preserve explicit snaps while detecting any vertices already touching
  // nearby OSM or queued building corners/walls (within 20 cm).
  const next = new Array(c.ring.length).fill(null);
  for (let i = 0; i < c.ring.length; i++) {
    const hit = snapPointToTargets(c.ring[i], targets, {
      nodeTolM: 0.2, edgeTolM: 0.15, endMergeM: 0.15,
    });
    if (hit) next[i] = hit;
  }
  c.snaps = next;
  drawSnapMarkers();
}

function snapCurrent() {
  const c = cur();
  if (!c) return;
  if (c.kind !== 'building') {
    toast('Only building outlines can be snapped', 'warn');
    return;
  }
  const targets = snapTargetsFor(c);
  if (!targets.length) {
    toast('No nearby OSM or queued buildings loaded to snap to', 'warn');
    return;
  }
  const res = snapRingToTargets(c.ring, targets, {
    nodeTolM: SNAP_NODE_TOL_M,
    edgeTolM: SNAP_EDGE_TOL_M,
    revTolM: SNAP_REV_TOL_M,
    endMergeM: SNAP_END_MERGE_M,
  });
  if (!res) {
    toast('No building corners or walls within ' + SNAP_NODE_TOL_M + ' m', 'warn');
    return;
  }
  pushUndo();
  c.ring = res.ring;
  c.snaps = res.snaps;
  c.centroid = centroid(res.ring);
  c.moved = true;
  drawShape();
  paintChrome();
  const parts = [];
  if (res.stats.nodes) parts.push(res.stats.nodes + ' corner' + (res.stats.nodes > 1 ? 's' : ''));
  if (res.stats.edges) parts.push(res.stats.edges + ' wall' + (res.stats.edges > 1 ? 's' : ''));
  if (res.stats.inserted) parts.push(res.stats.inserted + ' shared corner' + (res.stats.inserted > 1 ? 's' : ''));
  toast('Snapped: ' + parts.join(', '));
}
