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

let src: usize = 0;
let srcLen: i32 = 0;

let nId: usize = 0;
let nLat: usize = 0;
let nLon: usize = 0;
let nTagA: usize = 0;
let nTagB: usize = 0;
let nCount: i32 = 0;
let nCap: i32 = 0;

let wNdA: usize = 0;
let wNdN: usize = 0;
let wTagA: usize = 0;
let wTagB: usize = 0;
let wCount: i32 = 0;
let wCap: i32 = 0;

let refs: usize = 0;
let refCount: i32 = 0;
let refCap: i32 = 0;

let outA: i32 = 0;
let outB: i32 = 0;
let outC: f64 = 0;
let outD: f64 = 0;

export function outIA(): i32 { return outA; }
export function outIB(): i32 { return outB; }
export function outFA(): f64 { return outC; }
export function outFB(): f64 { return outD; }

export function alloc(n: i32): usize { return heap.alloc(n); }
export function release(p: usize): void { if (p) heap.free(p); }

export function setSource(p: usize, len: i32): void { src = p; srcLen = len; }

@inline function at(i: i32): i32 { return <i32>load<u8>(src + <usize>i); }

@inline function newCap(cap: i32, need: i32, floor: i32): i32 {
  if (need <= cap) return cap;
  let nc = cap < floor ? floor : cap;
  while (nc < need) nc = nc + (nc >> 1);
  return nc;
}

@inline function grow(p: usize, cap: i32, ncap: i32, unit: i32): usize {
  if (ncap == cap) return p;
  let np = heap.alloc(<usize>(ncap * unit));
  if (p) { memory.copy(np, p, <usize>(cap * unit)); heap.free(p); }
  return np;
}

@inline function ws(c: i32): bool { return c == 32 || c == 9 || c == 10 || c == 13; }

function skipToChar(i: i32, c: i32): i32 {
  while (i < srcLen && at(i) != c) i++;
  return i;
}

function attrValue(i: i32, end: i32, a0: i32, a1: i32, a2: i32, alen: i32): i32 {
  while (i < end) {
    let c = at(i);
    if (c == 62) return -1;
    if (ws(c)) {
      i++;
      if (at(i) == a0 && (alen < 2 || at(i + 1) == a1) && (alen < 3 || at(i + 2) == a2)) {
        let j = i + alen;
        while (j < end && ws(at(j))) j++;
        if (at(j) == 61) {
          j++;
          while (j < end && ws(at(j))) j++;
          if (at(j) == 34 || at(j) == 39) return j + 1;
        }
      }
      continue;
    }
    i++;
  }
  return -1;
}

function readF64(i: i32): f64 {
  let neg = false;
  if (at(i) == 45) { neg = true; i++; } else if (at(i) == 43) i++;
  let v: f64 = 0;
  while (i < srcLen) {
    let c = at(i);
    if (c < 48 || c > 57) break;
    v = v * 10 + <f64>(c - 48);
    i++;
  }
  if (i < srcLen && at(i) == 46) {
    i++;
    let s: f64 = 0.1;
    while (i < srcLen) {
      let c = at(i);
      if (c < 48 || c > 57) break;
      v += <f64>(c - 48) * s;
      s *= 0.1;
      i++;
    }
  }
  return neg ? -v : v;
}

