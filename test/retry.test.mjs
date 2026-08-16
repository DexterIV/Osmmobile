// Exercises the retry helpers in src/app.js. They are the only part of the
// app with non-obvious control flow that does not need a DOM, so they are
// sliced out of the source and run against a stub fetch. Slicing keeps a
// single definition of the logic — a copy here would drift from the app.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const from = src.indexOf('function classify(');
const to = src.indexOf('function markPixelsBlocked(');
assert.ok(from > 0 && to > from, 'could not locate the retry helpers in src/app.js');

let slept = [];
const scope = {
  fetch: null,
  setTimeout, clearTimeout, AbortController,
  Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
};
// Replace the real sleep with one that records the delay and returns at once,
// so the suite does not actually wait out the backoff.
const code = src.slice(from, to).replace(
  'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));',
  'const sleep = (ms) => { slept.push(Math.round(ms)); return Promise.resolve(); };');

const make = new Function('slept', 'fetch', 'setTimeout', 'clearTimeout', 'AbortController', 'Math',
  code + '; return { fetchRetry, fetchOk, backoff, transient };');

const load = (stub) => make(slept, stub, setTimeout, clearTimeout, AbortController, scope.Math);

const res = (status, body = '{}', headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => JSON.parse(body), text: async () => body,
});

let pass = 0;
const t = async (name, fn) => {
  slept = [];
  await fn();
  pass++;
  console.log('  ok  ' + name);
};

// --- retry counting -------------------------------------------------------
await t('succeeds first try, no sleeping', async () => {
  let calls = 0;
  const { fetchRetry } = load(async () => { calls++; return res(200); });
  const r = await fetchRetry('u');
  assert.equal(calls, 1);
  assert.equal(r.attempts, 1);
  assert.deepEqual(slept, []);
});

await t('retries a network error then succeeds, reports the attempt', async () => {
  let calls = 0;
  const { fetchRetry } = load(async () => {
    if (++calls < 3) throw new TypeError('Failed to fetch');
    return res(200);
  });
  const r = await fetchRetry('u', { tries: 3 });
  assert.equal(calls, 3);
  assert.equal(r.attempts, 3, 'caller must be able to see it was flaky');
  assert.equal(slept.length, 2, 'one backoff between each pair of tries');
});

await t('gives up after exactly `tries` attempts', async () => {
  let calls = 0;
  const { fetchRetry } = load(async () => { calls++; throw new TypeError('Failed to fetch'); });
  await assert.rejects(fetchRetry('u', { tries: 4 }), (e) => {
    assert.equal(e.kind, 'network');
    assert.equal(e.attempts, 4);
    return true;
  });
  assert.equal(calls, 4, 'must not fire a spare request past the limit');
});

// --- what is and is not transient ----------------------------------------
await t('a 404 is a real answer and is never retried', async () => {
  let calls = 0;
  const { fetchRetry } = load(async () => { calls++; return res(404); });
  const r = await fetchRetry('u', { tries: 3 });
  assert.equal(calls, 1);
  assert.equal(r.status, 404);
});

await t('a 503 is retried, and the last response is returned not thrown', async () => {
  let calls = 0;
  const { fetchRetry } = load(async () => { calls++; return res(503); });
  const r = await fetchRetry('u', { tries: 3 });
  assert.equal(calls, 3);
  assert.equal(r.status, 503, 'caller decides what a persistent 503 means');
});

await t('429 honours Retry-After over the computed backoff', async () => {
  let calls = 0;
  const { fetchRetry } = load(async () => {
    if (++calls === 1) return res(429, '{}', { 'retry-after': '5' });
    return res(200);
  });
  await fetchRetry('u', { tries: 2 });
  assert.equal(slept[0], 5000, 'server instruction wins when it is longer');
});

await t('Retry-After is capped so a hostile value cannot stall the app', async () => {
  const { fetchRetry } = load(async () => res(429, '{}', { 'retry-after': '99999' }));
  await fetchRetry('u', { tries: 2 });
  assert.ok(slept[0] <= 10000, 'got ' + slept[0]);
});

// --- timeout is not a CORS failure ---------------------------------------
await t('a hung request times out and is classified as timeout, not network', async () => {
  const { fetchRetry } = load((url, init) => new Promise((_, rej) => {
    init.signal.addEventListener('abort', () => rej(new Error('aborted')));
  }));
  await assert.rejects(fetchRetry('u', { tries: 1, timeout: 20 }), (e) => {
    assert.equal(e.kind, 'timeout', 'a slow network must not be reported as missing CORS');
    assert.match(e.message, /timeout after 20ms/);
    return true;
  });
});

await t('an abort signal is passed to fetch on every attempt', async () => {
  let seen = 0;
  const { fetchRetry } = load(async (url, init) => {
    if (init && init.signal) seen++;
    return res(500);
  });
  await fetchRetry('u', { tries: 3 });
  assert.equal(seen, 3);
});

await t('caller init survives alongside the injected signal', async () => {
  let got = null;
  const { fetchRetry } = load(async (url, init) => { got = init; return res(200); });
  await fetchRetry('u', { method: 'POST', body: 'x=1', mode: 'cors', tries: 2, timeout: 99 });
  assert.equal(got.method, 'POST');
  assert.equal(got.body, 'x=1');
  assert.equal(got.mode, 'cors');
  assert.ok(got.signal, 'signal must be present');
  assert.equal(got.tries, undefined, 'control options must not leak into fetch init');
  assert.equal(got.timeout, undefined);
  assert.equal(got.onAttempt, undefined);
});

// --- fetchOk --------------------------------------------------------------
await t('fetchOk throws on a persistent 503 with kind http', async () => {
  const { fetchOk } = load(async () => res(503));
  await assert.rejects(fetchOk('u', { tries: 2 }), (e) => {
    assert.equal(e.kind, 'http', 'an http status must never be mistaken for CORS');
    assert.equal(e.message, 'HTTP 503');
    return true;
  });
});

await t('onAttempt reports each failed try', async () => {
  const notes = [];
  const { fetchRetry } = load(async () => res(500));
  await fetchRetry('u', { tries: 3, onAttempt: (n, m) => notes.push(n + ':' + m) });
  assert.deepEqual(notes, ['1:HTTP 500', '2:HTTP 500']);
});

// --- backoff shape --------------------------------------------------------
await t('backoff grows and is capped', async () => {
  const { backoff } = load(async () => res(200));
  const a = backoff(1), b = backoff(2), c = backoff(3);
  assert.ok(b > a && c > b, `${a} ${b} ${c}`);
  assert.ok(backoff(20) <= 8000, 'must saturate');
});

await t('transient covers 429 and 5xx only', async () => {
  const { transient } = load(async () => res(200));
  for (const s of [429, 500, 502, 503, 504]) assert.ok(transient(s), 'should retry ' + s);
  for (const s of [200, 301, 400, 401, 403, 404, 409, 422]) assert.ok(!transient(s), 'should not retry ' + s);
});

console.log('\nretry: ' + pass + ' assertions groups passed');
