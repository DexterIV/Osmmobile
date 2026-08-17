// Checks the "what is already in OSM here" logic: turning an Overpass response
// into drawable context, and deciding whether a candidate duplicates something
// already mapped. This is the judgement the reviewer leans on — a false "clear"
// on a building that is already in OSM is how a duplicate gets uploaded — so it
// is tested against a real captured Overpass cell as well as synthetic shapes.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const from = src.indexOf('function pointInRing(');
const to = src.indexOf('function drawContext(');
assert.ok(from > 0 && to > from, 'could not locate the context helpers in src/app.js');

const make = new Function('Math',
  'function metresBetween(a,b){var mLat=111320,mLon=111320*Math.cos(a[0]*Math.PI/180);' +
  'return Math.hypot((b[0]-a[0])*mLat,(b[1]-a[1])*mLon);}' +
  src.slice(from, to) +
  '; return { pointInRing, ringCentroidSimple, overlapVerdict, duplicateAddress, metresBetween };');
const C = make(Math);

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

// A 20 m-ish square near Warsaw, and shapes placed relative to it.
const sq = (lat, lon, d) => [[lat, lon], [lat + d, lon], [lat + d, lon + d], [lat, lon + d]];
const HOME = sq(52.2000, 20.9920, 0.0002);

t('pointInRing is true inside and false outside', () => {
  assert.equal(C.pointInRing([52.2001, 20.9921], HOME), true);
  assert.equal(C.pointInRing([52.2010, 20.9921], HOME), false);
  assert.equal(C.pointInRing([52.2001, 20.9950], HOME), false);
});

t('a candidate sitting on top of an OSM building is an overlap', () => {
  const cand = { kind: 'building', ring: sq(52.20005, 20.99205, 0.0002), centroid: [52.20015, 20.99215] };
  const v = C.overlapVerdict(cand, { ways: [{ ring: HOME, hn: '' }], addrs: [] });
  assert.equal(v.tier, 2);
  assert.match(v.why, /OSM building/);
});

t('a candidate that swallows a small OSM building is an overlap', () => {
  const big = { kind: 'building', ring: sq(52.1998, 20.9918, 0.0008), centroid: [52.2002, 20.9922] };
  const v = C.overlapVerdict(big, { ways: [{ ring: HOME, hn: '' }], addrs: [] });
  assert.equal(v.tier, 2, 'containment the other way round must count too');
  assert.match(v.why, /contains/);
});

t('a candidate clear of everything is not flagged', () => {
  const far = { kind: 'building', ring: sq(52.2050, 20.9980, 0.0002), centroid: [52.2051, 20.9981] };
  const v = C.overlapVerdict(far, { ways: [{ ring: HOME, hn: '' }], addrs: [] });
  assert.equal(v.tier, null, 'must not invent an overlap');
});

t('an address point inside an OSM building is an overlap, naming the number', () => {
  const addr = { kind: 'address', ring: [[52.2001, 20.9921]], tags: { 'addr:housenumber': '7' } };
  const v = C.overlapVerdict(addr, { ways: [{ ring: HOME, hn: '12' }], addrs: [] });
  assert.equal(v.tier, 2);
  assert.match(v.why, /12/);
});

// --- duplicate addresses --------------------------------------------------
const cellWith = (addrs) => ({ ways: [], addrs });

t('the same house number within 30 m is reported as already mapped', () => {
  const addr = { kind: 'address', ring: [[52.2000, 20.9920]], tags: { 'addr:housenumber': '14A' } };
  const d = C.duplicateAddress(addr, cellWith([{ lat: 52.20005, lon: 20.99205, hn: '14A', street: '' }]));
  assert.match(d, /14A already in OSM/);
});

t('house-number matching ignores case', () => {
  const addr = { kind: 'address', ring: [[52.2000, 20.9920]], tags: { 'addr:housenumber': '14a' } };
  assert.ok(C.duplicateAddress(addr, cellWith([{ lat: 52.2000, lon: 20.9920, hn: '14A', street: '' }])));
});

t('the same number on a different street is not a duplicate', () => {
  const addr = {
    kind: 'address', ring: [[52.2000, 20.9920]],
    tags: { 'addr:housenumber': '5', 'addr:street': 'Kwiatowa' },
  };
  const d = C.duplicateAddress(addr,
    cellWith([{ lat: 52.20003, lon: 20.99203, hn: '5', street: 'Polna' }]));
  assert.equal(d, '', 'number 5 exists on both streets in most towns');
});