export function parse(): i32 {
  nCount = 0; wCount = 0; refCount = 0;
  let i = 0;
  let pendingNd = -1;
  let pendingTagA = -1;
  let inWay = false;
  let wayNdStart = 0;

  while (i < srcLen) {
    if (at(i) != 60) { i++; continue; }
    let c1 = at(i + 1);

    if (c1 == 110 && at(i + 2) == 111 && at(i + 3) == 100 && at(i + 4) == 101) {
      let close = skipToChar(i, 62);
      let selfClose = at(close - 1) == 47;
      let vLat = attrValue(i + 5, close, 108, 97, 116, 3);
      let vLon = attrValue(i + 5, close, 108, 111, 110, 3);
      let vId = attrValue(i + 5, close, 105, 100, 0, 2);
      let ncN = newCap(nCap, nCount + 1, 4096);
      nId = grow(nId, nCap, ncN, 8);
      nLat = grow(nLat, nCap, ncN, 8);
      nLon = grow(nLon, nCap, ncN, 8);
      nTagA = grow(nTagA, nCap, ncN, 4);
      nTagB = grow(nTagB, nCap, ncN, 4);
      nCap = ncN;
      store<f64>(nId + <usize>(nCount << 3), vId >= 0 ? readF64(vId) : 0);
      store<f64>(nLat + <usize>(nCount << 3), vLat >= 0 ? readF64(vLat) : 0);
      store<f64>(nLon + <usize>(nCount << 3), vLon >= 0 ? readF64(vLon) : 0);
      store<i32>(nTagA + <usize>(nCount << 2), close + 1);
      store<i32>(nTagB + <usize>(nCount << 2), selfClose ? close + 1 : -1);
      if (!selfClose) pendingTagA = nCount;
      nCount++;
      i = close + 1;
      continue;
    }

    if (c1 == 47 && at(i + 2) == 110 && at(i + 3) == 111 && at(i + 4) == 100) {
      if (pendingTagA >= 0) { store<i32>(nTagB + <usize>(pendingTagA << 2), i); pendingTagA = -1; }
      i += 6;
      continue;
    }

    if (c1 == 119 && at(i + 2) == 97 && at(i + 3) == 121) {
      let close = skipToChar(i, 62);
      inWay = true;
      wayNdStart = refCount;
      pendingNd = wCount;
      let ncW = newCap(wCap, wCount + 1, 2048);
      wNdA = grow(wNdA, wCap, ncW, 4);
      wNdN = grow(wNdN, wCap, ncW, 4);
      wTagA = grow(wTagA, wCap, ncW, 4);
      wTagB = grow(wTagB, wCap, ncW, 4);
      wCap = ncW;
      store<i32>(wTagA + <usize>(wCount << 2), close + 1);
      store<i32>(wTagB + <usize>(wCount << 2), -1);
      i = close + 1;
      continue;
    }

    if (inWay && c1 == 110 && at(i + 2) == 100 && (ws(at(i + 3)) || at(i + 3) == 62)) {
      let close = skipToChar(i, 62);
      let vRef = attrValue(i + 3, close, 114, 101, 102, 3);
      let ncR = newCap(refCap, refCount + 1, 16384);
      refs = grow(refs, refCap, ncR, 8);
      refCap = ncR;
      store<f64>(refs + <usize>(refCount << 3), vRef >= 0 ? readF64(vRef) : 0);
      refCount++;
      i = close + 1;
      continue;
    }

    if (c1 == 47 && at(i + 2) == 119 && at(i + 3) == 97 && at(i + 4) == 121) {
      if (pendingNd >= 0) {
        store<i32>(wNdA + <usize>(pendingNd << 2), wayNdStart);
        store<i32>(wNdN + <usize>(pendingNd << 2), refCount - wayNdStart);
        store<i32>(wTagB + <usize>(pendingNd << 2), i);
        wCount++;
        pendingNd = -1;
      }
      inWay = false;
      i += 5;
      continue;
    }

    i++;
  }
  outA = nCount;
  outB = wCount;
  return nCount + wCount;
}

export function nodeCount(): i32 { return nCount; }
export function wayCount(): i32 { return wCount; }
export function ptrNodeId(): usize { return nId; }
export function ptrNodeLat(): usize { return nLat; }
export function ptrNodeLon(): usize { return nLon; }
export function ptrNodeTagA(): usize { return nTagA; }
export function ptrNodeTagB(): usize { return nTagB; }
export function ptrWayNdA(): usize { return wNdA; }
export function ptrWayNdN(): usize { return wNdN; }
export function ptrWayTagA(): usize { return wTagA; }
export function ptrWayTagB(): usize { return wTagB; }
export function ptrRefs(): usize { return refs; }
export function refsCount(): i32 { return refCount; }

