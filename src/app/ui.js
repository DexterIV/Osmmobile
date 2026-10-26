function setStage(s) {
  $('stage').textContent = s;
  $('stage').style.display = s ? 'block' : 'none';
}

function openSettings() { $('sheet').classList.add('open'); paintSettings(); }
function closeSettings() { $('sheet').classList.remove('open'); }

function paintSettings() {
  $('sImagery').value = S.imagery;
  $('sCustomUrl').value = S.customUrl;
  $('sCustomLayers').value = S.customLayers;
  $('sTileTTL').value = S.tileTTLdays;
  $('sCtxTTL').value = S.ctxTTLhours;
  $('sBatch').value = S.batchSize;
  $('sComment').value = S.comment;
  $('sSource').value = S.source;
  $('sRepo').value = S.repo;
  $('sLcServer').value = S.lcServer;
  paintLcClasses();
  paintLcStatus();
  $('sImportTag').checked = !!S.importTag;
  $('sClient').value = S.clientId;
  dbGet('kv', 'authError').then((m) => {
    const el = $('authNote');
    if (!el) return;
    el.textContent = m ? 'Last sign-in attempt: ' + m : '';
    el.style.color = 'var(--ochre)';
  }).catch(() => {});
  $('sApiBase').value = S.apiBase;
  $('sReport').checked = !!S.reportRejects;
  $('sSelfUrl').value = location.href.split('?')[0].split('#')[0];
  $('sShift').value = S.maxShift;
  $('sClear').value = S.clearRadius;
  cacheStats().then((c) => {
    $('cacheInfo').textContent = c.tiles + ' tiles, ' + fmt(c.bytes / 1048576, 1) + ' MB, ' + c.ctx + ' context sets';
  });
}

async function saveSettings() {
  S.imagery = $('sImagery').value;
  S.customUrl = $('sCustomUrl').value.trim();
  S.customLayers = $('sCustomLayers').value.trim();
  S.tileTTLdays = +$('sTileTTL').value || DEF.tileTTLdays;
  S.ctxTTLhours = +$('sCtxTTL').value || DEF.ctxTTLhours;
  S.batchSize = Math.max(1, Math.min(500, +$('sBatch').value || DEF.batchSize));
  S.comment = $('sComment').value;
  S.source = $('sSource').value;
  S.repo = $('sRepo').value.trim();
  S.lcServer = $('sLcServer').value.trim();
  S.lcOff = LC_CLASSES.filter((cls) => {
    const box = $('lc_' + cls.replace(/[^a-z0-9]/gi, '_'));
    return box && !box.checked;
  });
  S.importTag = $('sImportTag').checked;
  S.clientId = $('sClient').value.trim();
  S.apiBase = $('sApiBase').value.trim() || DEF.apiBase;
  S.reportRejects = $('sReport').checked;
  S.maxShift = Math.max(2, Math.min(24, +$('sShift').value || DEF.maxShift));
  S.clearRadius = Math.max(5, +$('sClear').value || DEF.clearRadius);
  await dbPut('kv', 'settings', S);
  makeImagery();
  if (candidates.length) { orderCandidates(); paintChrome(); }
  closeSettings();
  toast('Settings saved');
}

