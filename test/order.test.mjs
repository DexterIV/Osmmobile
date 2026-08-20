// Exercises nearestChain from src/app.js. Sliced out like the retry helpers, and
// given a stub metresBetween, so what is under test is the chaining logic rather
// than the geodesy — the ordering must be right for any sane distance function.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const from = src.indexOf('function nearestChain(');
const to = src.indexOf('function orderCandidates(');
assert.ok(from > 0 && to > from, 'could not locate nearestChain in src/app.js');

// Equirectangular, which is plenty at the scale a review batch covers.
const stub = `const metresBetween = (a, b) => {
  const dy = (a[0] - b[0]) * 111320;
  const dx = (a[1] - b[1]) * 111320 * Math.cos(a[0] * Math.PI / 180);
  return Math.sqrt(dx * dx + dy * dy);
};`;
const { nearestChain } = new Function('Math',
  stub + src.slice(from, to) + '; return { nearestChain };')(Math);

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

const at = (lat, lon, id) => ({ centroid: [lat, lon], id });
const steps = (arr) => {
  const out = [];
  for (let i = 1; i < arr.length; i++) {
    const a = arr[i - 1].centroid, b = arr[i].centroid;
    const dy = (a[0] - b[0]) * 111320;
    const dx = (a[1] - b[1]) * 111320 * Math.cos(a[0] * Math.PI / 180);
    out.push(Math.sqrt(dx * dx + dy * dy));
  }
  return out;
};

t('every candidate appears exactly once', () => {
  const list = [];
  for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) list.push(at(52 + i * 0.0004, 21 + j * 0.0006, i + ':' + j));
  const out = nearestChain(list);
  assert.equal(out.length, list.length, 'no candidate may be dropped');
  assert.equal(new Set(out.map((c) => c.id)).size, list.length, 'and none duplicated');
});

t('a short list is returned unchanged rather than reordered pointlessly', () => {
  const a = at(52, 21, 'a'), b = at(53, 22, 'b');
  assert.deepEqual(nearestChain([a, b]).map((c) => c.id), ['a', 'b']);
  assert.deepEqual(nearestChain([]).map((c) => c.id), []);
});

t('an irregular field is walked in short steps, not swept by latitude', () => {
  // Jittered on purpose. On a PERFECTLY regular grid, sorting by latitude is
  // already a clean raster scan and scores the same as this — which is exactly
  // the trap that made the first version of this test assert nothing. Real
  // buildings are not on a grid, and once rows stop lining up, latitude order
  // puts neighbours in latitude arbitrarily far apart in longitude.
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const list = [];
  for (let i = 0; i < 12; i++) {
    for (let j = 0; j < 12; j++) {
      // Jitter of roughly a third of the pitch: rows still exist, as they do
      // along a street, but they no longer line up exactly. Jittering by a whole
      // pitch would make the field pure noise, where greedy backtracks a lot and
      // the test would measure the input rather than the code.
      list.push(at(52 + i * 0.00036 + (rnd() - 0.5) * 0.00012,
                   21 + j * 0.00055 + (rnd() - 0.5) * 0.00018, i + ':' + j));
    }
  }
  for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }

  const chained = steps(nearestChain(list)).sort((x, y) => x - y);
  const byLat = steps(list.slice().sort((a, b) => (a.centroid[0] - b.centroid[0]) || (a.centroid[1] - b.centroid[1])))
    .sort((x, y) => x - y);
  const p90 = (a) => a[Math.floor(a.length * 0.9)];
  assert.ok(p90(chained) * 2 < p90(byLat),
    `p90 step must at least halve: ${Math.round(p90(chained))} m vs ${Math.round(p90(byLat))} m`);
  // Asserted on the count, not the maximum. Greedy nearest-neighbour can corner
  // itself and need one long step back to a region it walked past — that is
  // inherent to being greedy, and one backtrack in a batch is not worth a 2-opt
  // pass to remove. What must hold is that long steps stay rare.
  // Relative, not absolute. An absolute threshold here would be a magic number
  // tuned to this synthetic field; what must hold for any field is that walking
  // to the nearest candidate makes long steps much rarer than sorting by latitude.
  const long = chained.filter((d) => d > 100).length;
  const longByLat = byLat.filter((d) => d > 100).length;
  assert.ok(long * 3 < longByLat,
    `steps over 100 m must be far rarer than in latitude order: ${long} vs ${longByLat}`);
});

t('a detached cluster costs exactly one long step, not one per member', () => {
  const list = [];
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) list.push(at(52 + i * 0.0004, 21 + j * 0.0006, 'g' + i + j));
  for (let k = 0; k < 8; k++) list.push(at(52.05 + k * 0.0004, 21.05, 'c' + k));
  const long = steps(nearestChain(list)).filter((d) => d > 1000).length;
  assert.equal(long, 1, `expected a single hop between the two groups, got ${long}`);
});

t('candidates sharing a position do not stall the walk', () => {
  const list = [at(52, 21, 'a'), at(52, 21, 'b'), at(52, 21, 'c'), at(52.001, 21.001, 'd')];
  const out = nearestChain(list);
  assert.equal(out.length, 4);
  assert.equal(new Set(out.map((c) => c.id)).size, 4);
});

console.log('\norder: ' + pass + ' groups passed');