export function spanHasKey(a: i32, b: i32, keyPtr: usize, keyLen: i32): bool {
  let i = a;
  while (i < b - 4) {
    if (at(i) == 60 && at(i + 1) == 116 && at(i + 2) == 97 && at(i + 3) == 103) {
      let close = skipToChar(i, 62);
      let v = attrValue(i + 4, close, 107, 0, 0, 1);
      if (v >= 0) {
        let ok = true;
        for (let j = 0; j < keyLen; j++) {
          if (at(v + j) != <i32>load<u8>(keyPtr + <usize>j)) { ok = false; break; }
        }
        if (ok && (at(v + keyLen) == 34 || at(v + keyLen) == 39)) { outA = i; outB = close; return true; }
      }
      i = close + 1;
      continue;
    }
    i++;
  }
  return false;
}

let gx: usize = 0;
let gy: usize = 0;
let gStart: usize = 0;
let gItems: usize = 0;
let gN: i32 = 0;
let gCols: i32 = 0;
let gRows: i32 = 0;
let gMinLat: f64 = 0;
let gMinLon: f64 = 0;
let gCell: f64 = 0;

export function indexBuild(latPtr: usize, lonPtr: usize, n: i32, cellDeg: f64): void {
  if (gStart) { heap.free(gStart); gStart = 0; }
  if (gItems) { heap.free(gItems); gItems = 0; }
  gx = latPtr; gy = lonPtr; gN = n; gCell = cellDeg;
  if (n <= 0) { gCols = 0; gRows = 0; return; }
  let miLat = load<f64>(latPtr), maLat = miLat, miLon = load<f64>(lonPtr), maLon = miLon;
  for (let i = 1; i < n; i++) {
    let la = load<f64>(latPtr + <usize>(i << 3));
    let lo = load<f64>(lonPtr + <usize>(i << 3));
    if (la < miLat) miLat = la; if (la > maLat) maLat = la;
    if (lo < miLon) miLon = lo; if (lo > maLon) maLon = lo;
  }
  gMinLat = miLat; gMinLon = miLon;
  gRows = <i32>Math.floor((maLat - miLat) / cellDeg) + 1;
  gCols = <i32>Math.floor((maLon - miLon) / cellDeg) + 1;
  let cells = gRows * gCols;
  gStart = heap.alloc(<usize>((cells + 1) << 2));
  memory.fill(gStart, 0, <usize>((cells + 1) << 2));
  for (let i = 0; i < n; i++) {
    let r = <i32>Math.floor((load<f64>(latPtr + <usize>(i << 3)) - miLat) / cellDeg);
    let c = <i32>Math.floor((load<f64>(lonPtr + <usize>(i << 3)) - miLon) / cellDeg);
    let k = r * gCols + c;
    store<i32>(gStart + <usize>((k + 1) << 2), load<i32>(gStart + <usize>((k + 1) << 2)) + 1);
  }
  for (let k = 0; k < cells; k++) {
    store<i32>(gStart + <usize>((k + 1) << 2), load<i32>(gStart + <usize>((k + 1) << 2)) + load<i32>(gStart + <usize>(k << 2)));
  }
  gItems = heap.alloc(<usize>(n << 2));
  let cur = heap.alloc(<usize>(cells << 2));
  memory.copy(cur, gStart, <usize>(cells << 2));
  for (let i = 0; i < n; i++) {
    let r = <i32>Math.floor((load<f64>(latPtr + <usize>(i << 3)) - miLat) / cellDeg);
    let c = <i32>Math.floor((load<f64>(lonPtr + <usize>(i << 3)) - miLon) / cellDeg);
    let k = r * gCols + c;
    let slot = load<i32>(cur + <usize>(k << 2));
    store<i32>(gItems + <usize>(slot << 2), i);
    store<i32>(cur + <usize>(k << 2), slot + 1);
  }
  heap.free(cur);
}

