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

// Squarify, following iD's Q. Only a corner already within 13° of a right
// angle moves; a 45° corner or a rotated building keeps its shape because
// snapping every vertex to the nearest axis would invent a right angle the
// building never had. Points on nearly straight runs are dropped instead of
// moved, which also makes a second press a no-op rather than slowly adding
// staircase vertices.
//
// Kept free of DOM and wasm so the test can slice it out of this file.
function orthogonalizeRing(ring) {
  const THRESH = 13 * Math.PI / 180;
  const EPS = 1e-4;
  const LOWER = Math.cos(Math.PI / 2 - THRESH);   // cos(77°), near a right angle
  const UPPER = Math.cos(THRESH);                 // cos(13°), near a straight run

  // Local metres. Degrees are not isotropic, so dot products in raw lat/lon
  // would bias every motion towards north-south.
  const la0 = ring[0][0], lo0 = ring[0][1];
  const mLat = 111320;
  const mLon = 111320 * Math.cos(la0 * Math.PI / 180);
  const flat = ring.map(([la, lo]) => [(lo - lo0) * mLon, (la - la0) * mLat]);

  // Zero-length edges normalize to [0,0] and make every dot product meaningless,
  // so drop consecutive duplicates, including a repeated closing vertex.
  const clean = [];
  for (const p of flat) {
    const q = clean[clean.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) clean.push(p);
  }
  while (clean.length > 1 && Math.hypot(clean[0][0] - clean[clean.length - 1][0],
                                        clean[0][1] - clean[clean.length - 1][1]) < 1e-6) clean.pop();

  const n = clean.length;
  if (n < 3) return null;

  const unit = (x, y) => {
    const len = Math.hypot(x, y);
    return len ? [x / len, y / len] : [0, 0];
  };
  const dotAt = (pts, i) => {
    const a = pts[(i - 1 + pts.length) % pts.length];
    const o = pts[i];
    const b = pts[(i + 1) % pts.length];
    const p = unit(a[0] - o[0], a[1] - o[1]);
    const q = unit(b[0] - o[0], b[1] - o[1]);
    return p[0] * q[0] + p[1] * q[1];
  };

  // A vertex is "straight enough" to remove when its two edges point opposite
  // ways, i.e. |dot| is close to 1. Right-angle candidates have dot near 0.
  const work = [];
  for (let i = 0; i < n; i++) {
    if (Math.abs(dotAt(clean, i)) <= UPPER) work.push(clean[i].slice());
  }
  if (work.length < 3) return null;

  // What iD scores: corners still near 90° are penalised by how far they are
  // from it. Near-straight vertices were already dropped above.
  const score = (pts) => {
    let total = 0;
    for (let i = 0; i < pts.length; i++) {
      const d = dotAt(pts, i);
      const val = Math.abs(d);
      if (val < EPS || val > UPPER) continue;
      if (val < LOWER) total += 2 * Math.min(Math.abs(d - 1), Math.abs(d), Math.abs(d + 1));
    }
    return total;
  };

  // Move a near-right corner along the bisector, proportional to how far off it
  // is. iD's 0.1 damping is what keeps the iteration stable instead of
  // overshooting into a self-intersection.
  const motion = (pts, i) => {
    const a = pts[(i - 1 + pts.length) % pts.length];
    const o = pts[i];
    const b = pts[(i + 1) % pts.length];
    const p = unit(a[0] - o[0], a[1] - o[1]);
    const q = unit(b[0] - o[0], b[1] - o[1]);
    const dot = p[0] * q[0] + p[1] * q[1];
    if (Math.abs(dot) >= LOWER) return [0, 0];
    const scale = 2 * Math.min(Math.hypot(a[0] - o[0], a[1] - o[1]),
                               Math.hypot(b[0] - o[0], b[1] - o[1]));
    const v = unit(p[0] + q[0], p[1] + q[1]);
    return [v[0] * 0.1 * dot * scale, v[1] * 0.1 * dot * scale];
  };

  const start = score(work);
  const dropped = work.length < n;
  // Nothing to move, but a redundant collinear vertex is still worth removing.
  if (start < EPS && !dropped) return null;

  let best = work.map((p) => p.slice());
  let bestScore = start;
  for (let it = 0; it < 1000 && bestScore > EPS; it++) {
    const moves = work.map((_, i) => motion(work, i));
    for (let i = 0; i < work.length; i++) {
      work[i][0] += moves[i][0];
      work[i][1] += moves[i][1];
    }
    const s = score(work);
    if (s < bestScore) {
      bestScore = s;
      best = work.map((p) => p.slice());
    }
  }
  if (!dropped && bestScore >= start - 1e-12) return null;

  // Refuse an output that has collapsed; a bad outline is worse than a skew.
  const area = (pts) => {
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      s += a[0] * b[1] - b[0] * a[1];
    }
    return Math.abs(s) / 2;
  };
  if (area(best) < Math.max(1, area(clean) * 0.5)) return null;

  return best.map(([x, y]) => [la0 + y / mLat, lo0 + x / mLon]);
}

function squarify() {
  const c = cur();
  if (!c) return;
  if (c.kind !== 'building') {
    toast('Only building outlines can be squared', 'warn');
    return;
  }
  const out = orthogonalizeRing(c.ring);
  if (!out) {
    toast('Nothing to square — already square, or corners are not near a right angle', 'warn');
    return;
  }
  pushUndo();
  c.ring = out;
  c.centroid = centroid(out);
  c.moved = true;
  shape.setLatLngs(c.ring);
  drawVertices();
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

