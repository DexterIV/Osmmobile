async function fetchAreaTiles(bounds) {
  const tiles = tilesCovering(bounds, TILE_DATA_Z);
  const got = await Promise.all(tiles.map(async ([x, y]) => {
    try {
      const buf = await tileBytes(TILE_DATA_Z, x, y);
      return { x, y, layers: buf.length ? mvtDecode(buf) : {} };
    } catch (err) { return { x, y, err }; }
  }));

  let failed = 0, clipped = 0;
  const best = new Map();
  // Points are not clipped at tile edges the way polygons are, but a point
  // sitting exactly on a shared edge can arrive from both tiles, so dedupe on
  // the PRG id across the whole fetch rather than per tile.
  const bestAddr = new Map();
  for (const t of got) {
    if (t.err) { failed++; continue; }
    const L = t.layers.buildings;
    if (L) for (const fb of L.features) {
      const f = mvtFeature(fb, L);
      if (f.type !== 3) continue;
      for (const ring of f.rings) {
        if (ring.length < 3) continue;
        // Exterior rings wind positive in tile coordinates; the rest are holes.
        if (ringSignedArea(ring) <= 0) continue;
        const cut = ring.some(([px, py]) =>
          px <= 0 || py <= 0 || px >= L.extent || py >= L.extent);
        const id = f.props.id;
        const key = id || t.x + '/' + t.y + '/' + ring[0][0] + ',' + ring[0][1];
        const prev = best.get(key);
        if (prev) {
          // A polygon crossing a tile edge is clipped in one tile and whole in
          // its neighbour, so always prefer the uncut copy.
          const better = (!cut && prev.cut) ||
            (cut === prev.cut && ring.length > prev.ring.length);
          if (!better) continue;
        }
        // v2 splits buildings across two registries — bdot10k (uuid ids, the
        // same lokalnyid space v1 meant by `bdot:`) and egib (TERYT ids like
        // `141805_2.0026.364_BUD`). The decisions key names the registry so an
        // egib id can never collide with a bdot uuid.
        const reg = f.props.source === 'egib' ? 'egib' : 'bdot';
        // /report identity, captured here because the review sheet's reject
        // needs it later: bdot10k requires PRZESTRZENNAZW beside the id, egib
        // and prg key on the id alone. Missing either means unreportable.
        let report = null;
        if (reg === 'egib' && id) {
          report = { source: 'egib', key: { id_budynku: String(id) } };
        } else if (id && f.props.PRZESTRZENNAZW != null && f.props.PRZESTRZENNAZW !== '') {
          report = { source: 'bdot10k', key: {
            PRZESTRZENNAZW: String(f.props.PRZESTRZENNAZW), LOKALNYID: String(id) } };
        }
        best.set(key, {
          cut,
          kind: 'building',
          reg,
          report,
          ring: ring.map(([px, py]) => tilePointToLatLon(TILE_DATA_Z, t.x, t.y, px, py, L.extent)),
          tags: tagsFromTile(f.props),
          srcId: id,
          // Provenance, kept off the uploaded tags but shown while reviewing.
          // v2 tiles carry no per-object currency year — status exists as
          // KATEGORIAISTNIENIA for bdot rows only.
          srcDate: '',
          srcStatus: f.props.KATEGORIAISTNIENIA ? String(f.props.KATEGORIAISTNIENIA) : '',
        });
      }
    }

    const A = t.layers.addresses;
    if (!A) continue;
    for (const fb of A.features) {
      const f = mvtFeature(fb, A);
      if (f.type !== 1 || !f.rings.length || f.rings[0].length !== 1) continue;
      const tags = addressTagsFromTile(f.props);
      // A PRG row without a house number cannot be reviewed as an address and
      // would upload a nameless node. Upstream always emits one; skip malformed
      // rows rather than inventing a tag for them.
      if (!tags['addr:housenumber']) continue;
      const id = f.props.lokalny_id;
      const [px, py] = f.rings[0][0];
      const key = id || t.x + '/' + t.y + '/' + px + ',' + py;
      if (bestAddr.has(key)) continue;
      bestAddr.set(key, {
        kind: 'address',
        ring: [tilePointToLatLon(TILE_DATA_Z, t.x, t.y, px, py, A.extent)],
        tags,
        srcId: id ? String(id) : undefined,
        // prg reports by lokalny_id alone. Missing means unreportable.
        report: id ? { source: 'prg', key: { lokalny_id: String(id) } } : null,
        srcDate: '',
        srcStatus: '',
      });
    }
  }

  const out = [];
  for (const c of best.values()) {
    // A still-clipped outline is the wrong shape, and uploading it would be
    // worse than not having it. Those are reachable through the file route.
    if (c.cut) { clipped++; continue; }
    delete c.cut;
    out.push(c);
  }
  for (const c of bestAddr.values()) out.push(c);
  return { list: out, failed, clipped, tiles: tiles.length };
}

