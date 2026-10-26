// ---- Mapbox Vector Tiles ---------------------------------------------------
// Upstream went through a full rewrite on 2026-10-11 ("OSM Polska budynki/adresy
// v2"). The API it serves now:
//
//   GET /tiles/{z}/{x}/{y}      MVT — NO .pbf suffix any more, and the router
//                               rejects .pbf with a 400 that carries no CORS
//                               header ("cannot parse value `20.pbf` to a u32")
//   GET /package?bbox=w,s,e,n   the old /josm_data: a FeatureCollection of the
//     &datasets=bdot10k,egib,  still-unmatched objects, but GeoJSON and id-less
//     prg                      (ingestible by parseGeoJson unchanged)
//   POST /report               {objects:[{source,key:UIRt}]} — v2's reject
//                              reporting, replacing /sc/*/report
//   GET /status, /updates      liveness; recent OSM-matching GeoJSON
//
//   /random/, /layers/ and /josm_data return 404 — they are gone, not flaky.
//
// Tile pyramid as measured from live tiles (the names changed wholesale):
//   z5–11 agg_cells     aggregated bins: unmatched counts n_bdot10k/n_egib/
//                       n_prg, totals t_*, ratios r_*, recency ts_*
//   z12–13 points       one point per still-unmatched object, same counts
//   z14      buildings  still-unmatched buildings, full polygons, with a
//                       `tags` property of `key=value` pairs joined by `;`
//                       and separate source:building / building:levels
//            addresses  still-unmatched PRG addresses, points with ready
//                       addr:* tags and lokalny_id; *_all is the whole PRG
//                       set, matched or not, and is never loaded
//
// What v2 does NOT send is any Access-Control-Allow-Origin. v1 sent `*`; the
// Rust rewrite dropped it because its own page is same-origin and nobody noticed
// (the only ACAO mention in their tree is zero occurrences — checked). From
// dexteriv.github.io a cross-origin fetch is therefore refused no matter what
// the app does — this is what diagnostics reports, and the remedy is pointing
// Settings → API base at a mirror that adds the header. The one route that
// still works straight is a plain navigation to /package, which no CORS policy
// restricts and the file route ingests.
//
// Only the subset these layers use: layers, features, string and numeric
// values, and MoveTo/LineTo/ClosePath geometry (addresses are single-point
// MoveTo features, so they exercise the same ring decoder). Decoded by hand
// because the build inlines everything into a single file.

const TILE_DATA_Z = 14;   // deepest zoom served, and so the finest geometry
const CLUSTER_Z = 6;      // agg_cells bins, for finding somewhere busy
const POLAND = [[49.0, 14.1], [54.9, 24.2]];
const TD = new TextDecoder();

function pbVarint(r) {
  let shift = 0, out = 0, byte;
  do {
    byte = r.b[r.p++];
    // Multiplied rather than shifted: ids exceed 32 bits and << would wrap.
    out += (byte & 0x7f) * (shift ? Math.pow(2, shift) : 1);
    shift += 7;
  } while (byte & 0x80);
  return out;
}
const pbZigzag = (n) => (n >>> 1) ^ -(n & 1);

function pbSkip(r, wire) {
  if (wire === 0) pbVarint(r);
  else if (wire === 1) r.p += 8;
  else if (wire === 2) r.p += pbVarint(r);
  else if (wire === 5) r.p += 4;
  else throw new Error('mvt: unknown wire type ' + wire);
}

function mvtDecode(bytes) {
  const r = { b: bytes, p: 0 };
  const layers = {};
  while (r.p < bytes.length) {
    const key = pbVarint(r), field = key >> 3, wire = key & 7;
    if (field === 3 && wire === 2) {
      const len = pbVarint(r);
      const L = mvtLayer(bytes.subarray(r.p, r.p + len));
      r.p += len;
      if (L.name) layers[L.name] = L;
    } else pbSkip(r, wire);
  }
  return layers;
}