export function nearestMeters(lat: f64, lon: f64, maxMeters: f64): f64 {
  if (gN <= 0 || gCols <= 0) return 1e9;
  let mPerDegLat: f64 = 111320;
  let mPerDegLon: f64 = 111320 * Math.cos(lat * Math.PI / 180);
  let radDeg = maxMeters / mPerDegLat;
  let rings = <i32>Math.ceil(radDeg / gCell);
  if (rings < 1) rings = 1;
  let r0 = <i32>Math.floor((lat - gMinLat) / gCell);
  let c0 = <i32>Math.floor((lon - gMinLon) / gCell);
  let best: f64 = 1e30;
  for (let r = r0 - rings; r <= r0 + rings; r++) {
    if (r < 0 || r >= gRows) continue;
    for (let c = c0 - rings; c <= c0 + rings; c++) {
      if (c < 0 || c >= gCols) continue;
      let k = r * gCols + c;
      let s = load<i32>(gStart + <usize>(k << 2));
      let e = load<i32>(gStart + <usize>((k + 1) << 2));
      for (let t = s; t < e; t++) {
        let idx = load<i32>(gItems + <usize>(t << 2));
        let dLat = (load<f64>(gx + <usize>(idx << 3)) - lat) * mPerDegLat;
        let dLon = (load<f64>(gy + <usize>(idx << 3)) - lon) * mPerDegLon;
        let d = dLat * dLat + dLon * dLon;
        if (d < best) best = d;
      }
    }
  }
  return best >= 1e29 ? 1e9 : Math.sqrt(best);
}

let gradPtr: usize = 0;
let gradW: i32 = 0;
let gradH: i32 = 0;

export function gradientFrom(rgba: usize, w: i32, h: i32): usize {
  if (gradPtr) { heap.free(gradPtr); gradPtr = 0; }
  gradPtr = heap.alloc(<usize>(w * h * 4));
  gradW = w; gradH = h;
  memory.fill(gradPtr, 0, <usize>(w * h * 4));
  let lum = heap.alloc(<usize>(w * h * 4));
  for (let i = 0, n = w * h; i < n; i++) {
    let o = rgba + <usize>(i << 2);
    let r = <f32>load<u8>(o);
    let g = <f32>load<u8>(o + 1);
    let b = <f32>load<u8>(o + 2);
    store<f32>(lum + <usize>(i << 2), 0.299 * r + 0.587 * g + 0.114 * b);
  }
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let i = y * w + x;
      let tl = load<f32>(lum + <usize>((i - w - 1) << 2));
      let tc = load<f32>(lum + <usize>((i - w) << 2));
      let tr = load<f32>(lum + <usize>((i - w + 1) << 2));
      let ml = load<f32>(lum + <usize>((i - 1) << 2));
      let mr = load<f32>(lum + <usize>((i + 1) << 2));
      let bl = load<f32>(lum + <usize>((i + w - 1) << 2));
      let bc = load<f32>(lum + <usize>((i + w) << 2));
      let br = load<f32>(lum + <usize>((i + w + 1) << 2));
      let sx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
      let sy = (bl + 2 * bc + br) - (tl + 2 * tc + tr);
      store<f32>(gradPtr + <usize>(i << 2), <f32>Math.sqrt(sx * sx + sy * sy));
    }
  }
  heap.free(lum);
  return gradPtr;
}

@inline function sampleGrad(x: f64, y: f64): f32 {
  let xi = <i32>x, yi = <i32>y;
  if (xi < 0 || yi < 0 || xi >= gradW || yi >= gradH) return 0;
  return load<f32>(gradPtr + <usize>(((yi * gradW) + xi) << 2));
}

let edgePtr: usize = 0;
let edgeN: i32 = 0;

