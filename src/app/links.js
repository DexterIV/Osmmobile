const ID_BACKGROUND = {
  'orto-high': 'Geoportal2-PL-HighResolution-aerial_image_WMS',
  'orto-std': 'Geoportal2-PL-aerial_image_WMS',
  'orto-archive': 'Geoportal2-PL-aerial_archival_image_WMS',
  // The budynki proxy fronts StandardResolution, so this is the same picture.
  'orto-proxy': 'Geoportal2-PL-aerial_image_WMS',
};

function idEditorUrl(c) {
  const centre = c.kind === 'address' ? c.ring[0] : centroid(c.ring);
  const z = Math.max(17, Math.min(21, map.getZoom()));
  const hash = ['map=' + z.toFixed(0) + '/' + centre[0].toFixed(5) + '/' + centre[1].toFixed(5)];
  const bg = ID_BACKGROUND[S.imagery];
  if (bg) hash.push('background=' + encodeURIComponent(bg));
  // Prefill the changeset fields so an edit made over there is still attributed
  // the same way as one made here.
  const city = c.tags['addr:city'] || c.tags['addr:place'] || '';
  if (S.comment) hash.push('comment=' + encodeURIComponent(S.comment + (city ? ' — ' + city : '')));
  if (S.source) hash.push('source=' + encodeURIComponent(S.source));
  return OSM + '/edit?editor=id#' + hash.join('&');
}

// Google's documented Maps URLs form, not a scraped /maps/@lat,lon,19z/data=…
// path — the latter encodes the view in an undocumented blob that has changed
// before. basemap=satellite because a second, usually differently dated aerial
// image is the point; Street View is one tap away once it is open.
function googleMapsUrl(c) {
  const centre = c.kind === 'address' ? c.ring[0] : centroid(c.ring);
  const z = Math.max(17, Math.min(21, map.getZoom()));
  return 'https://www.google.com/maps/@?api=1&map_action=map' +
    '&center=' + centre[0].toFixed(6) + ',' + centre[1].toFixed(6) +
    '&zoom=' + z.toFixed(0) + '&basemap=satellite';
}

function openInGoogleMaps() {
  const c = cur();
  if (!c) return;
  window.open(googleMapsUrl(c), '_blank', 'noopener');
}

function openInId() {
  const c = cur();
  if (!c) return;
  // A new tab, deliberately: navigating away would discard the in-memory queue
  // of candidates, and only the verdicts are persisted.
  window.open(idEditorUrl(c), '_blank', 'noopener');
  // Worth saying once: the candidate is not in OSM yet, so iD cannot select it.
  toast('Opened iD at this spot. The candidate itself is not in OSM yet, so only ' +
    'existing objects are editable there.');
}

// ---- Review before sending -------------------------------------------------
// The up-arrow used to upload immediately. Nothing between an accidental tap and
// a live changeset, and no way to see what had accumulated across sessions.

function queueLabel(it) {
  const t = it.tags || {};
  if (it.kind === 'address') {
    const hn = t['addr:housenumber'] || '?';
    const st = t['addr:street'] || t['addr:place'] || '';
    return { title: hn + (st ? ' ' + st : ''), what: 'address' };
  }
  if (it.kind === 'area') {
    const key = AREA_KEYS.find((k) => t[k]) || 'landuse';
    const holes = (it.holes || []).length;
    return {
      title: key + '=' + t[key] + (holes ? '  (' + holes + ' hole' + (holes > 1 ? 's' : '') + ')' : ''),
      what: 'area',
    };
  }
  return { title: 'building=' + (t.building || 'yes'), what: 'building' };
}

function changesetPreview(count, city) {
  return csTags(count, city).map(([k, v]) => k + ' = ' + v).join('\n');
}

async function openQueueSheet() {
  const rows = (await dbAll('queue')).map((e) => Object.assign({ key: e.key }, e.val));
  rows.sort((a, b) => (a.city || '').localeCompare(b.city || '') || (a.t || 0) - (b.t || 0));
  const box = $('queueList');
  box.innerHTML = '';
  if (!rows.length) {
    box.innerHTML = '<p class="hint">Nothing queued.</p>';
  }
  for (const it of rows) {
    const { title, what } = queueLabel(it);
    const row = document.createElement('div');
    row.className = 'qRow';
    const main = document.createElement('div');
    main.className = 'qMain';
    const tags = Object.entries(it.tags || {})
      .filter(([k]) => !S.dropKeys.includes(k))
      .map(([k, v]) => k + '=' + v).join('  ');
    const snCount = it.snaps ? it.snaps.filter(Boolean).length : 0;
    main.innerHTML = '<div class="qTitle"><span class="k">' + esc(what) + '</span> ' + esc(title) +
      (it.moved ? ' <span class="qMoved">· nudged</span>' : '') +
      (snCount ? ' <span class="qSnapped">· snapped (' + snCount + ')</span>' : '') + '</div>' +
      '<div class="qSub">' + esc(it.city || 'no city') + ' · ' + esc(tags || 'no tags') + '</div>';
    const del = document.createElement('button');
    del.textContent = '×';
    del.title = 'Drop from the upload';
    del.onclick = async () => {
      await dbDel('queue', it.key);
      // Forget the accept too, or the object is silently dropped for good: it
      // would be filtered out of every future load as "already decided".
      await dbDel('decisions', it.key);
      await refreshQueueBadge();
      openQueueSheet();
    };
    row.appendChild(main);
    row.appendChild(del);
    box.appendChild(row);
  }
  if ($('qComment')) $('qComment').value = S.comment || '';
  if ($('qSource')) $('qSource').value = S.source || '';
  const city = rows.length ? (rows[0].city || 'Poland') : 'Poland';
  const comment = $('qComment') ? $('qComment').value : (S.comment || '');
  const src = $('qSource') ? $('qSource').value : (S.source || '');
  const prev = rows.length
    ? changesetPreview(Math.min(rows.length, S.batchSize), city)
        .replace((S.comment || '') + ' — ' + city, comment + ' — ' + city)
        .replace(S.source || '', src)
    : '';
  $('csPreview').textContent = rows.length ? 'First changeset would carry:\n' + prev : '';
  $('queueUpload').textContent = rows.length ? 'Upload ' + rows.length : 'Upload';
  $('queueUpload').disabled = !rows.length;
  $('queueSheet').classList.add('open');
}

