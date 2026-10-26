function paintChrome() {
  const c = cur();
  $('qCount').textContent = (cursor + 1) + ' / ' + candidates.length;
  $('locality').textContent = c ? (c.tags['addr:city'] || c.tags['addr:place'] || c.kind) : '';
  // The centroid index gives a first guess; real footprints from the detailed
  // cell override it, because containment is what actually decides a duplicate.
  let tier = c ? c.tier : 0;
  let note = '';
  if (c) {
    const centre = c.kind === 'address' ? c.ring[0] : c.centroid;
    const cell = ctxCells.get(ctxCellKey(centre[0], centre[1]));
    if (cell && cell !== 'loading' && cell !== 'failed') {
      const v = overlapVerdict(c, cell);
      if (v && v.tier !== null) { tier = v.tier; note = v.why; }
      const dup = duplicateAddress(c, cell);
      if (dup) { tier = 2; note = dup; }
    } else if (cell === 'loading') note = 'checking OSM…';
    else if (cell === 'failed') note = 'OSM check failed';
    // Checked last so it wins the label: overlapping something you accepted a
    // moment ago is a mistake you can still fix, where overlapping OSM might be a
    // considered decision. This check does not depend on the /map cell at all, so
    // it still reports while that is loading or after it has failed.
    const q = overlapVerdict(c, queuedNear(c), 'a building you already accepted');
    if (q && q.tier !== null) { tier = q.tier; note = q.why; }
  }
  $('tier').textContent = ['clear', 'near', 'overlap'][tier];
  $('tier').className = 'tier t' + tier;
  $('dist').textContent = note ? note
    : c && c.dist < 1e8 ? fmt(c.dist, 0) + ' m' : 'no OSM near';
  const d = c ? driftMeters() : 0;
  $('drift').textContent = d > 0.05 ? '+' + fmt(d, 1) + ' m moved' : '';
  paintSrcAge(c);
  $('stepLbl').textContent = fmt(S.driftStep, 2).replace(/0$/, '') + ' m';
}

// How old the source geometry is, and whether the registry thought the building
// was still going up. Neither is an OSM tag and neither is uploaded, but both
// change what a reviewer should conclude from the imagery:
//
//  - On v1 the tiles carried `aktualnosc_geometrii`, the currency date of the
//    outline — across 644 sampled buildings roughly half were 2018 or older and
//    a third dated from 2015, so a building demolished for a road built since
//    then was still in the data, correctly, as far as BDOT is concerned. v2
//    dropped per-object currency from the tiles (only the z5-13 aggregate bins
//    carry recent-change dates), so this shock-absorber is honestly blank now
//    rather than faking a year; treat undated geometry as possibly stale.
//  - `KATEGORIAISTNIENIA` (v2's `status_bdot`) = `w budowie` means it was under
//    construction at survey time. It may now be finished, altered, or never
//    completed, and `building=yes` is probably the wrong tag for it.
const YEAR_MS = 365.25 * 24 * 3600e3;

function paintSrcAge(c) {
  const el = $('srcAge');
  if (!c || (!c.srcDate && !c.srcStatus)) { el.textContent = ''; el.className = ''; return; }
  const parts = [];
  let cls = 'fresh';
  if (c.srcDate) {
    const t = Date.parse(c.srcDate);
    if (Number.isFinite(t)) {
      const yrs = (Date.now() - t) / YEAR_MS;
      parts.push('geom ' + c.srcDate.slice(0, 4) + ' · ' + yrs.toFixed(0) + ' yr');
      cls = yrs >= 7 ? 'stale' : yrs >= 3 ? 'aging' : 'fresh';
    } else {
      parts.push('geom ' + c.srcDate);
    }
  }
  if (c.srcStatus && c.srcStatus !== 'eksploatowany') {
    parts.push(c.srcStatus);
    cls = 'stale';
  }
  el.textContent = parts.join(' · ');
  el.className = cls;
  el.title = 'BDOT10k geometry currency' +
    (c.srcStatus ? ', status ' + c.srcStatus : '') +
    '. Not the cadastre (EGiB) — the two can disagree.';
}

