// Tests building snapping to existing OSM nodes/walls, queued-to-queued shared
// edges, live OSM XML parsing, and topology-preserving <osmChange> generation
// (positive node reuse + <modify><way> wall splitting).
import assert from 'node:assert/strict';
import { readApp } from '../src/app/source.mjs';

const src = readApp();

// Slice pure snap helpers out of src/app/snap.js
const snapFrom = src.indexOf('const SNAP_NODE_TOL_M =');
const snapTo = src.indexOf('// ---- App integration');
assert.ok(snapFrom > 0 && snapTo > snapFrom, 'could not locate snap helpers in app sources');

// Slice osmChange out of src/app/action.js
const ocFrom = src.indexOf('function osmChange(');
const ocTo = src.indexOf('const OSM = ');
assert.ok(ocFrom > 0 && ocTo > ocFrom, 'could not locate osmChange in app sources');

const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, '&');
const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const metresBetween = (a, b) => {
  const mLat = 111320, mLon = 111320 * Math.cos(a[0] * Math.PI / 180);
  return Math.hypot((b[0] - a[0]) * mLat, (b[1] - a[1]) * mLon);
};

const M = new Function('metresBetween', 'unesc', 'esc', 'S',
  src.slice(snapFrom, snapTo) + '\n' + src.slice(ocFrom, ocTo) +
  '; return { projectOnSeg, snapPointToTargets, snapRingToTargets, computeAutoSnaps, parseLiveOsmXml, osmChange };'
)(metresBetween, unesc, esc, { dropKeys: [] });

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

// Local metre offset helper near Warsaw (52.2 N, 21.0 E)
const LAT0 = 52.2, LON0 = 21.0;
const mLat = 111320;
const mLon = 111320 * Math.cos(LAT0 * Math.PI / 180);
const ptM = (x, y) => [LAT0 + y / mLat, LON0 + x / mLon];

// Existing 10m x 10m OSM building: (0,0)-(10,0)-(10,10)-(0,10)
const EXISTING_WAY = {
  source: 'osm',
  wayId: 5001,
  ring: [ptM(0, 0), ptM(10, 0), ptM(10, 10), ptM(0, 10)],
  nodeIds: [101, 102, 103, 104],
};

t('snapPointToTargets prefers an existing corner node over a wall segment', () => {
  // 0.4 m away from corner (10, 10)
  const hit = M.snapPointToTargets(ptM(10.3, 10.25), [EXISTING_WAY]);
  assert.ok(hit);
  assert.equal(hit.kind, 'node');
  assert.equal(hit.nodeId, 103);
  assert.ok(metresBetween(hit.pt, ptM(10, 10)) < 1e-6);
});

t('snapPointToTargets projects onto a wall segment and records way/endpoint ids', () => {
  // 0.5 m east of the midpoint of the east wall (10,0)->(10,10)
  const hit = M.snapPointToTargets(ptM(10.5, 5.0), [EXISTING_WAY]);
  assert.ok(hit);
  assert.equal(hit.kind, 'edge');
  assert.equal(hit.wayId, 5001);
  assert.equal(hit.aNodeId, 102);
  assert.equal(hit.bNodeId, 103);
  assert.ok(Math.abs(hit.t - 0.5) < 0.01);
  assert.ok(metresBetween(hit.pt, ptM(10, 5)) < 0.01);
});

t('snapPointToTargets upgrades near-endpoint wall snaps to the corner node', () => {
  // 0.2 m north of corner (10, 0), 0.5 m east — should snap to corner 102, not create a 20 cm stub
  const hit = M.snapPointToTargets(ptM(10.5, 0.2), [EXISTING_WAY]);
  assert.ok(hit);
  assert.equal(hit.kind, 'node');
  assert.equal(hit.nodeId, 102);
});

t('snapRingToTargets snaps a semi-detached building onto shared corners', () => {
  // Adjacent house shifted 0.3 m east of the shared wall (10,0)-(10,10)
  const cand = [ptM(10.3, 0.1), ptM(20, 0), ptM(20, 10), ptM(10.3, 9.9)];
  const res = M.snapRingToTargets(cand, [EXISTING_WAY]);
  assert.ok(res);
  assert.equal(res.stats.nodes, 2);
  assert.equal(res.snaps[0].nodeId, 102);
  assert.equal(res.snaps[3].nodeId, 103);
  assert.equal(res.snaps[1], null);
  assert.equal(res.snaps[2], null);
});