function mvtLayer(bytes) {
  const r = { b: bytes, p: 0 };
  const out = { name: '', extent: 4096, keys: [], values: [], features: [] };
  while (r.p < bytes.length) {
    const key = pbVarint(r), field = key >> 3, wire = key & 7;
    if (field === 5 && wire === 0) { out.extent = pbVarint(r); continue; }
    if (wire !== 2) { pbSkip(r, wire); continue; }
    const len = pbVarint(r);
    const sub = bytes.subarray(r.p, r.p + len);
    r.p += len;
    if (field === 1) out.name = TD.decode(sub);
    else if (field === 2) out.features.push(sub);
    else if (field === 3) out.keys.push(TD.decode(sub));
    else if (field === 4) out.values.push(mvtValue(sub));
  }
  return out;
}

function mvtValue(bytes) {
  const r = { b: bytes, p: 0 };
  let v = null;
  const dv = () => new DataView(bytes.buffer, bytes.byteOffset + r.p);
  while (r.p < bytes.length) {
    const key = pbVarint(r), field = key >> 3, wire = key & 7;
    if (field === 1 && wire === 2) {
      const n = pbVarint(r);
      v = TD.decode(bytes.subarray(r.p, r.p + n));
      r.p += n;
    } else if (field === 2 && wire === 5) { v = dv().getFloat32(0, true); r.p += 4; }
    else if (field === 3 && wire === 1) { v = dv().getFloat64(0, true); r.p += 8; }
    else if ((field === 4 || field === 5) && wire === 0) v = pbVarint(r);
    else if (field === 6 && wire === 0) v = pbZigzag(pbVarint(r));
    else if (field === 7 && wire === 0) v = pbVarint(r) !== 0;
    else pbSkip(r, wire);
  }
  return v;
}

function mvtFeature(bytes, layer) {
  const r = { b: bytes, p: 0 };
  let type = 0, geom = null;
  const tags = [];
  while (r.p < bytes.length) {
    const key = pbVarint(r), field = key >> 3, wire = key & 7;
    if (field === 3 && wire === 0) { type = pbVarint(r); continue; }
    if (wire !== 2) { pbSkip(r, wire); continue; }
    const len = pbVarint(r);
    const sub = bytes.subarray(r.p, r.p + len);
    r.p += len;
    if (field === 2) { const rr = { b: sub, p: 0 }; while (rr.p < sub.length) tags.push(pbVarint(rr)); }
    else if (field === 4) geom = sub;
  }
  const props = {};
  for (let i = 0; i + 1 < tags.length; i += 2) {
    const k = layer.keys[tags[i]], v = layer.values[tags[i + 1]];
    if (k !== undefined && v !== undefined) props[k] = v;
  }
  return { type, props, rings: geom ? mvtRings(geom) : [] };
}

function mvtRings(g) {
  const r = { b: g, p: 0 };
  const rings = [];
  let cur = null, x = 0, y = 0;
  while (r.p < g.length) {
    const cmd = pbVarint(r), id = cmd & 7, count = cmd >> 3;
    if (id === 1) {
      for (let i = 0; i < count; i++) {
        x += pbZigzag(pbVarint(r)); y += pbZigzag(pbVarint(r));
        if (cur && cur.length) rings.push(cur);
        cur = [[x, y]];
      }
    } else if (id === 2) {
      for (let i = 0; i < count; i++) {
        x += pbZigzag(pbVarint(r)); y += pbZigzag(pbVarint(r));
        if (cur) cur.push([x, y]);
      }
    } else if (id === 7) {
      if (cur && cur.length) { rings.push(cur); cur = null; }
    } else break;
  }
  if (cur && cur.length) rings.push(cur);
  return rings;
}

function tileXY(lat, lon, z) {
  const n = Math.pow(2, z);
  const rad = lat * Math.PI / 180;
  return [
    Math.floor((lon + 180) / 360 * n),
    Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n),
  ];
}

function tilePointToLatLon(z, tx, ty, px, py, extent) {
  const n = Math.pow(2, z);
  const lon = (tx + px / extent) / n * 360 - 180;
  const yy = 1 - 2 * (ty + py / extent) / n;
  return [Math.atan(Math.sinh(Math.PI * yy)) * 180 / Math.PI, lon];
}

