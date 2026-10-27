function initMap() {
  map = L.map('map', {
    zoomControl: false, attributionControl: true, preferCanvas: false,
    maxZoom: 22, doubleClickZoom: false, keyboard: false,
    // Opens wide rather than at review zoom. show() re-frames each candidate
    // with fitBounds, so this only affects the initial hunt for an area — and at
    // z18 the first data request covered ~150 m and came back empty.
  }).setView([52.2, 21.0], 14);
  makeImagery();
  // Below ctxLayer so the OSM footprints and the queued-ochre outlines stay
  // readable over it, and above the imagery so it is visible at all.
  pendingLayer = L.layerGroup().addTo(map);
  ctxLayer = L.layerGroup().addTo(map);
  vertexGroup = L.layerGroup().addTo(map);
  // Redrawn on pan and zoom, not just per candidate: the point of this layer is
  // to answer "where does this go next", which is a question you ask by zooming
  // out, and selecting by the visible bounds is also what keeps it cheap.
  map.on('moveend zoomend', drawPending);
  // The candidate polygon sits in Leaflet's overlay pane, above the tile grid.
  // A blank tile under its outline would otherwise lose the click to the path,
  // even though the tile itself accepts pointer events; look through the hit
  // stack for a ready tile before treating the click as a map click.
  map.on('click', (e) => {
    const oe = e.originalEvent;
    if (!oe || typeof oe.clientX !== 'number') return;
    const stack = document.elementsFromPoint(oe.clientX, oe.clientY);
    if (!stack.length || !(stack[0].classList && stack[0].classList.contains('cand'))) return;
    for (const el of stack) {
      if (el.classList && el.classList.contains('tile-retry') &&
          retryHit(el, oe.clientX, oe.clientY)) { retryBlankTile(el); break; }
    }
  });
  watchMapSize();
}

// Leaflet caches the container size and re-measures it in exactly two places:
// Map.initialize, and invalidateSize — whose only internal caller is the window
// 'resize' handler. There is no ResizeObserver anywhere in Leaflet 1.9.4.
//
// #map is absolutely positioned inside #wrap, and #wrap is a flex sibling of
// #tags and #start, so hiding the start panel, expanding it, or painting a
// different number of tag chips changes the map's height with no resize event
// anywhere. Measured at 496x822: with #start expanded Leaflet believed the map
// was 434 px tall when it was 174, and with the panel hidden it believed 434
// against a real 535 — and it was still wrong two frames later. Either sign
// hurts: too tall requests up to 2.5x the visible area from a source capped at
// six connections, and too short leaves a blank strip along the bottom.
//
// pan: false so the view is never yanked out from under the reviewer.
// debounceMoveend so the moveend this fires cannot make GridLayer request a
// screenful for the pre-fit view microseconds before fitBounds moves it.
function syncMapSize() {
  if (map && map._loaded) map.invalidateSize({ pan: false, debounceMoveend: true });
}

// Observing the element Leaflet actually measures catches every layout change,
// including the ones nobody has written yet. It also fires once on observe, so
// boot is corrected for free. rAF-coalesced because a flex reflow can report
// several times in one frame.
function watchMapSize() {
  if (!window.ResizeObserver) return;
  let queued = false;
  new ResizeObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; syncMapSize(); });
  }).observe($('map'));
}

function cur() { return candidates[cursor]; }

function setControls(on) {
  for (const el of document.querySelectorAll('#pad button, #padTools button, #bar button, #areaBtn')) {
    el.disabled = !on;
  }
  if (on) {
    $('undoBtn').disabled = !undoStack.length;
    $('sqBtn').disabled = !cur() || cur().kind !== 'building';
    if (pixelMode === 'blocked') $('autoBtn').disabled = true;
  }
}

function show() {
  const c = cur();
  if (!c) {
    cancelPrefetch();
    setControls(false);
    $('start').style.display = 'flex';
    $('emptyMsg').textContent = candidates.length
      ? 'Queue finished — ' + candidates.length + ' reviewed'
      : 'Nothing queued';
    return;
  }
  setControls(true);
  undoStack = [];
  // Layout first, fit last. paintTags changes the height of #tags, which is a
  // flex sibling of the map, so running it after fitShape — as this used to —
  // re-staled the size immediately after the fit was computed from it.
  paintTags();
  paintChrome();
  drawShape();
  drawContext();
  drawPending();
  fitShape();
  schedulePrefetch();
}

function drawShape() {
  const c = cur();
  if (shape) { map.removeLayer(shape); shape = null; }
  vertexGroup.clearLayers();
  if (!c) return;
  if (c.kind === 'building' || c.kind === 'area') {
    // Leaflet takes [outer, ...holes], so a hole is drawn as a hole rather than
    // being lost or filled in.
    const rings = [c.ring].concat((c.holes || []).filter((h) => h && h.length >= 3));
    const area = c.kind === 'area';
    shape = L.polygon(area ? rings : c.ring, {
      color: area ? '#a3e635' : '#ff2d95', weight: area ? 2 : 2.5,
      fillColor: area ? '#a3e635' : '#ff2d95', fillOpacity: area ? 0.08 : 0.12,
      className: 'cand',
    }).addTo(map);
    attachShapeDrag();
    drawVertices();
  } else {
    shape = L.circleMarker(c.ring[0], {
      color: '#ff2d95', weight: 3, radius: 11, fillColor: '#ff2d95', fillOpacity: 0.25,
    }).addTo(map);
    attachPointDrag();
  }
}