t('snapRingToTargets snaps a smaller garage onto the middle of an existing wall', () => {
  // 4m wide garage attached to east wall at y=3..7, shifted 0.4m east
  const garage = [ptM(10.4, 3), ptM(15, 3), ptM(15, 7), ptM(10.4, 7)];
  const res = M.snapRingToTargets(garage, [EXISTING_WAY]);
  assert.ok(res);
  assert.equal(res.stats.edges, 2);
  assert.equal(res.snaps[0].kind, 'edge');
  assert.equal(res.snaps[0].wayId, 5001);
  assert.equal(res.snaps[3].kind, 'edge');
  assert.ok(metresBetween(res.ring[0], ptM(10, 3)) < 0.01);
  assert.ok(metresBetween(res.ring[3], ptM(10, 7)) < 0.01);
});

t('snapRingToTargets handles reverse T-junctions by inserting existing corners onto candidate wall', () => {
  // Large new building along east wall from y=-5 to y=15: existing corners (10,0) and (10,10) sit on its west wall
  const big = [ptM(10.2, -5), ptM(20, -5), ptM(20, 15), ptM(10.2, 15)];
  const res = M.snapRingToTargets(big, [EXISTING_WAY]);
  assert.ok(res);
  assert.equal(res.stats.inserted, 2, 'both existing corners 102 and 103 must be inserted into the candidate wall');
  const sharedIds = res.snaps.filter(Boolean).map((s) => s.nodeId).sort((a, b) => a - b);
  assert.deepEqual(sharedIds, [102, 103]);
  assert.equal(res.ring.length, 6);
});

t('computeAutoSnaps glues MVT-quantisation gaps (<=35 cm) but leaves detached alleys (80 cm) alone', () => {
  const touching = [ptM(10.25, 0.1), ptM(18, 0), ptM(18, 10), ptM(10.25, 9.9)];
  assert.ok(M.computeAutoSnaps(touching, [EXISTING_WAY]), '25 cm gap should auto-glue');
  const detached = [ptM(10.8, 0), ptM(18, 0), ptM(18, 10), ptM(10.8, 10)];
  assert.equal(M.computeAutoSnaps(detached, [EXISTING_WAY]), null, '80 cm alley must not be glued');
});

t('parseLiveOsmXml parses nodes and ways, skips deleted elements, and unescapes entities', () => {
  const xml = `<osm version="0.6">
    <node id="101" visible="true" lat="52.2" lon="21.0"/>
    <node id="999" visible="false" lat="52.2" lon="21.0"/>
    <way id="5001" visible="true" version="4">
      <nd ref="101"/><nd ref="102"/><nd ref="103"/><nd ref="104"/><nd ref="101"/>
      <tag k="building" v="house"/>
      <tag k="addr:street" v="Kr&#243;tka &amp; Nowa"/>
    </way>
  </osm>`;
  const live = M.parseLiveOsmXml(xml);
  assert.equal(live.nodes.has(101), true);
  assert.equal(live.nodes.has(999), false, 'deleted nodes must be ignored');
  const w = live.ways.get(5001);
  assert.ok(w);
  assert.equal(w.version, 4);
  assert.deepEqual(w.nds, [101, 102, 103, 104, 101]);
  assert.deepEqual(w.tags, [['building', 'house'], ['addr:street', 'Krótka & Nowa']]);
});

t('osmChange reuses existing positive OSM node ids with zero duplicate <node> elements', () => {
  const cand = [ptM(10.2, 0.1), ptM(20, 0), ptM(20, 10), ptM(10.2, 9.9)];
  const res = M.snapRingToTargets(cand, [EXISTING_WAY]);
  const live = {
    nodes: new Map([[102, { lat: ptM(10, 0)[0], lon: ptM(10, 0)[1] }],
                    [103, { lat: ptM(10, 10)[0], lon: ptM(10, 10)[1] }]]),
    ways: new Map(),
  };
  const xml = M.osmChange([{ kind: 'building', ring: res.ring, snaps: res.snaps, tags: { building: 'house' } }], 42, live);
  assert.equal(xml.match(/<node /g).length, 2, 'only the 2 new outer corners should be created');
  assert.match(xml, /<nd ref="102"\/>/);
  assert.match(xml, /<nd ref="103"\/>/);
  assert.ok(!/<modify>/.test(xml), 'corner-only snap needs no <modify>');
});

