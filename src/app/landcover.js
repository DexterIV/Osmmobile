const LC_CLASSES = [
  'landuse=farmland', 'landuse=meadow', 'landuse=grass',
  'landuse=forest', 'natural=wood', 'natural=scrub',
  'landuse=orchard', 'landuse=vineyard', 'landuse=allotments',
  'natural=sand', 'natural=bare_rock', 'natural=tree', 'building=yes',
];

function lcServer() {
  return (S.lcServer || '').trim().replace(/\/+$/, '');
}

// A class is reviewed unless it has been switched off, so a class the importer
// starts emitting later shows up rather than being silently dropped.
function lcEnabled(cls) {
  return !(S.lcOff || []).includes(cls);
}

function candidateClass(c) {
  for (const k of AREA_KEYS.concat(['building'])) {
    if (c.tags[k]) return k + '=' + c.tags[k];
  }
  return '';
}

async function lcIndex() {
  const base = lcServer();
  if (!base) throw new Error('no land-cover server set');
  const r = await fetchOk(base + '/index', { tries: 2, timeout: 20000 });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error('unexpected index shape');
  return j;
}

const bboxHits = (tiles, b) => tiles.filter((t) => {
  const q = t.bbox;
  return Array.isArray(q) && q.length === 4 &&
    q[0] <= b.getEast() && q[2] >= b.getWest() &&
    q[1] <= b.getNorth() && q[3] >= b.getSouth();
});

async function loadLandCover() {
  const base = lcServer();
  if (!base) { openSettings(); toast('Set the land-cover server first', 'warn'); return; }
  setStage('Asking the land-cover server');
  try {
    const tiles = await lcIndex();
    const b = dataBounds();
    let hits = bboxHits(tiles, b);
    if (!hits.length) {
      setStage('');
      // Being told where the work actually is beats "nothing here".
      const near = tiles.slice().sort((x, y) =>
        metresBetween([b.getCenter().lat, b.getCenter().lng], [(x.bbox[1] + x.bbox[3]) / 2, (x.bbox[0] + x.bbox[2]) / 2]) -
        metresBetween([b.getCenter().lat, b.getCenter().lng], [(y.bbox[1] + y.bbox[3]) / 2, (y.bbox[0] + y.bbox[2]) / 2]))[0];
      toast(tiles.length
        ? 'No land-cover tile covers this view. Nearest of ' + tiles.length + ' is at ' +
          ((near.bbox[1] + near.bbox[3]) / 2).toFixed(3) + ', ' + ((near.bbox[0] + near.bbox[2]) / 2).toFixed(3)
        : 'The server has no tiles — run the importer first', 'warn');
      return;
    }
    // Cap the work: a whole voivodeship of tiles would be a very long download.
    hits = hits.slice(0, 12);
    const list = [];
    let failed = 0;
    for (let i = 0; i < hits.length; i++) {
      setStage('Land cover ' + (i + 1) + ' / ' + hits.length);
      try {
        const r = await fetchOk(base + '/tile/' + encodeURIComponent(hits[i].id) + '.osm',
          { tries: 2, timeout: 40000 });
        // parseOsmXml handles the relations, so holes survive as holes.
        for (const c of parseOsmXml(await r.text())) list.push(c);
      } catch (err) { failed++; }
    }
    const kept = list.filter((c) => {
      const cls = candidateClass(c);
      return cls ? lcEnabled(cls) : true;
    });
    const dropped = list.length - kept.length;
    if (!kept.length) {
      setStage('');
      toast(list.length
        ? 'All ' + list.length + ' features are in classes you have switched off'
        : 'Those tiles held nothing reviewable', 'warn');
      return;
    }
    const holes = kept.reduce((n, c) => n + ((c.holes || []).length ? 1 : 0), 0);
    await ingest(kept, kept.length + ' land-cover features from ' + hits.length + ' tile' +
      (hits.length > 1 ? 's' : '') +
      (holes ? ' · ' + holes + ' with holes' : '') +
      (dropped ? ' · ' + dropped + ' filtered out' : '') +
      (failed ? ' · ' + failed + ' tile(s) failed' : ''));
  } catch (err) {
    setStage('');
    toast('Land-cover server: ' + classify(err) +
      ' — check the https URL in settings and that cloudflared is up', 'warn');
  }
}


function paintLcClasses() {
  const box = $('lcClasses');
  if (!box) return;
  box.innerHTML = '';
  for (const cls of LC_CLASSES) {
    const id = 'lc_' + cls.replace(/[^a-z0-9]/gi, '_');
    const lab = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = id;
    cb.checked = lcEnabled(cls);
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(cls));
    box.appendChild(lab);
  }
}

async function paintLcStatus() {
  const el = $('lcStatus');
  const btn = $('lcBtn');
  const base = lcServer();
  if (!base) {
    if (el) el.textContent = '';
    if (btn) { btn.disabled = true; btn.title = 'Set a land-cover server in settings'; }
    return;
  }
  if (btn) { btn.disabled = false; btn.title = ''; }
  if (!el) return;
  el.textContent = 'Checking…';
  try {
    const r = await fetchOk(base + '/health', { tries: 1, timeout: 12000 });
    const j = await r.json();
    el.textContent = 'Server ok — ' + j.tiles + ' tile(s) in ' + (j.dir || '?');
    el.style.color = 'var(--verify)';
  } catch (err) {
    el.textContent = 'Not reachable: ' + classify(err);
    el.style.color = 'var(--ochre)';
  }
}

// ---- Open in iD ------------------------------------------------------------
// For the times when this app's one-object-at-a-time view is the wrong tool:
// iD has the imagery switcher, measurement, history, relation editing and so on.
//
// Ids are from the editor-layer-index, which is the same catalogue iD reads, so
// iD opens on the imagery you were just reviewing against rather than its
// default. An unrecognised id is ignored by iD rather than breaking, so a stale
// entry here degrades to "iD picks its own background".
