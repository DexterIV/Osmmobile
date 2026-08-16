import { readFileSync } from 'fs';

const bytes = readFileSync(new URL('../core.wasm', import.meta.url));
const mod = await WebAssembly.compile(bytes);
console.log('imports:', WebAssembly.Module.imports(mod));

const inst = await WebAssembly.instantiate(mod, {
  env: {
    abort: (m, f, l, c) => { throw new Error(`abort ${l}:${c}`); },
    seed: () => 42,
    'Math.cos': Math.cos,
    'Math.sqrt': Math.sqrt,
    'Math.floor': Math.floor,
    'Math.ceil': Math.ceil,
    'Math.round': Math.round,
    'Math.abs': Math.abs,
    'Math.max': Math.max,
  },
});
const w = inst.exports;

const xml = `<?xml version="1.0"?>
<osm version="0.6" generator="gugik2osm">
 <node id="-1" lat="52.100000" lon="21.200000"/>
 <node id="-2" lat="52.100100" lon="21.200000"/>
 <node id="-3" lat="52.100100" lon="21.200200"/>
 <node id="-4" lat="52.100000" lon="21.200200"/>
 <node id="-9" lat="52.105000" lon="21.205000">
  <tag k="addr:housenumber" v="14A"/>
  <tag k="addr:street" v="Kwiatowa"/>
  <tag k="addr:city" v="Wolka"/>
 </node>
 <way id="-10">
  <nd ref="-1"/><nd ref="-2"/><nd ref="-3"/><nd ref="-4"/><nd ref="-1"/>
  <tag k="building" v="house"/>
  <tag k="source" v="BDOT10k"/>
 </way>
</osm>`;

const enc = new TextEncoder().encode(xml);
const p = w.alloc(enc.length);
new Uint8Array(w.memory.buffer, p, enc.length).set(enc);
w.setSource(p, enc.length);
w.parse();

console.log('nodes', w.nodeCount(), 'ways', w.wayCount(), 'refs', w.refsCount());

const mem = () => w.memory.buffer;
const lat = new Float64Array(mem(), w.ptrNodeLat(), w.nodeCount());
const lon = new Float64Array(mem(), w.ptrNodeLon(), w.nodeCount());
const nid = new Float64Array(mem(), w.ptrNodeId(), w.nodeCount());
console.log('node0', nid[0], lat[0], lon[0]);
console.log('node4', nid[4], lat[4], lon[4]);

const wA = new Int32Array(mem(), w.ptrWayNdA(), w.wayCount());
const wN = new Int32Array(mem(), w.ptrWayNdN(), w.wayCount());
const refs = new Float64Array(mem(), w.ptrRefs(), w.refsCount());
console.log('way0 ndStart', wA[0], 'ndCount', wN[0], 'refs', Array.from(refs.slice(wA[0], wA[0] + wN[0])));

const tA = new Int32Array(mem(), w.ptrWayTagA(), w.wayCount());
const tB = new Int32Array(mem(), w.ptrWayTagB(), w.wayCount());
const key = new TextEncoder().encode('building');
const kp = w.alloc(key.length);
new Uint8Array(mem(), kp, key.length).set(key);
console.log('way0 has building?', w.spanHasKey(tA[0], tB[0], kp, key.length));

const nTA = new Int32Array(mem(), w.ptrNodeTagA(), w.nodeCount());
const nTB = new Int32Array(mem(), w.ptrNodeTagB(), w.nodeCount());
const hk = new TextEncoder().encode('addr:housenumber');
const hp = w.alloc(hk.length);
new Uint8Array(mem(), hp, hk.length).set(hk);
console.log('node4 tag span', nTA[4], nTB[4], 'has housenumber?', w.spanHasKey(nTA[4], nTB[4], hp, hk.length));
console.log('node0 has housenumber?', w.spanHasKey(nTA[0], nTB[0], hp, hk.length));
console.log('raw span:', xml.slice(nTA[4], nTB[4]).replace(/\s+/g, ' ').trim());

const n = 3;
const lp = w.alloc(n * 8), gp = w.alloc(n * 8);
new Float64Array(mem(), lp, n).set([52.1, 52.2, 52.3]);
new Float64Array(mem(), gp, n).set([21.2, 21.3, 21.4]);
w.indexBuild(lp, gp, n, 0.002);
console.log('nearest to 52.1001/21.2001 =', w.nearestMeters(52.1001, 21.2001, 200).toFixed(1), 'm');
console.log('nearest to 52.9/21.9 =', w.nearestMeters(52.9, 21.9, 200).toFixed(1), 'm');

const W = 128, H = 128;
const rgba = w.alloc(W * H * 4);
const img = new Uint8Array(mem(), rgba, W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const inside = x >= 43 && x < 83 && y >= 33 && y < 73;
    const v = inside ? 40 : 200;
    const o = (y * W + x) * 4;
    img[o] = img[o + 1] = img[o + 2] = v;
    img[o + 3] = 255;
  }
}
w.gradientFrom(rgba, W, H);

const ring = w.alloc(4 * 2 * 8);
new Float64Array(mem(), ring, 8).set([40, 30, 80, 30, 80, 70, 40, 70]);
const ns = w.edgeSamples(ring, 4, 1.0);
w.alignOffset(8, 1.0);
console.log('edge samples', ns, '-> suggested offset', w.outFA(), w.outFB(), 'z*100', w.outIA(), 'gain%', w.outIB());
w.ringCentroid(ring, 4);
console.log('centroid', w.outFA(), w.outFB());

const t0 = performance.now();
for (let i = 0; i < 200; i++) w.alignOffset(8, 1.0);
console.log('alignOffset x200:', (performance.now() - t0).toFixed(1), 'ms total');
