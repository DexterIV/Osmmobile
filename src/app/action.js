let verdicting = false;
async function verdict(kind) {
  if (verdicting) return;
  verdicting = true;
  try {
    const c = cur();
    if (!c) return;
    await dbPut('decisions', c.key, { verdict: kind, t: Date.now() });
    if (kind === 'reject') reportReject(c);
    if (kind === 'accept') {
      await dbPut('queue', c.key, {
        kind: c.kind, ring: c.ring, tags: c.tags, t: Date.now(),
        // Without holes here an approved forest-island-in-farmland uploads solid.
        holes: (c.holes || []).filter((h) => h && h.length >= 3),
        moved: !!c.moved, city: c.tags['addr:city'] || '',
      });
    }
    const el = $('map');
    el.classList.add(kind === 'accept' ? 'flickR' : kind === 'reject' ? 'flickL' : 'flickU');
    setTimeout(() => el.classList.remove('flickR', 'flickL', 'flickU'), 130);
    cursor++;
    await refreshQueueBadge();
    show();
  } finally {
    verdicting = false;
  }
}

// Geometry of everything accepted but not yet uploaded. Held in memory because
// drawContext runs on every candidate and must not wait on IndexedDB, and kept in
// step here because refreshQueueBadge already runs after every verdict, after a
// drop from the review sheet, after an upload and at boot.
let queuedShapes = [];

async function refreshQueueBadge() {
  const q = await dbAll('queue');
  queuedShapes = q
    .filter((e) => e.val && Array.isArray(e.val.ring) && e.val.ring.length >= 3)
    .map((e) => ({
      key: e.key, kind: e.val.kind, ring: e.val.ring,
      holes: e.val.holes || [],
      hn: (e.val.tags && e.val.tags['addr:housenumber']) || '',
    }));
  $('upCount').textContent = q.length;
  $('uploadBtn').disabled = !q.length;
}

function osmChange(items, changesetId) {
  let id = -1;
  const create = [];

  // One node per coordinate for the whole changeset, keyed at OSM's own 7-decimal
  // limit. Adjacent land-cover parcels are conditioned upstream to share exact
  // boundary coordinates, and emitting a fresh node per ring would have thrown
  // that away — leaving duplicate coincident nodes and no shared topology, which
  // is the gap-versus-overlap problem the importer works hard to avoid. It also
  // shrinks a farmland changeset considerably.
  const nodeIds = new Map();
  const nodeFor = ([la, lo]) => {
    const key = la.toFixed(7) + ',' + lo.toFixed(7);
    let nid = nodeIds.get(key);
    if (nid === undefined) {
      nid = id--;
      nodeIds.set(key, nid);
      create.push(`<node id="${nid}" lat="${la.toFixed(7)}" lon="${lo.toFixed(7)}" changeset="${changesetId}" version="0"/>`);
    }
    return nid;
  };
  const wayFor = (ring, tagXml) => {
    const ids = ring.map(nodeFor);
    const nds = ids.concat([ids[0]]).map((r) => `<nd ref="${r}"/>`).join('');
    const wid = id--;
    create.push(`<way id="${wid}" changeset="${changesetId}" version="0">${nds}${tagXml || ''}</way>`);
    return wid;
  };

  for (const it of items) {
    const tagXml = Object.entries(it.tags).filter(([k]) => !S.dropKeys.includes(k))
      .map(([k, v]) => `<tag k="${esc(k)}" v="${esc(v)}"/>`).join('');
    if (it.kind === 'address') {
      const [la, lo] = it.ring[0];
      create.push(`<node id="${id--}" lat="${la.toFixed(7)}" lon="${lo.toFixed(7)}" changeset="${changesetId}" version="0">${tagXml}</node>`);
      continue;
    }
    const holes = (it.holes || []).filter((h) => h && h.length >= 3);
    if (!holes.length) {
      wayFor(it.ring, tagXml);
      continue;
    }
    // Holes present, so the tags belong on a type=multipolygon relation and the
    // rings stay untagged. Tagging the outer way instead would fill the hole in.
    const outer = wayFor(it.ring, '');
    const members = ['<member type="way" ref="' + outer + '" role="outer"/>'];
    for (const h of holes) {
      members.push('<member type="way" ref="' + wayFor(h, '') + '" role="inner"/>');
    }
    create.push('<relation id="' + (id--) + '" changeset="' + changesetId + '" version="0">' +
      members.join('') + '<tag k="type" v="multipolygon"/>' + tagXml + '</relation>');
  }
  return `<osmChange version="0.6" generator="orto-review"><create>${create.join('')}</create></osmChange>`;
}

