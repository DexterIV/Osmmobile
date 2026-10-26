// Orto Review — review BDOT10k buildings and PRG addresses against the GUGiK
// orthophoto, one object at a time, and upload the good ones to OpenStreetMap.
// Copyright (C) 2026 DexterIV
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU General Public License as published by the Free Software
// Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see the GNU General Public
// License for more details: https://www.gnu.org/licenses/
//
// Source: https://github.com/DexterIV/Osmmobile

const R = 6378137;
const DEF = {
  apiBase: 'https://budynki.openstreetmap.org.pl',
  reportRejects: false,
  // The direct GUGiK endpoints, not the budynki proxy. Measured in a browser:
  // orto-high fetched 6/6 tiles with pixels readable, orto-std 3/6 readable,
  // and orto-proxy 0/6 — the proxy duplicates Access-Control-Allow-Origin on
  // exactly the responses that carry an image, so fetch can never obtain one.
  imagery: 'orto-high',
  customUrl: '',
  customLayers: '',
  tileTTLdays: 7,
  ctxTTLhours: 24,
  batchSize: 100,
  comment: 'Buildings and addresses from BDOT10k/PRG',
  source: 'BDOT10k;PRG',
  // Points at the source rather than a hashtag that says nothing.
  repo: 'https://github.com/DexterIV/Osmmobile',
  // Land cover is off until a server is set. Buildings never consult either.
  lcServer: '',
  lcOff: [],
  importTag: false,
  clientId: '',
  maxShift: 8,
  driftStep: 0.5,
  clearRadius: 50,
  dropKeys: [],
  // Set once the one-time move off orto-proxy has happened, so choosing it
  // again by hand is respected rather than silently undone on every launch.
  offProxy: false,
  // Set once the tile cache has been purged of bodies stored before the build
  // that started checking them for completeness. Same shape as offProxy: a
  // one-time migration that must not repeat on every launch.
  tilesChecked: false,
};

const PRESETS = {
  // Kept only so it can be re-tested if the header duplication is ever fixed
  // upstream. Tiles do draw through it, because a plain <img> performs no CORS
  // check, but nothing that needs fetch will work.
  'orto-proxy': {
    name: 'Ortophoto via budynki proxy (CORS broken)',
    url: 'https://budynki.openstreetmap.org.pl/orto',
    layers: 'Raster',
    attr: 'GUGiK / budynki.osm.org.pl',
  },
  'orto-std': {
    name: 'Ortophoto standard',
    url: 'https://mapy.geoportal.gov.pl/wss/service/PZGIK/ORTO/WMS/StandardResolution',
    layers: 'Raster',
    attr: 'GUGiK',
  },
  'orto-high': {
    name: 'Ortophoto high-res',
    url: 'https://mapy.geoportal.gov.pl/wss/service/PZGIK/ORTO/WMS/HighResolution',
    layers: 'Raster',
    attr: 'GUGiK',
  },
  'orto-archive': {
    name: 'Ortophoto (archival)',
    url: 'https://mapy.geoportal.gov.pl/wss/service/PZGIK/ORTO/WMS/StandardResolutionTime',
    layers: 'Raster',
    attr: 'GUGiK',
  },
  osm: { name: 'OSM Carto', xyz: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attr: 'OpenStreetMap' },
};

let S = Object.assign({}, DEF);
let wasm = null;
let db = null;
// 'unknown' until probeImagery says otherwise; 'blocked' once it has three
// independent signals that the source's CORS headers are unusable. Nothing on
// the per-tile path may set this — see probeImagery for why.
let pixelMode = 'unknown';

const $ = (id) => document.getElementById(id);
const fmt = (n, d = 1) => Number(n).toFixed(d);

function toast(msg, kind) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'show' + (kind ? ' ' + kind : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = ''), 3200);
}

function merc(lat, lon) {
  const x = (lon * Math.PI / 180) * R;
  const y = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * R;
  return [x, y];
}
function unmerc(x, y) {
  const lon = (x / R) * 180 / Math.PI;
  const lat = (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI;
  return [lat, lon];
}
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('ortoreview', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const s of ['kv', 'tiles', 'ctx', 'decisions', 'queue']) {
        if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function tx(store, mode) {
  return db.transaction(store, mode).objectStore(store);
}
function dbGet(store, key) {
  return new Promise((res, rej) => {
    const r = tx(store, 'readonly').get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function dbPut(store, key, val) {
  return new Promise((res, rej) => {
    const r = tx(store, 'readwrite').put(val, key);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });
}
function dbDel(store, key) {
  return new Promise((res) => {
    const r = tx(store, 'readwrite').delete(key);
    r.onsuccess = () => res();
    r.onerror = () => res();
  });
}
function dbAll(store) {
  return new Promise((res, rej) => {
    const out = [];
    const r = tx(store, 'readonly').openCursor();
    r.onsuccess = () => {
      const c = r.result;
      if (!c) return res(out);
      out.push({ key: c.key, val: c.value });
      c.continue();
    };
    r.onerror = () => rej(r.error);
  });
}
function dbClear(store) {
  return new Promise((res) => {
    const r = tx(store, 'readwrite').clear();
    r.onsuccess = () => res();
    r.onerror = () => res();
  });
}

// Deliberately a cursor rather than dbAll. dbAll accumulates every value it
// walks, so reading the timestamps off a week of cached tiles pulled every one of
// their blobs into JS memory — a boot-path spike of tens of megabytes on the one
// device where a killed tab is the likely outcome.
function dbEvict(store, maxAge, now) {
  return new Promise((res) => {
    let n = 0;
    const r = tx(store, 'readwrite').openCursor();
    r.onsuccess = () => {
      const c = r.result;
      if (!c) return res(n);
      const t = c.value && c.value.t;
      if (!t || now - t > maxAge) { c.delete(); n++; }
      c.continue();
    };
    r.onerror = () => res(n);
  });
}

async function evictExpired() {
  const now = Date.now();
  return await dbEvict('tiles', S.tileTTLdays * 86400e3, now) +
    await dbEvict('ctx', S.ctxTTLhours * 3600e3, now);
}

async function cacheStats() {
  const t = await dbAll('tiles');
  let bytes = 0;
  for (const e of t) bytes += e.val.blob ? e.val.blob.size : 0;
  const c = await dbAll('ctx');
  return { tiles: t.length, bytes, ctx: c.length };
}

async function initWasm() {
  const bin = Uint8Array.from(atob(WASM_B64), (c) => c.charCodeAt(0));
  const mod = await WebAssembly.instantiate(bin, {
    env: {
      abort: (m, f, l, c) => { throw new Error('wasm abort ' + l + ':' + c); },
      seed: () => Date.now(),
    },
  });
  wasm = mod.instance.exports;
}

const W = {
  bytes(str) {
    const enc = new TextEncoder().encode(str);
    const p = wasm.alloc(enc.length);
    new Uint8Array(wasm.memory.buffer, p, enc.length).set(enc);
    return [p, enc.length];
  },
  f64(arr) {
    const p = wasm.alloc(arr.length * 8);
    new Float64Array(wasm.memory.buffer, p, arr.length).set(arr);
    return p;
  },
  view64(ptr, n) { return new Float64Array(wasm.memory.buffer, ptr, n); },
  view32(ptr, n) { return new Int32Array(wasm.memory.buffer, ptr, n); },
};

let RAW = '';
let candidates = [];
let cursor = 0;
let ctxIndexReady = false;

