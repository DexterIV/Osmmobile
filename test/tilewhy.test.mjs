// The reason and placeholder helpers are pure except for navigator, so they can
// be sliced out of imagery.js and checked without a DOM or Leaflet. The SVG is
// asserted after decoding its data URI: it is markup, and an unescaped reason or
// hint would break the whole tile rather than just its label.
import assert from 'node:assert/strict';
import { readApp } from '../src/app/source.mjs';

const src = readApp();
const from = src.indexOf('function tileWhy(');
const to = src.indexOf('function showBlankTile(');
assert.ok(from > 0 && to > from, 'could not locate the tile reason helpers in the app sources');
const { tileWhy, preferErr, blankTileImage } =
  new Function(src.slice(from, to) + '; return { tileWhy, preferErr, blankTileImage };')();

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

t('timeouts, statuses and network failures become short reasons', () => {
  assert.equal(tileWhy({ kind: 'timeout', message: 'timeout after 10000ms' }, true), 'timed out');
  assert.equal(tileWhy({ kind: 'http', message: 'HTTP 502' }, true), 'HTTP 502');
  assert.equal(tileWhy({ kind: 'http', message: 'bad gateway' }, true), 'server error');
  assert.equal(tileWhy({ kind: 'network', message: 'Failed to fetch' }, true), 'network error');
  assert.equal(tileWhy({ kind: 'network', message: 'Failed to fetch' }, false), 'offline');
  assert.equal(tileWhy(new Error('image failed'), false), 'offline');
  assert.equal(tileWhy({ kind: 'http', message: 'HTTP 502' }, false), 'HTTP 502');
  assert.equal(tileWhy(new Error('incomplete image body'), true), 'incomplete image');
  assert.equal(tileWhy(new Error('tile failed'), true), 'image failed');
  assert.equal(tileWhy(null, true), 'imagery failed');
});

t('the fetch error survives the less informative <img> failure', () => {
  const http = { kind: 'http', message: 'HTTP 502' };
  const image = new Error('image failed');
  assert.equal(preferErr(http, image), http);
  assert.equal(preferErr(image, { kind: 'timeout', message: 'timeout' }).kind, 'timeout');
  assert.equal(preferErr(null, image), image);
  assert.equal(preferErr(http, { kind: 'network', message: 'Failed to fetch' }), http);
});

t('the placeholder names the reason and only offers RETRY when ready', () => {
  const waiting = decodeURIComponent(blankTileImage('HTTP 502', 'auto-retrying', false));
  assert.match(waiting, /HTTP 502/);
  assert.match(waiting, /auto-retrying/);
  assert.doesNotMatch(waiting, />RETRY</);

  const ready = decodeURIComponent(blankTileImage('timeout & <x>', 'tap to retry', true));
  assert.match(ready, /timeout &amp; &lt;x&gt;/);
  assert.match(ready, /tap to retry/);
  assert.match(ready, />RETRY</);

  const long = decodeURIComponent(blankTileImage('x'.repeat(40), '', false));
  assert.match(long, /x{21}\.\.\./);
});

console.log('\ntilewhy: ' + pass + ' groups passed');