// Weighted pick from agg_cells, replacing the dead /random/. One z6 tile is
// about 110 KB and covers a large slice of Poland, so it is fetched one at a
// time and cached rather than pulling the whole country.
// quiet is for the automatic attempt at boot, so a fresh launch does not open
// with a warning if the tile server happens to be unreachable.
async function clusterJump() {
  const order = tilesCovering(L.latLngBounds(POLAND[0], POLAND[1]), CLUSTER_Z);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = order[i]; order[i] = order[j]; order[j] = t;
  }
  // Try every tile, not just 3 — Poland needs about 9 z6 tiles for full
  // coverage, and drawing only 3 at random meant "Take me somewhere" failed
  // whenever the empty tiles happened to be picked first. We break on the
  // first tile that has features, so we rarely fetch them all.
  //
  // Each bin is weighted by its unmatched work — buildings plus PRG addresses,
  // since the tile ingest now carries both. Addresses are the smaller share
  // (measured on a z6 tile over central Poland: 1.34 M unmatched buildings to
  // 0.31 M addresses, and 842 of 854 occupied bins hold both), so including
  // them adds weight to the bins that were already candidates rather than
  // steering the jump towards address-only areas. n_prg used to be excluded
  // because tile ingest was buildings-only; that reason is gone. The jump
  // target is the bin polygon's centroid, shoelaced in plain JS like
  // ringSignedArea, so clusterJump does not depend on the wasm module for a
  // one-off report that the point() wasm kernel would otherwise give.
  for (const [x, y] of order) {
    const ck = 'clusters/' + CLUSTER_Z + '/' + x + '/' + y;
    let buf = null;
    const hit = await dbGet('ctx', ck).catch(() => null);
    if (hit && hit.buf && Date.now() - hit.t < S.ctxTTLhours * 3600e3) {
      buf = new Uint8Array(hit.buf);
    } else {
      try {
        buf = await tileBytes(CLUSTER_Z, x, y, 2);
        dbPut('ctx', ck, { t: Date.now(), buf: buf.buffer }).catch(() => {});
      } catch (err) { continue; }
    }
    if (!buf.length) continue;
    const L = mvtDecode(buf).agg_cells;
    if (!L || !L.features.length) continue;
    const picks = [];
    let total = 0;
    for (const fb of L.features) {
      const f = mvtFeature(fb, L);
      if (!f.rings.length || !f.rings[0].length) continue;
      const w = (Number(f.props.n_bdot10k) || 0) + (Number(f.props.n_egib) || 0) +
        (Number(f.props.n_prg) || 0);
      if (!w) continue;
      const r = f.rings[0];
      let ax = 0, cx = 0, cy = 0;
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const cross = r[j][0] * r[i][1] - r[i][0] * r[j][1];
        ax += cross; cx += (r[j][0] + r[i][0]) * cross; cy += (r[j][1] + r[i][1]) * cross;
      }
      if (!ax) continue;
      total += w;
      picks.push({ w, pt: [cx / (3 * ax), cy / (3 * ax)] });
    }
    if (!picks.length) continue;
    let r = Math.random() * total;
    let chosen = picks[picks.length - 1];
    for (const p of picks) { r -= p.w; if (r <= 0) { chosen = p; break; } }
    return tilePointToLatLon(CLUSTER_Z, x, y, chosen.pt[0], chosen.pt[1], L.extent);
  }
  // No cluster tile had usable features — fall back to the map's default
  // centre so at least the map moves somewhere the user can start from.
  return [52.2, 21.0];
}

