// Land-cover review depends on two things the app previously got wrong, both of
// which fail silently and produce bad uploads rather than errors:
//
//  1. `type=multipolygon` relations. The vibe-osm-importer emits a hole — a
//     forest island inside farmland — as a relation with outer/inner members.
//     The parser read only nodes and ways, so the farmland arrived solid and
//     accepting it would have uploaded farmland straight over the forest. The
//     importer's own notes call this out as gotcha #1.
//  2. Shared nodes. That writer deduplicates nodes by rounded coordinate, so
//     adjacent parcels share boundary nodes. Emitting fresh nodes per candidate
//     on upload throws that away, leaving duplicate coincident nodes and the
//     gap-versus-overlap problem the pipeline exists to avoid.
//
// Both are exercised here against a fixture written in that writer's format.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const xml = readFileSync(new URL('./fixtures/landuse-multipolygon.osm', import.meta.url), 'utf8');

// --- the wasm scanner half, plus the JS relation pass -----------------------
const bytes = readFileSync(new URL('../core.wasm', import.meta.url));
const { exports: w } = await WebAssembly.instantiate(await WebAssembly.compile(bytes), {
  env: {
    abort: (m, f, l, c) => { throw new Error(`abort ${l}:${c}`); },
    seed: () => 42,
    'Math.cos': Math.cos, 'Math.sqrt': Math.sqrt, 'Math.floor': Math.floor,
    'Math.ceil': Math.ceil, 'Math.round': Math.round, 'Math.abs': Math.abs,
    'Math.max': Math.max,
  },
});

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

// Way ids are taken from the source in document order, which the parser asserts
// matches the scanner's way count. Verify that assumption directly, because the
// relation resolution is built on it.
t('way ids in document order line up with the scanner\'s way count', () => {
  const enc = new TextEncoder().encode(xml);
  const p = w.alloc(enc.length);
  new Uint8Array(w.memory.buffer, p, enc.length).set(enc);
  w.setSource(p, enc.length);
  w.parse();
  const ids = [...xml.matchAll(/<way\s+id="(-?\d+)"/g)].map((m) => Number(m[1]));
  assert.equal(ids.length, w.wayCount(), 'a mismatch here makes relations unresolvable');
  assert.equal(w.wayCount(), 5);
  assert.equal(w.nodeCount(), 14, 'the writer deduplicates nodes by coordinate');
});

// --- the pure pieces of the parser, sliced out ------------------------------
const areaFrom = src.indexOf('const AREA_KEYS =');
const areaTo = src.indexOf('const TAG_RE =');
assert.ok(areaFrom > 0 && areaTo > areaFrom, 'could not locate areaKind in src/app.js');
const { areaKind, AREA_KEYS } = new Function(src.slice(areaFrom, areaTo) +
  '; return { areaKind, AREA_KEYS };')();

t('land cover is classified as area, buildings stay buildings', () => {
  assert.equal(areaKind({ landuse: 'farmland' }), 'area');
  assert.equal(areaKind({ landuse: 'forest' }), 'area');
  assert.equal(areaKind({ natural: 'wood' }), 'area');
  assert.equal(areaKind({ natural: 'scrub' }), 'area');
  assert.equal(areaKind({ landuse: 'orchard' }), 'area');
  assert.equal(areaKind({ building: 'yes' }), 'building');
  // A building tag wins: a barn inside a farmland parcel is still a building.
  assert.equal(areaKind({ building: 'yes', landuse: 'farmyard' }), 'building');
  assert.ok(AREA_KEYS.includes('landuse') && AREA_KEYS.includes('natural'));
});