t('the same number far away is not a duplicate', () => {
  const addr = { kind: 'address', ring: [[52.2000, 20.9920]], tags: { 'addr:housenumber': '5' } };
  const d = C.duplicateAddress(addr, cellWith([{ lat: 52.2020, lon: 20.9920, hn: '5', street: '' }]));
  assert.equal(d, '', '~220 m away is a different building');
});

t('a building carrying the address counts as the address being mapped', () => {
  const addr = { kind: 'address', ring: [[52.2050, 20.9980]], tags: { 'addr:housenumber': '9' } };
  const d = C.duplicateAddress(addr, { ways: [{ ring: sq(52.2049, 20.9979, 0.0002), hn: '9' }], addrs: [] });
  assert.match(d, /9 already in OSM/);
});

t('a candidate with no house number is never called a duplicate', () => {
  const addr = { kind: 'address', ring: [[52.2000, 20.9920]], tags: {} };
  assert.equal(C.duplicateAddress(addr, cellWith([{ lat: 52.2000, lon: 20.9920, hn: '1', street: '' }])), '');
});

// --- against a real captured OSM API cell ---------------------------------
// Footprints are extracted here by an independent little parser rather than by
// app code, so this tests the verdicts against real building shapes without
// also depending on the wasm path that produces them (covered in parse.test.mjs).
const xml = readFileSync(new URL('./fixtures/osm-map-cell.xml', import.meta.url), 'utf8');

function realFootprints(text) {
  const nodes = new Map();
  const nodeRe = /<node id="(-?\d+)"[^>]*lat="([-\d.]+)"[^>]*lon="([-\d.]+)"/g;
  let m;
  while ((m = nodeRe.exec(text))) nodes.set(m[1], [parseFloat(m[2]), parseFloat(m[3])]);
  const out = [];
  const wayRe = /<way id="(-?\d+)"[\s\S]*?<\/way>/g;
  while ((m = wayRe.exec(text))) {
    const body = m[0];
    if (!/k="building"/.test(body)) continue;
    const ring = [];
    const ndRe = /<nd ref="(-?\d+)"/g;
    let n;
    while ((n = ndRe.exec(body))) {
      const p = nodes.get(n[1]);
      if (p) ring.push(p);
    }
    const hnM = /k="addr:housenumber" v="([^"]*)"/.exec(body);
    if (ring.length > 2) out.push({ ring, hn: hnM ? hnM[1] : '' });
  }
  return out;
}

const realCell = { ways: realFootprints(xml), addrs: [] };

t('the fixture yields real building footprints to test against', () => {
  assert.ok(realCell.ways.length >= 15, 'expected footprints, got ' + realCell.ways.length);
  for (const w of realCell.ways) {
    for (const [lat, lon] of w.ring) {
      assert.ok(lat > 52.19 && lat < 52.21, 'lat outside the cell: ' + lat);
      assert.ok(lon > 20.98 && lon < 21.00, 'lon outside the cell: ' + lon);
    }
  }
});

t('every real footprint recognises its own centroid as an overlap', () => {
  let checked = 0;
  for (const w of realCell.ways) {
    // Skip L- and O-shaped buildings, whose average point falls outside them.
    const mid = C.ringCentroidSimple(w.ring);
    if (!C.pointInRing(mid, w.ring)) continue;
    const cand = { kind: 'address', ring: [mid], tags: { 'addr:housenumber': '1' } };
    assert.equal(C.overlapVerdict(cand, realCell).tier, 2,
      'a point inside a mapped building must not read as clear');
    checked++;
  }
  assert.ok(checked >= 10, 'expected to check 10+ real buildings, did ' + checked);
});

t('a candidate duplicating a real footprint is caught', () => {
  const w = realCell.ways.find((x) => C.pointInRing(C.ringCentroidSimple(x.ring), x.ring));
  const cand = { kind: 'building', ring: w.ring.map(([a, b]) => [a, b]), centroid: C.ringCentroidSimple(w.ring) };
  assert.equal(C.overlapVerdict(cand, realCell).tier, 2, 'an exact copy must be flagged');
});

t('open ground between the real buildings stays clear', () => {
  let clear = 0;
  // Sample a grid over the cell and require that at least some points are clear;
  // a verdict function that always says "overlap" would be useless.
  for (let a = 0; a < 8; a++) {
    for (let b = 0; b < 8; b++) {
      const pt = [52.2000 + a * 0.00033, 20.9910 + b * 0.00055];
      const cand = { kind: 'address', ring: [pt], tags: { 'addr:housenumber': '1' } };
      if (C.overlapVerdict(cand, realCell).tier === null) clear++;
    }
  }
  assert.ok(clear > 20, 'only ' + clear + '/64 sample points read as clear — too eager');
});

console.log('\ncontext: ' + pass + ' groups passed');