// A review queue owns the map controls, and the start panel is hidden while it
// is active. Without a way back, panning somewhere else meant finishing or
// reloading the app first. This is the same state reset as an empty queue, but
// without touching persisted decisions or the upload queue.
function clearArea() {
  cancelPrefetch();
  closeTagEditor();
  candidates = [];
  cursor = 0;
  undoStack = [];
  if (shape) { map.removeLayer(shape); shape = null; }
  if (ctxLayer) ctxLayer.clearLayers();
  if (pendingLayer) pendingLayer.clearLayers();
  if (vertexGroup) vertexGroup.clearLayers();
  ctxCells.clear();
  $('tags').innerHTML = '';
  $('qCount').textContent = '0 / 0';
  $('tier').textContent = '-';
  $('tier').className = 'tier t0';
  $('dist').textContent = '';
  $('drift').textContent = '';
  $('srcAge').textContent = '';
  $('locality').textContent = '';
  setControls(false);
}

async function changeArea() {
  if (areaLoading || verdicting) return;
  if (areaTooBig()) return;
  const c = cur();
  // Accepted items are already in the upload queue and decisions are persisted,
  // but tag edits and nudges on the current object only live in memory.
  if (c && (c.tagsEdited || c.moved) &&
      !confirm('Discard the edits to this candidate and load the area in view?')) return;
  clearArea();
  await loadArea();
}

let areaLoading = false;

async function loadArea() {
  if (areaLoading) return;
  if (areaTooBig()) return;
  areaLoading = true;
  const b = dataBounds();
  setStage('Fetching candidates');
  try {
    const res = await fetchAreaTiles(b);
    if (!res.list.length) {
      setStage('');
      setControls(false);
      $('start').style.display = 'flex';
      const why = res.failed === res.tiles
        ? 'Could not reach the tile server (' + res.failed + '/' + res.tiles + ' tiles failed)'
        : 'No unmatched buildings or addresses within ' + spanKm(b) + ' km of here';
      toast(why + '.', res.failed ? 'warn' : undefined);
      if (!res.failed) $('start').classList.add('expanded');
      return;
    }
    const blds = res.list.filter((c) => c.kind === 'building').length;
    const addrs = res.list.length - blds;
    const q = tileQuantCm(b.getCenter().lat, TILE_DATA_Z).toFixed(0);
    const notes = [];
    if (res.clipped) notes.push(res.clipped + ' cut by tile edges, skipped');
    if (res.failed) notes.push(res.failed + ' of ' + res.tiles + ' tiles failed');
    // Name both counts when both are present; "1 buildings" reads like a bug.
    const parts = [];
    if (blds) parts.push(blds + ' building' + (blds === 1 ? '' : 's'));
    if (addrs) parts.push(addrs + ' address' + (addrs === 1 ? '' : 'es'));
    await ingest(res.list, parts.join(' + ') + ' (±' + q + ' cm from tiles)' +
      (notes.length ? ' · ' + notes.join(' · ') : ''));
  } catch (err) {
    setStage('');
    setControls(false);
    $('start').style.display = 'flex';
    toast('Could not load tiles: ' + classify(err), 'warn');
  } finally {
    areaLoading = false;
  }
}

// /random/ is not used: on v1 it answered 500 on every request, and v2 removed
// the route outright. agg_cells gives the same "somewhere with work" answer,
// weighted by how much work is there, from a tile the browser can read.
// quiet is for the automatic attempt at boot, so a fresh launch does not open
// with a warning if the tile server happens to be unreachable.
async function loadRandom(quiet) {
  setStage('Finding somewhere with work');
  try {
    const p = await clusterJump();
    if (!p) throw new Error('no clusters returned');
    map.setView(p, TILE_DATA_Z, { animate: false });
    await loadArea();
  } catch (err) {
    setStage('');
    if (quiet) return;
    toast('Could not find an area: ' + classify(err), 'warn');
  }
}

