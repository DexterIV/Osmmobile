async function autoAlign() {
  const c = cur();
  if (!c) return;
  if (c.kind === 'area') {
    toast('Auto-fit correlates building edges against imagery — not meaningful for land cover');
    return;
  }
  if (c.kind !== 'building') { toast('Auto-fit works on outlines only'); return; }
  const btn = $('autoBtn');
  btn.classList.add('busy');
  try {
    const src = imagerySource();
    if (src.xyz) throw new Error('Auto-align needs a WMS source, not XYZ tiles');
    const cen = centroid(c.ring);
    let ext = 0;
    for (const [la, lo] of c.ring) {
      ext = Math.max(ext, Math.hypot((la - cen[0]) * 111320, (lo - cen[1]) * 111320 * Math.cos(cen[0] * Math.PI / 180)));
    }
    const half = Math.max(ext * 2.2, 32);
    const [cx, cy] = merc(cen[0], cen[1]);
    const scale = 1 / Math.cos(cen[0] * Math.PI / 180);
    const hm = half * scale;
    const bbox = [cx - hm, cy - hm, cx + hm, cy + hm];
    const SZ = 384;
    const url = src.url + (src.url.includes('?') ? '&' : '?') +
      'SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&CRS=EPSG:3857&FORMAT=image/jpeg' +
      '&STYLES=&LAYERS=' + encodeURIComponent(src.layers) +
      '&WIDTH=' + SZ + '&HEIGHT=' + SZ + '&BBOX=' + bbox.join(',');

    const resp = await fetchOk(url, {
      mode: 'cors', tries: 4, timeout: 20000, retryOn: transientImagery,
    });
    const bmp = await createImageBitmap(await resp.blob());
    const cv = document.createElement('canvas');
    cv.width = SZ; cv.height = SZ;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0, SZ, SZ);
    const data = g.getImageData(0, 0, SZ, SZ).data;

    const rp = wasm.alloc(data.length);
    new Uint8Array(wasm.memory.buffer, rp, data.length).set(data);
    wasm.gradientFrom(rp, SZ, SZ);
    wasm.release(rp);

    const toPx = ([la, lo]) => {
      const [x, y] = merc(la, lo);
      return [(x - bbox[0]) / (bbox[2] - bbox[0]) * SZ, (bbox[3] - y) / (bbox[3] - bbox[1]) * SZ];
    };
    let ringPx = c.ring.map(toPx);
    let p = W.f64(ringPx.flat());
    wasm.edgeSamples(p, c.ring.length, 1.0);
    wasm.alignOffset(S.maxShift, 1.0);
    let ox = wasm.outFA(), oy = wasm.outFB();
    const z = wasm.outIA() / 100;
    const gain = wasm.outIB() / 100;
    wasm.release(p);

    ringPx = ringPx.map(([x, y]) => [x + ox, y + oy]);
    p = W.f64(ringPx.flat());
    wasm.edgeSamples(p, c.ring.length, 1.0);
    wasm.alignOffset(3, 0.25);
    ox += wasm.outFA(); oy += wasm.outFB();
    wasm.release(p);

    if (z < 1.6 || gain < 1.03) {
      toast('Low confidence (z=' + fmt(z, 1) + '), left as-is — nudge by hand', 'warn');
      return;
    }
    const mppx = (bbox[2] - bbox[0]) / SZ / scale;
    pushUndo();
    const mLat = 111320, mLon = 111320 * Math.cos(cen[0] * Math.PI / 180);
    const dxm = ox * mppx, dym = -oy * mppx;
    c.ring = c.ring.map(([la, lo]) => [la + dym / mLat, lo + dxm / mLon]);
    c.moved = true;
    shape.setLatLngs(c.ring);
    drawVertices();
    paintChrome();
    toast('Shifted ' + fmt(Math.hypot(dxm, dym), 1) + ' m  ·  z=' + fmt(z, 1) + '  ·  ' + fmt(gain, 2) + '× edge gain');
  } catch (err) {
    // A tainted canvas, or a network-shaped rejection that survived every
    // retry, means CORS. A timeout or an HTTP status does not — those are
    // worth reporting but auto-fit stays available.
    if (/tainted|SecurityError/i.test(String(err)) || err.kind === 'network') {
      markPixelsBlocked('imagery server blocks pixel reads');
    } else {
      toast('Auto-fit failed: ' + String(err.message || err), 'warn');
    }
  } finally {
    btn.classList.remove('busy');
  }
}

// Guard against the same verdict firing twice — the swipe handler on #bar and
// the button onclicks both call verdict(), and on mobile a swipe also fires a
// click. verdict() is async and only advances cursor after the awaits, so two
// concurrent calls would read the same cur() and double-process one candidate,
// skipping the next.