function tilesCovering(b, z) {
  const [x0, y0] = tileXY(b.getNorth(), b.getWest(), z);
  const [x1, y1] = tileXY(b.getSouth(), b.getEast(), z);
  const out = [];
  for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) out.push([x, y]);
  }
  return out;
}

// Tile geometry is quantised to the extent grid, so report the resulting
// resolution honestly rather than implying the outlines are exact.
function tileQuantCm(lat, z) {
  return (40075017 * Math.cos(lat * Math.PI / 180) / Math.pow(2, z) / 4096) * 100;
}

// v2 packs the OSM-ready tags into one `tags` property as `key=value` pairs
// joined by `;` — measured on live z14 tiles: `building=detached`,
// `building=yes;fixme=EGiB: budynki transportu i łączności`. building:levels and
// source:building ride beside it as their own properties. Upstream curates that
// string itself (the fixme entries are deliberate), so no client-side whitelist:
// whatever arrived as an OSM tag list goes up as one, which is exactly what
// /josm_data emitted for the same object in v1.
function tagsFromTile(p) {
  const t = {};
  for (const kv of String(p.tags || '').split(';')) {
    const i = kv.indexOf('=');
    if (i <= 0) continue;
    const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
    if (k && v) t[k] = v;
  }
  if (p['building:levels'] !== undefined && p['building:levels'] !== null &&
      p['building:levels'] !== '') {
    t['building:levels'] = String(p['building:levels']);
  }
  if (!t.building) t.building = 'yes';
  // v2 answers with `BDOT` or `EGiB` per feature; the value must follow the
  // registry the geometry actually came from, so it travels with the tile.
  t['source:building'] = p['source:building'] ? String(p['source:building']) : 'BDOT';
  return t;
}

// v2's z14 `addresses` layer is PRG's still-unmatched set. Buildings arrive with
// one curated `tags` string; addresses arrive with each tag as its own property
// beside a pile of source columns (numer_porzadkowy, ulica, teryt_gmina, gmina,
// wazny_od_lub_data_nadania, ...). Only `addr:*` and `source:addr` are OSM tags —
// the rest must never upload as tags, and lokalny_id is the report identity and
// decision key, not an address tag. The /package route emits exactly this set,
// so both ingest paths upload the same tags for the same address.
function addressTagsFromTile(p) {
  const t = {};
  for (const k of Object.keys(p)) {
    if (!k.startsWith('addr:') && k !== 'source:addr') continue;
    const v = p[k];
    // String(undefined) is "undefined", which would upload as a literal tag.
    if (v === null || v === undefined) continue;
    if (String(v)) t[k] = String(v);
  }
  return t;
}

function ringSignedArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  }
  return a / 2;
}

async function tileBytes(z, x, y, tries) {
  // A 404 on a tile means "no data here" (empty tile at this zoom), not that
  // the server is unreachable. Return an empty buffer so fetchAreaTiles treats
  // it as a tile with no buildings rather than counting it as a failure.
  try {
    const r = await fetchOk(apiBase() + '/tiles/' + z + '/' + x + '/' + y,
      { tries: tries || 3, timeout: 20000 });
    return new Uint8Array(await r.arrayBuffer());
  } catch (err) {
    if (err.kind === 'http' && String(err.message).match(/^HTTP 404$/)) {
      return new Uint8Array(0);
    }
    throw err;
  }
}

// Unmatched buildings and addresses for an area, straight from the vector
// tiles. Since the v2 rewrite the z14 `buildings` layer is the still-unmatched
// set — matched rows only live in buildings_all, which a review should not load
// — and per-object currency dates are gone from the tiles (only z5-13 agg_cells
// carries recency, and only for government changes of the last few days), so
// srcAge shows nothing rather than a fabricated year. The z14 `addresses` layer
// carries the still-unmatched PRG addresses, points with ready `addr:*` tags and
// a `lokalny_id`; that id gives them a stable `prg:<id>` decision key and a
// /report identity, which the /package route's id-less, hash-keyed addresses
// cannot.