// --- osmChange: shared nodes and multipolygon emission ---------------------
const ocFrom = src.indexOf('function osmChange(');
const ocTo = src.indexOf('const OSM = ');
assert.ok(ocFrom > 0 && ocTo > ocFrom, 'could not locate osmChange in src/app.js');
const { osmChange } = new Function('S', 'esc',
  src.slice(ocFrom, ocTo) + '; return { osmChange };')(
  { dropKeys: [] },
  (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;'));

const SQ = (lat, lon, d) => [[lat, lon], [lat, lon + d], [lat + d, lon + d], [lat + d, lon]];

t('a hole becomes a type=multipolygon with untagged rings', () => {
  const outer = SQ(52.20, 20.99, 0.004);
  const hole = SQ(52.201, 20.992, 0.001);
  const x = osmChange([{ kind: 'area', ring: outer, holes: [hole], tags: { landuse: 'farmland' } }], 7);
  assert.match(x, /<relation id="-\d+"/, 'a hole requires a relation');
  assert.match(x, /<tag k="type" v="multipolygon"\/>/);
  assert.match(x, /role="outer"/);
  assert.match(x, /role="inner"/);
  assert.equal(x.match(/<way /g).length, 2, 'one way for the outer ring and one per hole');
  // The tags must be on the relation only. On the outer way they would fill the
  // hole in, which is precisely the regression this guards.
  const outerWay = /<way id="(-\d+)"[^>]*>([\s\S]*?)<\/way>/.exec(x);
  assert.ok(!/landuse/.test(outerWay[2]), 'rings of a multipolygon must stay untagged');
  assert.match(x, /<relation[\s\S]*landuse" v="farmland"[\s\S]*<\/relation>/);
});

t('an area without holes is a plain tagged way, not a relation', () => {
  const x = osmChange([{ kind: 'area', ring: SQ(52.20, 20.99, 0.002), tags: { landuse: 'meadow' } }], 7);
  assert.ok(!/<relation/.test(x), 'no relation for a simple area');
  assert.match(x, /<way[\s\S]*landuse" v="meadow"/);
});

t('adjacent parcels share the nodes on their common edge', () => {
  // Two squares meeting exactly along lon 20.9960, as the importer writes them.
  const a = [[52.2000, 20.9900], [52.2000, 20.9960], [52.2040, 20.9960], [52.2040, 20.9900]];
  const b = [[52.2000, 20.9960], [52.2000, 21.0000], [52.2040, 21.0000], [52.2040, 20.9960]];
  const x = osmChange([
    { kind: 'area', ring: a, tags: { landuse: 'farmland' } },
    { kind: 'area', ring: b, tags: { landuse: 'meadow' } },
  ], 7);
  const nodes = x.match(/<node /g).length;
  assert.equal(nodes, 6, 'eight corners, two of them shared, so six nodes — got ' + nodes);
  // And no coordinate appears twice.
  const coords = [...x.matchAll(/<node[^>]*lat="([^"]+)" lon="([^"]+)"/g)].map((m) => m[1] + ',' + m[2]);
  assert.equal(new Set(coords).size, coords.length, 'a coordinate must not get two nodes');
});

t('a building and an area in one changeset still share a touching corner', () => {
  const ring = SQ(52.20, 20.99, 0.002);
  const x = osmChange([
    { kind: 'area', ring, tags: { landuse: 'farmland' } },
    { kind: 'building', ring, tags: { building: 'yes' } },
  ], 7);
  assert.equal(x.match(/<node /g).length, 4, 'identical rings must reuse the same four nodes');
  assert.equal(x.match(/<way /g).length, 2);
});

t('addresses are still nodes and are unaffected', () => {
  const x = osmChange([{ kind: 'address', ring: [[52.2, 21.0]], tags: { 'addr:housenumber': '7' } }], 7);
  assert.match(x, /<node[^>]*>\s*<tag k="addr:housenumber" v="7"\/><\/node>/);
  assert.ok(!/<way/.test(x) && !/<relation/.test(x));
});

t('an empty or degenerate hole is ignored rather than emitted', () => {
  const x = osmChange([{
    kind: 'area', ring: SQ(52.20, 20.99, 0.002),
    holes: [[], [[52.2, 20.99]], null], tags: { landuse: 'farmland' },
  }], 7);
  assert.ok(!/<relation/.test(x), 'holes with under three points are not holes');
  assert.match(x, /<way[\s\S]*landuse/);
});

console.log('\nlanduse: ' + pass + ' groups passed');