t('osmChange falls back to creating a new node if a snapped OSM node was deleted', () => {
  const cand = [ptM(10.2, 0.1), ptM(20, 0), ptM(20, 10), ptM(10.2, 9.9)];
  const res = M.snapRingToTargets(cand, [EXISTING_WAY]);
  // Node 102 was deleted in OSM (absent from live.nodes); only 103 still exists
  const live = {
    nodes: new Map([[103, { lat: ptM(10, 10)[0], lon: ptM(10, 10)[1] }]]),
    ways: new Map(),
  };
  const xml = M.osmChange([{ kind: 'building', ring: res.ring, snaps: res.snaps, tags: { building: 'house' } }], 42, live);
  assert.equal(xml.match(/<node /g).length, 3, 'deleted node 102 must fall back to a fresh created node');
  assert.ok(!/<nd ref="102"\/>/.test(xml));
  assert.match(xml, /<nd ref="103"\/>/);
});

t('osmChange emits <modify><way> inserting wall-snapped nodes in exact geometric order', () => {
  const garage = [ptM(10.3, 3), ptM(15, 3), ptM(15, 7), ptM(10.3, 7)];
  const res = M.snapRingToTargets(garage, [EXISTING_WAY]);
  // Test reverse orientation on the live way (103 -> 102) to verify order handling!
  const live = {
    nodes: new Map(),
    ways: new Map([[5001, {
      id: 5001,
      version: 7,
      nds: [101, 104, 103, 102, 101],
      tags: [['building', 'house'], ['addr:street', 'Krótka & Nowa']],
    }]]),
  };
  const xml = M.osmChange([{ kind: 'building', ring: res.ring, snaps: res.snaps, tags: { building: 'garage' } }], 99, live);
  assert.ok(xml.indexOf('<create>') < xml.indexOf('<modify>'), '<create> must precede <modify>');
  const modM = /<modify>([\s\S]*?)<\/modify>/.exec(xml);
  assert.ok(modM, 'must emit <modify> for the split wall');
  assert.match(modM[1], /<way id="5001" version="7" changeset="99">/);
  assert.match(modM[1], /<tag k="addr:street" v="Krótka &amp; Nowa"\/>/, 'existing way tags must survive escaped');
  // In reversed segment 103 (y=10) -> 102 (y=0), the node at y=7 must appear BEFORE the node at y=3
  const modNds = [...modM[1].matchAll(/<nd ref="(-?\d+)"\/>/g)].map((m) => Number(m[1]));
  assert.equal(modNds.length, 7, '5 original nds + 2 inserted nodes');
  assert.equal(modNds[2], 103);
  assert.equal(modNds[5], 102);
  // Extract latitudes of the two inserted negative nodes from <create>
  const nodeLat = new Map([...xml.matchAll(/<node id="(-\d+)" lat="([-\d.]+)"/g)].map((m) => [Number(m[1]), parseFloat(m[2])]));
  assert.ok(nodeLat.get(modNds[3]) > nodeLat.get(modNds[4]),
    'along 103 (north) -> 102 (south), northmost snapped node must come first');
});

t('osmChange splits a queued building wall when another queued building snaps onto it', () => {
  // Building A: (0,0)-(10,0)-(10,10)-(0,10). Building B: attached to A's east wall at y=3..7
  const a = [ptM(0, 0), ptM(10, 0), ptM(10, 10), ptM(0, 10)];
  const b = [ptM(10, 3), ptM(15, 3), ptM(15, 7), ptM(10, 7)];
  const xml = M.osmChange([
    { kind: 'building', ring: a, tags: { building: 'house' } },
    { kind: 'building', ring: b, tags: { building: 'garage' } },
  ], 12);
  // 4 corners of A + 4 corners of B = 8 unique coordinates, and A's way must reference all 6 nodes on its perimeter
  assert.equal(xml.match(/<node /g).length, 8);
  const ways = [...xml.matchAll(/<way[^>]*>([\s\S]*?)<\/way>/g)];
  assert.equal(ways.length, 2);
  const aNds = [...ways[0][1].matchAll(/<nd ref="(-?\d+)"\/>/g)].map((m) => Number(m[1]));
  const bNds = [...ways[1][1].matchAll(/<nd ref="(-?\d+)"\/>/g)].map((m) => Number(m[1]));
  assert.equal(aNds.length, 7, 'building A must have the 2 shared garage nodes inserted into its east wall (6+1 closing)');
  const shared = bNds.filter((id) => aNds.includes(id));
  assert.ok(new Set(shared).size === 2, 'building A and B must share the 2 wall-junction nodes');
});

console.log('\nsnap: ' + pass + ' groups passed');
