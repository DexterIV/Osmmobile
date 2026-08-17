// The tag editor writes straight into what gets uploaded to OSM, so the step
// that turns edited rows into tags is worth pinning down: a stray empty key or
// an untrimmed value would otherwise become a real changeset.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const from = src.indexOf('function tagsFromDraft(');
const to = src.indexOf('function commitTags(');
assert.ok(from > 0 && to > from, 'could not locate tagsFromDraft in src/app.js');
const { tagsFromDraft } = new Function(src.slice(from, to) + '; return { tagsFromDraft };')();

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

t('keeps complete rows', () => {
  const r = tagsFromDraft([['building', 'house'], ['building:levels', '2']]);
  assert.deepEqual(r.tags, { building: 'house', 'building:levels': '2' });
  assert.equal(r.dropped, 0);
});

t('trims whitespace on both key and value', () => {
  const r = tagsFromDraft([['  building ', ' house  ']]);
  assert.deepEqual(r.tags, { building: 'house' });
});

t('drops a key with no value, and says so', () => {
  const r = tagsFromDraft([['building', 'house'], ['amenity', '']]);
  assert.deepEqual(r.tags, { building: 'house' });
  assert.equal(r.dropped, 1, 'a half-filled row should be reported');
});

t('drops a value with no key, and says so', () => {
  const r = tagsFromDraft([['', 'orphan']]);
  assert.deepEqual(r.tags, {});
  assert.equal(r.dropped, 1);
});

t('a wholly blank row is silent, not reported as dropped', () => {
  const r = tagsFromDraft([['building', 'yes'], ['', ''], ['  ', ' ']]);
  assert.deepEqual(r.tags, { building: 'yes' });
  assert.equal(r.dropped, 0, 'an unused input is not a lost tag');
});

t('a whitespace-only value counts as no value', () => {
  const r = tagsFromDraft([['note', '   ']]);
  assert.deepEqual(r.tags, {});
  assert.equal(r.dropped, 1);
});

t('on a duplicate key the last row wins', () => {
  const r = tagsFromDraft([['building', 'yes'], ['building', 'garage']]);
  assert.deepEqual(r.tags, { building: 'garage' }, 'top-to-bottom reading of the sheet');
});

t('values with = and ; survive intact', () => {
  // Both are meaningful inside OSM values and must not be treated as syntax.
  const r = tagsFromDraft([['opening_hours', 'Mo-Fr 08:00-16:00; Sa off'], ['source', 'a=b']]);
  assert.equal(r.tags.opening_hours, 'Mo-Fr 08:00-16:00; Sa off');
  assert.equal(r.tags.source, 'a=b');
});

t('unicode keys and values are untouched', () => {
  const r = tagsFromDraft([['addr:street', 'Krótka'], ['name', 'Żółw']]);
  assert.equal(r.tags['addr:street'], 'Krótka');
  assert.equal(r.tags.name, 'Żółw');
});

t('an empty draft yields no tags rather than throwing', () => {
  const r = tagsFromDraft([]);
  assert.deepEqual(r.tags, {});
  assert.equal(r.dropped, 0);
});

t('non-string values are coerced, not dropped', () => {
  // building_levels arrives from the vector tiles as a number.
  const r = tagsFromDraft([['building:levels', 8]]);
  assert.deepEqual(r.tags, { 'building:levels': '8' });
});

console.log('\ntags: ' + pass + ' groups passed');