function bindUI() {
  $('file').onchange = (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); };
  // The markup ships this button disabled and labelled "Loading…", and nothing
  // used to turn it back on — setControls only touches #pad, #padTools and
  // #bar, so the file picker was permanently dead. Parsing needs wasm, and
  // bindUI runs after initWasm, so this is the right point to enable it.
  $('pickBtn').disabled = false;
  $('pickBtn').textContent = 'Open a .osm or GeoJSON file';
  $('pickBtn').onclick = () => $('file').click();
  $('loadAreaBtn').onclick = loadArea;
  $('lcBtn').onclick = loadLandCover;
  paintLcStatus();
  $('getDataBtn').onclick = async () => {
    if (areaTooBig()) return;
    const b = dataBounds();
    const url = areaDataUrl();
    const win = window.open(url, '_blank', 'noopener');
    if (!win) {
      // Popup blocked — fall back to copying the URL so the user can open it
      // manually. Can't rely on clipboard API in all contexts, so show the URL
      // in a prompt they can copy.
      try { await navigator.clipboard.writeText(url); } catch (_) {}
      toast('Popup blocked — open this URL in a new tab: ' + url, 'warn');
      return;
    }
    toast('Asked for a ' + spanKm(b) + ' km box. package.geojson with no features ' +
      'means nothing pending here — pan elsewhere and try again.');
  };
  $('pasteBtn').onclick = loadPasted;
  $('randomBtn').onclick = loadRandom;
  $('moreBtn').onclick = () => $('start').classList.toggle('expanded');
  $('diagBtn').onclick = () => { $('diagOut').textContent = 'Running…'; $('diagOut').style.display = 'block'; diagnose(); };
  $('rejectBtn').onclick = () => verdict('reject');
  $('laterBtn').onclick = () => verdict('later');
  $('acceptBtn').onclick = () => verdict('accept');
  $('undoBtn').onclick = undo;
  $('autoBtn').onclick = autoAlign;
  $('sqBtn').onclick = squarify;
  $('idBtn').onclick = openInId;
  $('gmBtn').onclick = openInGoogleMaps;
  $('vertexToggle').onclick = (e) => {
    e.currentTarget.classList.toggle('on');
    drawVertices();
  };
  $('stepBtn').onclick = () => {
    const steps = [0.25, 0.5, 1, 2, 5];
    S.driftStep = steps[(steps.indexOf(S.driftStep) + 1) % steps.length];
    dbPut('kv', 'settings', S);
    paintChrome();
  };
  for (const b of document.querySelectorAll('[data-dir]')) {
    const [dx, dy] = b.dataset.dir.split(',').map(Number);
    b.onclick = () => nudge(dx * S.driftStep, dy * S.driftStep);
  }
  $('tagAdd').onclick = () => { tagDraft.push(['', '']); paintTagRows(null); };
  $('tagCancel').onclick = closeTagEditor;
  $('tagDone').onclick = commitTags;
  // Tapping the dimmed backdrop cancels, matching the settings sheet.
  $('tagSheet').onclick = (e) => { if (e.target === $('tagSheet')) closeTagEditor(); };
  $('gearBtn').onclick = openSettings;
  $('sheetClose').onclick = closeSettings;
  $('sheetSave').onclick = saveSettings;
  $('userBtn').onclick = login;
  $('uploadBtn').onclick = openQueueSheet;
  $('queueClose').onclick = closeQueueSheet;
  $('queueUpload').onclick = uploadQueue;
  $('queueSheet').onclick = (e) => { if (e.target === $('queueSheet')) closeQueueSheet(); };
  $('clearTiles').onclick = async () => {
    const before = await cacheStats().catch(() => ({ tiles: 0, ctx: 0 }));
    await dbClear('tiles');
    await dbClear('ctx');
    ctxCells.clear();
    // Rebuilding the layer is what makes the purge visible. Emptying the store on
    // its own changes nothing on screen until something happens to re-request a
    // tile, which made the button look like it had done nothing — and this button
    // exists precisely for when what is on screen is wrong.
    makeImagery();
    paintSettings();
    if (cur()) { drawContext(); paintChrome(); }
    toast('Cleared ' + before.tiles + ' tiles and ' + before.ctx +
      ' context sets, and refetching what is on screen');
  };
  $('clearDecisions').onclick = async () => {
    if (!confirm('Forget every accept/reject/later decision?')) return;
    await dbClear('decisions'); toast('Decision history cleared');
  };

  const NUDGE = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  addEventListener('keydown', (e) => {
    if ($('sheet').classList.contains('open')) return;
    if ($('tagSheet').classList.contains('open')) {
      if (e.key === 'Escape') closeTagEditor();
      return;
    }
    // TEXTAREA was missing, so typing in the paste box fired verdicts and
    // nudged the outline — an 'a' in pasted text would accept the candidate.
    const tn = e.target.tagName;
    if (tn === 'INPUT' || tn === 'SELECT' || tn === 'TEXTAREA' || e.target.isContentEditable) return;
    const k = e.key;
    if (NUDGE[k]) {
      e.preventDefault();
      const [dx, dy] = NUDGE[k];
      nudge(dx * S.driftStep, dy * S.driftStep);
      return;
    }
    const low = k.toLowerCase();
    if (low === 'a' || k === 'Enter') verdict('accept');
    else if (low === 'r' || k === 'Backspace') verdict('reject');
    else if (low === 'l' || k === ' ') { e.preventDefault(); verdict('later'); }
    else if (low === 'z') undo();
    else if (low === 'g') autoAlign();
    else if (low === 'q') squarify();
    else if (low === 'v') $('vertexToggle').click();
    else if (low === 'e') openInId();
    else if (low === 'm') openInGoogleMaps();
  });

  let sx = 0;
  const bar = $('bar');
  bar.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; }, { passive: true });
  bar.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - sx;
    if (Math.abs(dx) > 70) verdict(dx > 0 ? 'accept' : 'reject');
  });
}

