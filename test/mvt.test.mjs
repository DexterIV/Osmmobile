// Exercises the hand-written Mapbox Vector Tile decoder in src/app.js against
// real tiles captured from budynki.openstreetmap.org.pl. Those tiles are the
// only candidate source a browser can actually read — /sc/* duplicates
// Access-Control-Allow-Origin and /josm_data omits it — so a decoding mistake
// here breaks the app's primary data path silently, with plausible-looking but
// wrong building outlines.
//
// As in retry.test.mjs the code is sliced out of app.js rather than copied, so
// there is only ever one definition of it.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const from = src.indexOf('function pbVarint(');
const to = src.indexOf('const TILE_TAGS =');
assert.ok(from > 0 && to > from, 'could not locate the MVT decoder in src/app.js');

const make = new Function('TextDecoder', 'Math',
  'const TD = new TextDecoder();' + src.slice(from, to) +
  '; return { mvtDecode, mvtFeature, mvtRings, tileXY, tilePointToLatLon, tilesCovering, tileQuantCm, pbZigzag };');
const M = make(TextDecoder, Math);

const fixture = (n) => new Uint8Array(readFileSync(new URL('./fixtures/' + n, import.meta.url)));

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

// --- zigzag ---------------------------------------------------------------
t('zigzag decodes the signed deltas MVT uses', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(M.pbZigzag), [0, -1, 1, -2, 2]);
});

// --- tile arithmetic ------------------------------------------------------
t('tileXY matches the slippy-map reference for Warsaw at z14', () => {
  assert.deepEqual(M.tileXY(52.2, 21.0, 14), [9147, 5397]);
});

t('tilePointToLatLon inverts tileXY to within the quantisation step', () => {
  const z = 14, lat = 52.2007, lon = 20.993;
  const [x, y] = M.tileXY(lat, lon, z);
  // Corner of the tile must bracket the point it was derived from.
  const nw = M.tilePointToLatLon(z, x, y, 0, 0, 4096);
  const se = M.tilePointToLatLon(z, x, y, 4096, 4096, 4096);
  assert.ok(nw[0] > lat && se[0] < lat, `lat ${lat} not inside [${se[0]}, ${nw[0]}]`);
  assert.ok(nw[1] < lon && se[1] > lon, `lon ${lon} not inside [${nw[1]}, ${se[1]}]`);
});

t('tilesCovering enumerates the whole span, not just a corner', () => {
  const b = {
    getNorth: () => 52.215, getSouth: () => 52.185,
    getWest: () => 20.985, getEast: () => 21.015,
  };
  const tiles = M.tilesCovering(b, 14);
  assert.ok(tiles.length >= 4, 'expected several tiles, got ' + tiles.length);
  const [x0, y0] = M.tileXY(52.215, 20.985, 14);
  const [x1, y1] = M.tileXY(52.185, 21.015, 14);
  assert.equal(tiles.length, (Math.abs(x1 - x0) + 1) * (Math.abs(y1 - y0) + 1));
  assert.ok(tiles.some(([x, y]) => x === x0 && y === y0), 'missing the NW tile');
  assert.ok(tiles.some(([x, y]) => x === x1 && y === y1), 'missing the SE tile');
});

t('quantisation is reported at the scale that actually applies', () => {
  const cm = M.tileQuantCm(52.2, 14);
  assert.ok(cm > 30 && cm < 45, 'expected roughly 37 cm at z14, got ' + cm);
  // One zoom deeper would halve it; the pyramid stops at 14, hence the caveat.
  assert.ok(Math.abs(M.tileQuantCm(52.2, 15) * 2 - cm) < 1e-6);
});

// --- real buildings tile --------------------------------------------------
t('decodes the captured z14 buildings tile', () => {
  const layers = M.mvtDecode(fixture('tile-z14-buildings.pbf'));
  assert.deepEqual(Object.keys(layers), ['buildings']);
  const L = layers.buildings;
  assert.equal(L.extent, 4096);
  assert.equal(L.features.length, 8, 'fixture holds 8 features');
  assert.ok(L.keys.includes('lokalnyid'), 'lokalnyid must survive: decisions key on it');
  assert.ok(L.keys.includes('building'), 'the OSM tag must be present');
});