// Candidates are sparse, so a small bbox legitimately returns nothing at all —
// measured against v1 /josm_data, a z18 viewport (~150 m) and even a z16 one came
// back as a bare `<osm version="0.6"/>`, 20 bytes, while 0.024° yielded 56 nodes.
// Every data request is therefore widened to at least this span about the centre
// of the view, so neither route can hand back an empty result that looks like a
// server fault. v2's /package keeps the same property: check_area caps the
// requested area at 0.04 sq deg, and this span stays well inside that.
const MIN_DATA_SPAN = 0.03;

function dataBounds() {
  const b = map.getBounds();
  const c = b.getCenter();
  const halfLat = Math.max((b.getNorth() - b.getSouth()) / 2, MIN_DATA_SPAN / 2);
  const halfLon = Math.max((b.getEast() - b.getWest()) / 2, MIN_DATA_SPAN / 2);
  return L.latLngBounds([c.lat - halfLat, c.lng - halfLon], [c.lat + halfLat, c.lng + halfLon]);
}

// A browser *navigation* to this is not subject to CORS, which is why the
// download route works where fetch cannot: v2 sends no
// Access-Control-Allow-Origin on anything, not even the tiles.
//
// /package is v2's /josm_data: it answers a GeoJSON FeatureCollection of what
// is still unmatched inside the bbox — addresses as Points with addr:* ready
// and buildings as Polygons plus MultiPolygons with OSM tag properties — which
// parseGeoJson ingests unchanged. It carries no per-object id, so those
// candidates key on their geometry hash like the old clipped-ring fallback did;
// the ids that decision keys prefer exist only in the tiles. Datasets mirror
// the registries v2 serves; sending all three matches what /josm_data shipped.
// The server answers the area cap with a 400, so MIN_DATA_SPAN matters here
// and no route can widen past 0.2°.
function areaDataUrl() {
  const b = dataBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(',');
  return apiBase() + '/package?bbox=' + encodeURIComponent(bbox) +
    '&datasets=bdot10k,egib,prg';
}

// Judged on the widened bounds, since those are what actually gets requested.
// There is no zoom test: span is the constraint the server cares about, and a
// zoom floor rejected legal requests from a short window.
function areaTooBig() {
  const b = dataBounds();
  const span = Math.max(b.getNorth() - b.getSouth(), b.getEast() - b.getWest());
  if (span > 0.2) {
    toast('Zoom in a bit — that area is too big to fetch', 'warn');
    return true;
  }
  return false;
}

// Rough N–S extent of the request, for telling the user what was asked for.
function spanKm(b) {
  return ((b.getNorth() - b.getSouth()) * 111.32).toFixed(1);
}

async function loadText(text, label) {
  setStage('Parsing ' + label);
  const t0 = performance.now();
  let list;
  try {
    list = /^\s*\{/.test(text) ? parseGeoJson(text) : parseOsmXml(text);
  } catch (err) {
    setStage('');
    toast('Could not parse ' + label + ': ' + (err.message || err), 'warn');
    return;
  }
  if (!list.length) {
    setStage('');
    toast('No candidates found in ' + label + ' — wrong file, or nothing left here', 'warn');
    return;
  }
  await ingest(list, list.length + ' candidates in ' + fmt(performance.now() - t0, 0) + ' ms');
}

async function loadFile(file) {
  await loadText(await file.text(), file.name);
}

async function loadPasted() {
  let text = ($('pasteBox').value || '').trim();
  if (!text && navigator.clipboard && navigator.clipboard.readText) {
    text = (await navigator.clipboard.readText().catch(() => '')).trim();
  }
  if (!text) {
    toast('Nothing to load — paste the data into the box first', 'warn');
    return;
  }
  $('pasteBox').value = '';
  await loadText(text, 'pasted data');
}