function closeQueueSheet() { $('queueSheet').classList.remove('open'); }

// Fetch the live OSM state of every existing node and way referenced by snaps
// in this batch right before upload. Context cells can be cached for up to 24 h;
// refreshing here guarantees current version numbers (preventing 409 Conflict),
// preserves all tags/nodes on modified ways, and drops references to any node
// deleted in OSM while the item waited in the queue.
async function fetchLiveOsmForBatch(batch) {
  const nodeIds = new Set();
  const wayIds = new Set();
  for (const b of batch) {
    if (!b.snaps) continue;
    for (const s of b.snaps) {
      if (!s) continue;
      if (s.kind === 'node' && s.nodeId > 0) nodeIds.add(s.nodeId);
      if (s.kind === 'edge' && s.wayId > 0) wayIds.add(s.wayId);
    }
  }
  const live = { nodes: new Map(), ways: new Map() };
  if (!nodeIds.size && !wayIds.size) return live;

  const merge = (xml) => {
    const parsed = parseLiveOsmXml(xml);
    for (const [k, v] of parsed.nodes) live.nodes.set(k, v);
    for (const [k, v] of parsed.ways) live.ways.set(k, v);
  };

  if (nodeIds.size) {
    const ids = [...nodeIds];
    try {
      const r = await fetchOk(API + '/nodes?nodes=' + ids.join(','), { tries: 2, timeout: 15000 });
      merge(await r.text());
    } catch (_) {
      // Multi-fetch returns 404 if any single id never existed; check individually.
      for (const nid of ids) {
        try {
          const r = await fetchOk(API + '/node/' + nid, { tries: 1, timeout: 10000 });
          merge(await r.text());
        } catch (__) {}
      }
    }
  }

  if (wayIds.size) {
    const ids = [...wayIds];
    try {
      const r = await fetchOk(API + '/ways?ways=' + ids.join(','), { tries: 2, timeout: 15000 });
      merge(await r.text());
    } catch (_) {
      for (const wid of ids) {
        try {
          const r = await fetchOk(API + '/way/' + wid, { tries: 1, timeout: 10000 });
          merge(await r.text());
        } catch (__) {}
      }
    }
  }
  return live;
}

async function uploadQueue() {
  const t = await token();
  if (!t) { toast('Sign in first', 'warn'); return; }
  if ($('qComment')) S.comment = $('qComment').value;
  if ($('qSource')) S.source = $('qSource').value;
  await dbPut('kv', 'settings', S).catch(() => {});
  const all = (await dbAll('queue')).map((e) => Object.assign({ key: e.key }, e.val));
  if (!all.length) return;
  closeQueueSheet();
  all.sort((a, b) => (a.city || '').localeCompare(b.city || '') || a.ring[0][0] - b.ring[0][0]);
  const H = { Authorization: 'Bearer ' + t, 'Content-Type': 'text/xml' };
  let done = 0;
  setStage('Uploading 0 / ' + all.length);
  for (let i = 0; i < all.length; i += S.batchSize) {
    const batch = all.slice(i, i + S.batchSize);
    // Copy source tag to objects if missing
    for (const b of batch) {
      if (!b.tags) b.tags = {};
      if (S.source && !b.tags.source) b.tags.source = S.source;
    }
    const city = batch[0].city || 'Poland';
    const cs = '<osm><changeset>' +
      csTags(batch.length, city).map(([k, v]) => `<tag k="${esc(k)}" v="${esc(v)}"/>`).join('') +
      '</changeset></osm>';
    try {
      const liveOsm = await fetchLiveOsmForBatch(batch);
      let r = await fetch(API + '/changeset/create', { method: 'PUT', headers: H, body: cs });
      if (!r.ok) throw new Error('changeset ' + r.status + ' ' + (await r.text()).slice(0, 120));
      const id = (await r.text()).trim();
      r = await fetch(API + '/changeset/' + id + '/upload', {
        method: 'POST', headers: H, body: osmChange(batch, id, liveOsm),
      });
      if (!r.ok) throw new Error('upload ' + r.status + ' ' + (await r.text()).slice(0, 200));
      await fetch(API + '/changeset/' + id + '/close', { method: 'PUT', headers: H });
      for (const b of batch) await dbDel('queue', b.key);
      if (liveOsm.ways.size) ctxCells.clear();
      done += batch.length;
      setStage('Uploading ' + done + ' / ' + all.length);
    } catch (err) {
      toast('Upload stopped: ' + (err.message || err), 'warn');
      break;
    }
  }
  setStage('');
  await refreshQueueBadge();
  if (done) toast('Uploaded ' + done + ' objects');
}