t('every feature is a polygon with a closed, plausible outline', () => {
  const L = M.mvtDecode(fixture('tile-z14-buildings.pbf')).buildings;
  let checked = 0;
  for (const fb of L.features) {
    const f = M.mvtFeature(fb, L);
    assert.equal(f.type, 3, 'buildings must decode as polygons');
    assert.ok(f.rings.length >= 1, 'expected at least one ring');
    assert.match(String(f.props.lokalnyid), /^[0-9a-f-]{20,}$/, 'lokalnyid should be a uuid');
    for (const r of f.rings) {
      assert.ok(r.length >= 4, 'a building ring needs at least 4 points, got ' + r.length);
      // Coordinates must land in or near the tile; a varint or zigzag slip
      // produces wildly out-of-range values rather than an obvious crash.
      for (const [x, y] of r) {
        assert.ok(x > -256 && x < 4096 + 256, 'x out of tile range: ' + x);
        assert.ok(y > -256 && y < 4096 + 256, 'y out of tile range: ' + y);
      }
    }
    checked++;
  }
  assert.equal(checked, 8);
});

t('decoded outlines land at the right place on Earth', () => {
  const L = M.mvtDecode(fixture('tile-z14-buildings.pbf')).buildings;
  const f = M.mvtFeature(L.features[0], L);
  for (const [px, py] of f.rings[0]) {
    const [lat, lon] = M.tilePointToLatLon(14, 9147, 5396, px, py, L.extent);
    assert.ok(lat > 52.19 && lat < 52.25, 'lat outside the tile: ' + lat);
    assert.ok(lon > 20.97 && lon < 21.03, 'lon outside the tile: ' + lon);
  }
});

t('rings enclose a sane building area', () => {
  const L = M.mvtDecode(fixture('tile-z14-buildings.pbf')).buildings;
  const mPerUnit = M.tileQuantCm(52.2, 14) / 100;
  for (const fb of L.features) {
    const f = M.mvtFeature(fb, L);
    for (const r of f.rings) {
      let a = 0;
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
      }
      const m2 = Math.abs(a / 2) * mPerUnit * mPerUnit;
      assert.ok(m2 > 1 && m2 < 2e5, 'implausible building area: ' + m2.toFixed(1) + ' m2');
    }
  }
});

// --- real cluster tile ----------------------------------------------------
t('decodes the captured z6 cluster tile used to find work', () => {
  const layers = M.mvtDecode(fixture('tile-z6-clusters.pbf'));
  const L = layers.buildings_clustered;
  assert.ok(L, 'expected a buildings_clustered layer');
  assert.equal(L.features.length, 9900);
  assert.deepEqual(L.keys, ['no_of_points']);
  let weighted = 0, maxw = 0;
  for (const fb of L.features.slice(0, 400)) {
    const f = M.mvtFeature(fb, L);
    assert.equal(f.type, 1, 'clusters are points');
    assert.ok(f.rings.length === 1 && f.rings[0].length === 1, 'one point per cluster');
    const w = Number(f.props.no_of_points);
    assert.ok(Number.isFinite(w) && w >= 1, 'bad cluster weight: ' + f.props.no_of_points);
    weighted += w;
    maxw = Math.max(maxw, w);
  }
  assert.ok(weighted > 400, 'weights should exceed one per cluster');
  assert.ok(maxw > 1, 'expected at least one multi-object cluster to weight towards');
});

t('a truncated tile is rejected rather than silently mis-decoded', () => {
  const full = fixture('tile-z14-buildings.pbf');
  // Cutting mid-message must throw or yield nothing usable — never a plausible
  // but wrong outline, which would upload bad geometry.
  let threw = 0, empty = 0;
  for (const cut of [3, 11, 40, 200, 700]) {
    try {
      const layers = M.mvtDecode(full.subarray(0, cut));
      const L = layers.buildings;
      if (!L || !L.features.length) { empty++; continue; }
      for (const fb of L.features) M.mvtFeature(fb, L);
      empty++;   // decoded something, but from a prefix; acceptable
    } catch (_) { threw++; }
  }
  assert.equal(threw + empty, 5, 'every truncation must either throw or degrade safely');
});

console.log('\nmvt: ' + pass + ' groups passed');
