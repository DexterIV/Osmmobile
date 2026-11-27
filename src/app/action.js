let verdicting = false;
async function verdict(kind) {
  if (verdicting) return;
  verdicting = true;
  try {
    const c = cur();
    if (!c) return;
    await dbPut('decisions', c.key, { verdict: kind, t: Date.now() });
    if (kind === 'reject') reportReject(c);
    if (kind === 'accept') {
      let ring = c.ring;
      let snaps = c.snaps || null;
      // Tight auto-glue on accept (<= 35 cm, under z14 MVT quantisation) for
      // buildings that were not explicitly snapped, so adjacent buildings share
      // nodes cleanly with existing OSM or queued buildings instead of leaving
      // tiny gaps or duplicate coincident nodes.
      if (c.kind === 'building' && typeof snapTargetsFor === 'function') {
        const targets = snapTargetsFor(c);
        if (targets.length) {
          if (!snaps || !snaps.some(Boolean)) {
            const auto = computeAutoSnaps(ring, targets, SNAP_AUTO_TOL_M);
            if (auto) { ring = auto.ring; snaps = auto.snaps; }
          } else {
            // Re-verify each vertex attachment against current ring coords.
            snaps = ring.map((pt, idx) => {
              const curSnap = snaps[idx];
              if (curSnap && curSnap.pt && metresBetween(pt, curSnap.pt) < 0.05) return curSnap;
              return snapPointToTargets(pt, targets, { nodeTolM: 0.25, edgeTolM: 0.2, endMergeM: 0.2 });
            });
          }
        }
      }
      await dbPut('queue', c.key, {
        kind: c.kind, ring, tags: c.tags, t: Date.now(),
        // Without holes here an approved forest-island-in-farmland uploads solid.
        holes: (c.holes || []).filter((h) => h && h.length >= 3),
        snaps: snaps && snaps.some(Boolean) ? snaps : null,
        moved: !!c.moved, city: c.tags['addr:city'] || '',
      });
    }
    const el = $('map');
    el.classList.add(kind === 'accept' ? 'flickR' : kind === 'reject' ? 'flickL' : 'flickU');
    setTimeout(() => el.classList.remove('flickR', 'flickL', 'flickU'), 130);
    cursor++;
    await refreshQueueBadge();
    show();
  } finally {
    verdicting = false;
  }
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

function osmChange(items, changesetId, liveOsm) {
  let id = -1;
  const create = [];
  const modify = [];

  // Self-contained metric projection so osmChange stays sliceable for tests
  // without external geometry globals.
  const projSeg = (pt, a, b) => {
    const mLat = 111320;
    const mLon = 111320 * Math.cos(a[0] * Math.PI / 180);
    const bx = (b[1] - a[1]) * mLon, by = (b[0] - a[0]) * mLat;
    const px = (pt[1] - a[1]) * mLon, py = (pt[0] - a[0]) * mLat;
    const len2 = bx * bx + by * by;
    if (len2 < 1e-12) return { distM: Math.hypot(px, py), t: 0, distA: 0, distB: 0, lenM: 0 };
    const lenM = Math.sqrt(len2);
    let t = (px * bx + py * by) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const distM = Math.hypot(px - t * bx, py - t * by);
    return { distM, t, distA: t * lenM, distB: (1 - t) * lenM, lenM };
  };

  // Clone building rings/snaps and insert shared vertices where one queued
  // building snapped onto another queued building's wall segment, so both ways
  // share the same created node instead of forming an unglued T-junction.
  const work = items.map((it) => ({
    it,
    ring: it.ring ? it.ring.map((p) => p.slice()) : [],
    snaps: it.snaps ? it.snaps.slice() : null,
  }));

  for (let ai = 0; ai < work.length; ai++) {
    const a = work[ai];
    if (a.it.kind !== 'building' || a.ring.length < 3) continue;
    const newRing = [];
    const newSnaps = [];
    for (let i = 0; i < a.ring.length; i++) {
      const p1 = a.ring[i];
      const p2 = a.ring[(i + 1) % a.ring.length];
      newRing.push(p1);
      newSnaps.push(a.snaps ? (a.snaps[i] || null) : null);
      const extras = [];
      for (let bi = 0; bi < work.length; bi++) {
        if (bi === ai) continue;
        const b = work[bi];
        if (b.it.kind !== 'building' || b.ring.length < 3) continue;
        for (let k = 0; k < b.ring.length; k++) {
          const v = b.ring[k];
          const pr = projSeg(v, p1, p2);
          if (pr.distM <= 0.05 && pr.distA > 0.05 && pr.distB > 0.05) {
            extras.push({ t: pr.t, pt: v.slice(), snap: b.snaps ? (b.snaps[k] || null) : null });
          }
        }
      }
      extras.sort((x, y) => x.t - y.t);
      for (const ex of extras) {
        const prev = newRing[newRing.length - 1];
        if (prev[0].toFixed(7) === ex.pt[0].toFixed(7) && prev[1].toFixed(7) === ex.pt[1].toFixed(7)) continue;
        newRing.push(ex.pt);
        newSnaps.push(ex.snap);
      }
    }
    a.ring = newRing;
    a.snaps = newSnaps.some(Boolean) ? newSnaps : null;
  }

  // One node per coordinate for the whole changeset, keyed at OSM's own 7-decimal
  // limit. Existing positive OSM node ids (from snapped corners or liveOsm) are
  // reused directly without emitting duplicate <node> elements.
  const nodeIds = new Map();
  if (liveOsm && liveOsm.nodes) {
    for (const [nid, pos] of liveOsm.nodes.entries()) {
      if (nid > 0 && pos && Number.isFinite(pos.lat) && Number.isFinite(pos.lon)) {
        nodeIds.set(pos.lat.toFixed(7) + ',' + pos.lon.toFixed(7), nid);
      }
    }
  }

  const wayInserts = new Map(); // existing wayId -> [{ aNodeId, bNodeId, nid, t }]

  const nodeFor = ([la, lo], snap) => {
    const key = la.toFixed(7) + ',' + lo.toFixed(7);
    if (snap && snap.kind === 'node' && snap.nodeId > 0) {
      const ok = !liveOsm || !liveOsm.nodes || liveOsm.nodes.has(snap.nodeId);
      if (ok) {
        nodeIds.set(key, snap.nodeId);
        return snap.nodeId;
      }
    }
    let nid = nodeIds.get(key);
    if (nid === undefined) {
      nid = id--;
      nodeIds.set(key, nid);
      create.push(`<node id="${nid}" lat="${la.toFixed(7)}" lon="${lo.toFixed(7)}" changeset="${changesetId}" version="0"/>`);
    }
    if (snap && snap.kind === 'edge' && snap.wayId > 0 && snap.aNodeId > 0 && snap.bNodeId > 0) {
      let arr = wayInserts.get(snap.wayId);
      if (!arr) wayInserts.set(snap.wayId, arr = []);
      arr.push({ aNodeId: snap.aNodeId, bNodeId: snap.bNodeId, nid, t: snap.t });
    }
    return nid;
  };

  const wayFor = (ring, tagXml, snaps) => {
    const rawIds = ring.map((pt, idx) => nodeFor(pt, snaps ? snaps[idx] : null));
    const ids = [];
    for (const r of rawIds) {
      if (!ids.length || ids[ids.length - 1] !== r) ids.push(r);
    }
    while (ids.length > 1 && ids[0] === ids[ids.length - 1]) ids.pop();
    if (ids.length < 3) return null;
    const nds = ids.concat([ids[0]]).map((r) => `<nd ref="${r}"/>`).join('');
    const wid = id--;
    create.push(`<way id="${wid}" changeset="${changesetId}" version="0">${nds}${tagXml || ''}</way>`);
    return wid;
  };

  for (const w of work) {
    const it = w.it;
    const tagXml = Object.entries(it.tags).filter(([k]) => !S.dropKeys.includes(k))
      .map(([k, v]) => `<tag k="${esc(k)}" v="${esc(v)}"/>`).join('');
    if (it.kind === 'address') {
      const [la, lo] = w.ring[0];
      create.push(`<node id="${id--}" lat="${la.toFixed(7)}" lon="${lo.toFixed(7)}" changeset="${changesetId}" version="0">${tagXml}</node>`);
      continue;
    }
    const holes = (it.holes || []).filter((h) => h && h.length >= 3);
    if (!holes.length) {
      wayFor(w.ring, tagXml, w.snaps);
      continue;
    }
    // Holes present, so the tags belong on a type=multipolygon relation and the
    // rings stay untagged. Tagging the outer way instead would fill the hole in.
    const outer = wayFor(w.ring, '', w.snaps);
    if (outer === null) continue;
    const members = ['<member type="way" ref="' + outer + '" role="outer"/>'];
    for (const h of holes) {
      const inner = wayFor(h, '', null);
      if (inner !== null) members.push('<member type="way" ref="' + inner + '" role="inner"/>');
    }
    create.push('<relation id="' + (id--) + '" changeset="' + changesetId + '" version="0">' +
      members.join('') + '<tag k="type" v="multipolygon"/>' + tagXml + '</relation>');
  }

  // Emit <modify> for existing OSM ways whose wall segments received a snapped
  // node, inserting new nodes in exact geometric order along each segment while
  // preserving every existing node ref and tag verbatim.
  if (wayInserts.size && liveOsm && liveOsm.ways) {
    for (const [wayId, insList] of wayInserts.entries()) {
      const lw = liveOsm.ways.get(wayId);
      if (!lw || !lw.nds || lw.nds.length < 2) continue;
      const newNds = [];
      let changed = false;
      for (let k = 0; k < lw.nds.length; k++) {
        const u = lw.nds[k];
        newNds.push(u);
        if (k + 1 >= lw.nds.length) continue;
        const v = lw.nds[k + 1];
        const segIns = [];
        for (const ins of insList) {
          if (ins.nid === u || ins.nid === v) continue;
          if (ins.aNodeId === u && ins.bNodeId === v) segIns.push({ nid: ins.nid, pos: ins.t });
          else if (ins.aNodeId === v && ins.bNodeId === u) segIns.push({ nid: ins.nid, pos: 1 - ins.t });
        }
        if (!segIns.length) continue;
        segIns.sort((a, b) => a.pos - b.pos);
        const added = new Set();
        for (const s of segIns) {
          if (added.has(s.nid)) continue;
          added.add(s.nid);
          newNds.push(s.nid);
          changed = true;
        }
      }
      if (!changed) continue;
      const ndsXml = newNds.map((r) => `<nd ref="${r}"/>`).join('');
      const tagsXml = (lw.tags || []).map(([k, v]) => `<tag k="${esc(k)}" v="${esc(v)}"/>`).join('');
      modify.push(`<way id="${lw.id}" version="${lw.version}" changeset="${changesetId}">${ndsXml}${tagsXml}</way>`);
    }
  }

  return `<osmChange version="0.6" generator="orto-review"><create>${create.join('')}</create>` +
    (modify.length ? `<modify>${modify.join('')}</modify>` : '') +
    `</osmChange>`;
}