export function edgeSamples(ringPtr: usize, count: i32, stepPx: f64): i32 {
  if (edgePtr) { heap.free(edgePtr); edgePtr = 0; }
  let total = 0;
  for (let i = 0; i < count; i++) {
    let j = (i + 1) % count;
    let x0 = load<f64>(ringPtr + <usize>((i << 1) << 3));
    let y0 = load<f64>(ringPtr + <usize>(((i << 1) + 1) << 3));
    let x1 = load<f64>(ringPtr + <usize>((j << 1) << 3));
    let y1 = load<f64>(ringPtr + <usize>(((j << 1) + 1) << 3));
    let len = Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
    total += <i32>Math.max(1, Math.floor(len / stepPx));
  }
  edgePtr = heap.alloc(<usize>(total * 16));
  let k = 0;
  for (let i = 0; i < count; i++) {
    let j = (i + 1) % count;
    let x0 = load<f64>(ringPtr + <usize>((i << 1) << 3));
    let y0 = load<f64>(ringPtr + <usize>(((i << 1) + 1) << 3));
    let x1 = load<f64>(ringPtr + <usize>((j << 1) << 3));
    let y1 = load<f64>(ringPtr + <usize>(((j << 1) + 1) << 3));
    let len = Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
    let steps = <i32>Math.max(1, Math.floor(len / stepPx));
    for (let s = 0; s < steps && k < total; s++) {
      let t = (<f64>s + 0.5) / <f64>steps;
      store<f64>(edgePtr + <usize>((k << 1) << 3), x0 + (x1 - x0) * t);
      store<f64>(edgePtr + <usize>(((k << 1) + 1) << 3), y0 + (y1 - y0) * t);
      k++;
    }
  }
  edgeN = k;
  return k;
}

export function alignOffset(maxShift: i32, stride: f64): f64 {
  if (edgeN <= 0 || !gradPtr) { outC = 0; outD = 0; outA = 0; return 0; }
  let best: f64 = -1;
  let bx: f64 = 0, by: f64 = 0;
  let sum: f64 = 0, sum2: f64 = 0, cnt: f64 = 0;
  let zero: f64 = 0;
  for (let dy = -maxShift; dy <= maxShift; dy++) {
    for (let dx = -maxShift; dx <= maxShift; dx++) {
      let ox = <f64>dx * stride, oy = <f64>dy * stride;
      let s: f64 = 0;
      for (let k = 0; k < edgeN; k++) {
        s += <f64>sampleGrad(load<f64>(edgePtr + <usize>((k << 1) << 3)) + ox,
                             load<f64>(edgePtr + <usize>(((k << 1) + 1) << 3)) + oy);
      }
      s = s / <f64>edgeN;
      if (dx == 0 && dy == 0) zero = s;
      sum += s; sum2 += s * s; cnt += 1;
      if (s > best) { best = s; bx = ox; by = oy; }
    }
  }
  let mean = sum / cnt;
  let varr = sum2 / cnt - mean * mean;
  let sd = varr > 0 ? Math.sqrt(varr) : 1e-6;
  outC = bx;
  outD = by;
  outA = <i32>Math.round(((best - mean) / sd) * 100);
  outB = <i32>Math.round((zero > 0 ? (best / zero) : 0) * 100);
  return best;
}

export function ringCentroid(ringPtr: usize, count: i32): void {
  let a: f64 = 0, cx: f64 = 0, cy: f64 = 0;
  for (let i = 0; i < count; i++) {
    let j = (i + 1) % count;
    let x0 = load<f64>(ringPtr + <usize>((i << 1) << 3));
    let y0 = load<f64>(ringPtr + <usize>(((i << 1) + 1) << 3));
    let x1 = load<f64>(ringPtr + <usize>((j << 1) << 3));
    let y1 = load<f64>(ringPtr + <usize>(((j << 1) + 1) << 3));
    let f = x0 * y1 - x1 * y0;
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-12) {
    let sx: f64 = 0, sy: f64 = 0;
    for (let i = 0; i < count; i++) {
      sx += load<f64>(ringPtr + <usize>((i << 1) << 3));
      sy += load<f64>(ringPtr + <usize>(((i << 1) + 1) << 3));
    }
    outC = sx / <f64>count; outD = sy / <f64>count;
    return;
  }
  outC = cx / (3 * a);
  outD = cy / (3 * a);
}