function paintTags() {
  const c = cur();
  const box = $('tags');
  box.innerHTML = '';
  if (!c) return;
  const keys = Object.keys(c.tags).filter((k) => !S.dropKeys.includes(k));
  for (const k of keys) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.innerHTML = '<b>' + esc(k) + '</b>' + esc(c.tags[k]);
    // Opens the editor focused on this tag. It used to delete the tag outright
    // on a single tap, with no confirmation and no undo — far too easy to hit by
    // accident on a phone, and the only tag interaction there was.
    chip.onclick = () => openTagEditor(k);
    box.appendChild(chip);
  }
  const add = document.createElement('button');
  add.className = 'chip add';
  add.textContent = keys.length ? '+ tag' : '+ add tags';
  add.onclick = () => openTagEditor(null);
  box.appendChild(add);
}

// Keys worth one tap on a phone: what BDOT/PRG candidates routinely need
// corrected or completed against the imagery.
const TAG_PRESETS = [
  'building', 'building:levels', 'addr:housenumber', 'addr:street', 'addr:city',
  'addr:postcode', 'amenity', 'shop', 'man_made', 'note', 'fixme', 'demolished:building',
];

let tagDraft = null;   // [[key, value], ...] while the sheet is open

function openTagEditor(focusKey) {
  const c = cur();
  if (!c) return;
  tagDraft = Object.entries(c.tags).map(([k, v]) => [k, String(v)]);
  if (!tagDraft.length) tagDraft.push(['', '']);
  paintTagRows(focusKey);
  $('tagSheet').classList.add('open');
}

function closeTagEditor() {
  $('tagSheet').classList.remove('open');
  tagDraft = null;
}

function paintTagRows(focusKey) {
  const box = $('tagRows');
  box.innerHTML = '';
  const seen = new Map();
  for (const [k] of tagDraft) {
    const t = k.trim();
    if (t) seen.set(t, (seen.get(t) || 0) + 1);
  }
  tagDraft.forEach(([k, v], i) => {
    const row = document.createElement('div');
    row.className = 'tagRow';
    const ki = document.createElement('input');
    ki.className = 'k';
    ki.value = k;
    ki.placeholder = 'key';
    ki.autocapitalize = 'none';
    ki.spellcheck = false;
    if (k.trim() && seen.get(k.trim()) > 1) ki.classList.add('dup');
    ki.oninput = () => { tagDraft[i][0] = ki.value; };
    // Re-render on blur so duplicate highlighting stays honest without
    // stealing focus mid-typing.
    ki.onblur = () => paintTagRows(null);
    const vi = document.createElement('input');
    vi.value = v;
    vi.placeholder = 'value';
    vi.autocapitalize = 'none';
    vi.spellcheck = false;
    vi.oninput = () => { tagDraft[i][1] = vi.value; };
    const del = document.createElement('button');
    del.textContent = '×';
    del.title = 'Remove this tag';
    del.onclick = () => { tagDraft.splice(i, 1); paintTagRows(null); };
    row.appendChild(ki);
    row.appendChild(vi);
    row.appendChild(del);
    box.appendChild(row);
    if (focusKey !== null && k === focusKey) setTimeout(() => vi.focus(), 30);
  });

  const pre = $('tagPresets');
  pre.innerHTML = '';
  const have = new Set(tagDraft.map(([k]) => k.trim()));
  for (const k of TAG_PRESETS) {
    if (have.has(k)) continue;
    const b = document.createElement('button');
    b.textContent = '+ ' + k;
    b.onclick = () => {
      tagDraft.push([k, '']);
      paintTagRows(k);
    };
    pre.appendChild(b);
  }
}

// Draft rows to a tag object. Pure, so it can be tested without a DOM.
// A key with no value is not a tag OSM will accept and an empty key is
// meaningless, so both are dropped rather than uploaded as junk; a half-filled
// row is counted as dropped so the user is told, while a wholly blank row is
// just an unused input and is silent. On a duplicate key the last row wins,
// matching the visible top-to-bottom reading of the sheet.
function tagsFromDraft(draft) {
  const tags = {};
  let dropped = 0;
  for (const [k, v] of draft) {
    const key = String(k).trim();
    const val = String(v).trim();
    if (!key || !val) { if (key || val) dropped++; continue; }
    tags[key] = val;
  }
  return { tags, dropped };
}

function commitTags() {
  const c = cur();
  if (!c || !tagDraft) { closeTagEditor(); return; }
  const { tags: next, dropped } = tagsFromDraft(tagDraft);
  const before = JSON.stringify(c.tags);
  if (JSON.stringify(next) === before) { closeTagEditor(); return; }
  pushUndo();
  c.tags = next;
  c.tagsEdited = true;
  closeTagEditor();
  paintTags();
  paintChrome();
  toast(Object.keys(next).length + ' tags' + (dropped ? ', ' + dropped + ' incomplete dropped' : ''));
}