(async function main() {
  db = await idb();
  const saved = await dbGet('kv', 'settings');
  if (saved) S = Object.assign({}, DEF, saved);

  // Saved settings win over DEF, so correcting the default was not enough:
  // anyone who had ever tapped Save stayed pinned to orto-proxy, which cannot
  // return a pixel-readable tile at all. Move them across once.
  let migrated = false;
  if (S.imagery === 'orto-proxy' && !S.offProxy) {
    S.imagery = DEF.imagery;
    S.offProxy = true;
    await dbPut('kv', 'settings', S).catch(() => {});
    migrated = true;
  }

  // Earlier builds cached whatever the fetch returned without checking that it
  // was a whole image, and the source truncates about one body in seven. Those
  // entries render their missing rows white and would be served from the cache
  // for the rest of the TTL, so the arriving build cannot vouch for any of them.
  // imageBlobOk now rejects them on read as well, but that leaves the first view
  // of each one white; purging once is a few seconds of refetching instead.
  if (!S.tilesChecked) {
    await dbClear('tiles').catch(() => {});
    S.tilesChecked = true;
    await dbPut('kv', 'settings', S).catch(() => {});
  }

  await initWasm();
  initMap();
  bindUI();
  await finishLogin();
  await paintUser();
  paintBuildId();
  await refreshQueueBadge();
  const n = await evictExpired();
  if (n) console.log('evicted', n, 'stale cache entries');
  setControls(false);
  if (migrated) {
    toast('Imagery moved off the budynki proxy — its CORS headers block pixel reads', 'warn');
  }
  const env = envReport();
  if (env.framed) {
    $('start').classList.add('sandboxed');
    $('emptyMsg').innerHTML = 'Preview sandbox (origin <b>null</b>) — the network is blocked here. ' +
      'Upload this file to your own https origin and open it there.';
    $('loadAreaBtn').disabled = true;
    $('randomBtn').disabled = true;
  }
  const v = await dbGet('kv', 'view');
  if (v) map.setView([v.lat, v.lon], v.z, { animate: false });
  else if (!env.framed) await loadRandom(true).catch(() => {});
  map.on('moveend', () => {
    const c = map.getCenter();
    dbPut('kv', 'view', { lat: c.lat, lon: c.lng, z: map.getZoom() });
  });
  // Only when there is nothing to review. This used to run unconditionally, so
  // a successful boot auto-load left the start panel on screen beside a live
  // candidate — contradicting ingest, which had just hidden it — and cost the map
  // a hundred pixels that Leaflet never learned about.
  if (!cur()) $('start').style.display = 'flex';
})();
