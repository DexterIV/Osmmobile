// Runs the wasm .osm scanner over a real /josm_data response captured from
// budynki.openstreetmap.org.pl, rather than the hand-written XML in
// wasm.test.mjs. The scanner had only ever been exercised against synthetic
// input, and the download/paste route makes this exact payload the primary way
// candidates enter the app now that the server's CORS headers block fetching.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

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

const xml = readFileSync(new URL('./fixtures/josm_data.osm', import.meta.url), 'utf8');
const enc = new TextEncoder().encode(xml);
const p = w.alloc(enc.length);
new Uint8Array(w.memory.buffer, p, enc.length).set(enc);
w.setSource(p, enc.length);
w.parse();

const mem = () => w.memory.buffer;
const nc = w.nodeCount(), wc = w.wayCount();
console.log('real josm_data: nodes', nc, 'ways', wc, 'refs', w.refsCount());

// Counted independently from the fixture text with a regex.
assert.equal(nc, 56, 'node count must match the fixture');
assert.equal(wc, 2, 'way count must match the fixture');
assert.equal(w.refsCount(), 58, 'nd ref count must match the fixture');

const lat = new Float64Array(mem(), w.ptrNodeLat(), nc);
const lon = new Float64Array(mem(), w.ptrNodeLon(), nc);
const nid = new Float64Array(mem(), w.ptrNodeId(), nc);

// Every coordinate must land inside the bbox the fixture was requested for,
// which catches a scanner that mis-associates lat and lon or drops a digit.
for (let i = 0; i < nc; i++) {
  assert.ok(lat[i] > 52.19 && lat[i] < 52.24, `node ${i} lat out of bbox: ${lat[i]}`);
  assert.ok(lon[i] > 20.99 && lon[i] < 21.04, `node ${i} lon out of bbox: ${lon[i]}`);
  assert.ok(nid[i] < 0, `expected a negative placeholder id, got ${nid[i]}`);
}
console.log('  ok  all 56 coordinates inside the requested bbox');

// Both ways must resolve to closed rings of at least four refs.
const wA = new Int32Array(mem(), w.ptrWayNdA(), wc);
const wN = new Int32Array(mem(), w.ptrWayNdN(), wc);
const refs = new Float64Array(mem(), w.ptrRefs(), w.refsCount());
const byId = new Map();
for (let i = 0; i < nc; i++) byId.set(nid[i], i);

for (let i = 0; i < wc; i++) {
  assert.ok(wN[i] >= 4, `way ${i} has only ${wN[i]} refs`);
  const r = Array.from(refs.slice(wA[i], wA[i] + wN[i]));
  for (const id of r) assert.ok(byId.has(id), `way ${i} references unknown node ${id}`);
  assert.equal(r[0], r[r.length - 1], `way ${i} is not closed`);
}
console.log('  ok  both ways closed and fully resolvable');

// Both ways are tagged building, per the fixture.
const tA = new Int32Array(mem(), w.ptrWayTagA(), wc);
const tB = new Int32Array(mem(), w.ptrWayTagB(), wc);
const kb = new TextEncoder().encode('building');
const kp = w.alloc(kb.length);
new Uint8Array(mem(), kp, kb.length).set(kb);
for (let i = 0; i < wc; i++) {
  assert.ok(w.spanHasKey(tA[i], tB[i], kp, kb.length), `way ${i} lacks a building tag`);
}
console.log('  ok  both ways carry a building tag');

// Guard the regression the project has recorded from the start: a numeric
// character reference must decode before being re-escaped, or Polish street
// names upload mangled. The live fixture happens to contain none, so this
// asserts on a constructed case rather than pretending the fixture covers it.
const withRef = xml.replace('</osm>',
  '<node id="-9001" lat="52.21" lon="21.01"><tag k="addr:street" v="Kr&#243;tka"/></node></osm>');
