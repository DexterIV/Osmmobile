// Exercises orthogonalizeRing from src/app.js — the pure half of the Q action.
// Sliced out like nearestChain, so no Leaflet, DOM or wasm is needed: the
// function must stay testable on plain [lat, lon] rings.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const from = src.indexOf('function orthogonalizeRing(');
const to = src.indexOf('function squarify(');
assert.ok(from > 0 && to > from, 'could not locate orthogonalizeRing in src/app.js');

const { orthogonalizeRing } = new Function(
  src.slice(from, to) + '; return { orthogonalizeRing };')();

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

// A local metric frame around one point in Warsaw, matching the function's own
// conversion, so a metre in a test is a metre in the result.
const LAT = 52.23, LON = 21.01;
const mLat = 111320;
const mLon = 111320 * Math.cos(LAT * Math.PI / 180);
const at = (x, y) => [LAT + y / mLat, LON + x / mLon];

const angleAt = (ring, i) => {
  // Angle in the same local metre frame the function works in: in raw degrees
  // a metrically square building reads ~91°, because a degree of longitude is
  // only 0.61 of a degree of latitude at this latitude.
  const pts = toLocal(ring);
  const a = pts[(i - 1 + pts.length) % pts.length];
  const o = pts[i];
  const b = pts[(i + 1) % pts.length];
  const p = [a[0] - o[0], a[1] - o[1]];
  const q = [b[0] - o[0], b[1] - o[1]];
  const c = (p[0] * q[0] + p[1] * q[1]) / (Math.hypot(...p) * Math.hypot(...q));
  return Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI;
};
const toLocal = (ring) => ring.map(([la, lo]) => [(lo - LON) * mLon, (la - LAT) * mLat]);
const area = (ring) => {
  const p = toLocal(ring);
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
};

t('a slightly skewed rectangle comes out at right angles', () => {
  const ring = [at(0, 0), at(20, 0.3), at(19.7, 10), at(-0.2, 9.8)];
  const out = orthogonalizeRing(ring);
  assert.ok(out, 'a skewed rectangle must be adjusted');
  assert.equal(out.length, 4, 'no vertex may be added or lost here');
  for (let i = 0; i < out.length; i++) {
    const a = angleAt(out, i);
    assert.ok(Math.abs(a - 90) < 0.5, `corner ${i} is ${a.toFixed(2)}°, expected 90°`);
  }
  const before = area(ring), after = area(out);
  assert.ok(Math.abs(after - before) / before < 0.02,
    `area must barely move: ${before.toFixed(1)} -> ${after.toFixed(1)} m²`);
});

t('an already square outline is left alone, whatever its orientation', () => {
  const rot = 30 * Math.PI / 180;
  const p = [[0, 0], [20, 0], [20, 10], [0, 10]].map(([x, y]) => at(
    x * Math.cos(rot) - y * Math.sin(rot),
    x * Math.sin(rot) + y * Math.cos(rot)));
  assert.equal(orthogonalizeRing(p), null,
    'null is the signal that there is nothing to do, so Q does not push an undo step');
});

t('a collinear vertex is dropped even when the rest is already square', () => {
  const ring = [at(0, 0), at(10, 0.02), at(20, 0), at(20, 10), at(0, 10)];
  const out = orthogonalizeRing(ring);
  assert.ok(out, 'removing a redundant vertex is still a change');
  assert.equal(out.length, 4, 'the point on the straight run should be removed');
  assert.ok(Math.abs(area(out) - area(ring)) < area(ring) * 0.01,
    'dropping a 2 cm bow must not change the area meaningfully');
});

t('a closing duplicate vertex does not break the ring', () => {
  const ring = [at(0, 0), at(20, 0.3), at(19.7, 10), at(-0.2, 9.8)];
  const out = orthogonalizeRing(ring.concat([ring[0]]));
  assert.ok(out);
  assert.equal(out.length, 4);
  for (let i = 0; i < out.length; i++) {
    assert.ok(Math.abs(angleAt(out, i) - 90) < 0.5);
  }
});

t('a rotated building keeps its orientation instead of snapping to north', () => {
  // 30° rotation plus a small digitising error: near enough to 90° for the
  // 13° gate, so the corners move but the whole outline must not rotate.
  const rot = 30 * Math.PI / 180;
  const base = [[0, 0], [20, 0.2], [19.8, 10], [0, 10.2]];
  const ring = base.map(([x, y]) => at(
    x * Math.cos(rot) - y * Math.sin(rot),
    x * Math.sin(rot) + y * Math.cos(rot)));
  const out = orthogonalizeRing(ring);
  assert.ok(out);
  const p = toLocal(out);
  const bearing = Math.atan2(p[1][1] - p[0][1], p[1][0] - p[0][0]) * 180 / Math.PI;
  assert.ok(Math.abs(((bearing % 90) + 90) % 90 - 30) < 3,
    `orientation drifted to ${bearing.toFixed(1)}°, expected ~30°`);
});

t('a genuine 20° shear is refused rather than forced square', () => {
  // All four corners are 70/110°, outside the 13° gate. iD leaves these alone
  // too: turning a bay window or a chamfer into a right angle is not a fix.
  const ring = [at(0, 0), at(20, 0), at(23.4, 10), at(3.4, 10)];
  assert.equal(orthogonalizeRing(ring), null);
});

console.log('\northogonalize: ' + pass + ' groups passed');