const e2 = new TextEncoder().encode(withRef);
const p2 = w.alloc(e2.length);
new Uint8Array(mem(), p2, e2.length).set(e2);
w.setSource(p2, e2.length);
w.parse();
const nc2 = w.nodeCount();
assert.equal(nc2, nc + 1, 'the injected node should parse');
const nTA = new Int32Array(mem(), w.ptrNodeTagA(), nc2);
const nTB = new Int32Array(mem(), w.ptrNodeTagB(), nc2);
const span = withRef.slice(nTA[nc2 - 1], nTB[nc2 - 1]);
assert.match(span, /Kr&#243;tka/, 'the raw span should still hold the undecoded entity');
console.log('  ok  numeric character reference survives into the tag span for decoding');

console.log('\nparse: real upstream payload parses correctly');

// --- the OSM API /map response the context layer relies on ------------------
// Different shape from josm_data: positive ids, ~283 KB, and a mix of everything
// in the box rather than only import candidates. ctxFromOsmXml resolves building
// ways against it, so the scanner has to cope with the real thing.
const mapXml = readFileSync(new URL('./fixtures/osm-map-cell.xml', import.meta.url), 'utf8');
const me = new TextEncoder().encode(mapXml);
const mp = w.alloc(me.length);
new Uint8Array(mem(), mp, me.length).set(me);
w.setSource(mp, me.length);
w.parse();

const mnc = w.nodeCount(), mwc = w.wayCount();
console.log('osm /map cell: nodes', mnc, 'ways', mwc, 'refs', w.refsCount());
assert.ok(mnc > 1000, 'expected 1100+ nodes, got ' + mnc);
assert.ok(mwc > 100, 'expected 100+ ways, got ' + mwc);

const mid = new Float64Array(mem(), w.ptrNodeId(), mnc);
const mlat = new Float64Array(mem(), w.ptrNodeLat(), mnc);
const mlon = new Float64Array(mem(), w.ptrNodeLon(), mnc);
// /map returns every node of any way that touches the bbox, so geometry
// legitimately spills outside it — that is why footprints straddling a cell
// edge arrive whole. The bound here is therefore generous on purpose; it is
// checking the scanner did not garble coordinates, not that the server clipped.
for (let i = 0; i < mnc; i++) {
  assert.ok(mid[i] > 0, 'real OSM ids are positive, got ' + mid[i]);
  assert.ok(mlat[i] > 52.15 && mlat[i] < 52.25, 'lat implausible: ' + mlat[i]);
  assert.ok(mlon[i] > 20.94 && mlon[i] < 21.05, 'lon implausible: ' + mlon[i]);
}
console.log('  ok  every node has a positive id and a plausible coordinate');

// Building ways must resolve fully against the node table, which is exactly what
// ctxFromOsmXml needs in order to draw a footprint at all.
const mwA = new Int32Array(mem(), w.ptrWayNdA(), mwc);
const mwN = new Int32Array(mem(), w.ptrWayNdN(), mwc);
const mwtA = new Int32Array(mem(), w.ptrWayTagA(), mwc);
const mwtB = new Int32Array(mem(), w.ptrWayTagB(), mwc);
const mrefs = new Float64Array(mem(), w.ptrRefs(), w.refsCount());
const bkey = new TextEncoder().encode('building');
const bp = w.alloc(bkey.length);
new Uint8Array(mem(), bp, bkey.length).set(bkey);
const mById = new Map();
for (let i = 0; i < mnc; i++) mById.set(mid[i], i);

let buildings = 0, resolvable = 0, closed = 0;
for (let i = 0; i < mwc; i++) {
  if (!w.spanHasKey(mwtA[i], mwtB[i], bp, bkey.length)) continue;
  buildings++;
  const r = Array.from(mrefs.slice(mwA[i], mwA[i] + mwN[i]));
  if (r.every((id) => mById.has(id))) resolvable++;
  if (r.length > 2 && r[0] === r[r.length - 1]) closed++;
}
console.log('  building ways', buildings, 'resolvable', resolvable, 'closed', closed);
assert.ok(buildings >= 15, 'expected 15+ building ways, got ' + buildings);
assert.equal(resolvable, buildings, 'every building way must resolve, or footprints vanish');
assert.equal(closed, buildings, 'building ways should be closed rings');
console.log('  ok  all building ways resolve to closed rings');
