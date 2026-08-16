# Orto Review — project context

Single-file offline PWA for reviewing BDOT10k building outlines and PRG address points against the
GUGiK orthophoto, one object at a time, on a phone. Accepted objects upload to OpenStreetMap as
normal changesets.

Owner: DexterIV. Repo: `DexterIV/Osmmobile`. Published at
`https://dexteriv.github.io/Osmmobile/`.

## Build and run

```bash
npm install
npm run build      # asc src/core.ts -> core.wasm, inlines Leaflet + wasm base64 into index.html
npm run serve      # http://localhost:8080
npm test           # exercises the wasm kernels
```

`index.html` and `sw.js` at the repo root are **generated** — never edit them directly. Edit `src/`
and rebuild. Both are committed because GitHub Pages serves them.

`sw.js` is generated from `src/sw.js` with `__BUILD_ID__` replaced by a hash of the built
`index.html`. The build fails if that placeholder goes missing, because a byte-identical `sw.js`
means the browser never checks for an update and installed PWAs keep serving the shell they first
cached.

The build fails if any `$('someId')` in `src/app.js` has no matching `id=` in `src/shell.html`.
That check exists because a missing id previously shipped as a runtime crash.

## Layout

| path | role |
|---|---|
| `src/core.ts` | AssemblyScript: `.osm` byte scanner, uniform grid index, Sobel, drift cross-correlation |
| `src/app.js` | all application logic |
| `src/shell.html` | markup + CSS |
| `build.mjs` | compiles wasm, inlines everything, validates output |
| `src/sw.js` | service worker source; `__BUILD_ID__` is stamped at build time |
| `sw.js`, `manifest.webmanifest`, `icon-*.png` | PWA shell (`sw.js` generated) |
| `test/retry.test.mjs` | retry/timeout helpers, sliced out of `app.js` and run against a stub fetch |
| `setup.sh` | WSL bootstrap: deps, gh auth, build, push, enable Pages, serve |

## Data source — verified by reading gugik2osm's source

Base: `https://budynki.openstreetmap.org.pl`.

> **Correction, 2026-08-16.** This section used to claim that every nginx location sets
> `Access-Control-Allow-Origin: *`, so browser-side fetching works without a proxy, and that this
> "was checked in their `conf/nginx.conf`, not assumed". Reading the config was not the same as
> observing the responses, and the conclusion was wrong. **A browser cannot fetch `/sc/*`,
> `/josm_data` or `/random/` at all.** See *CORS reality* below.

| endpoint | purpose |
|---|---|
| `GET /sc/proposed_buildings?xmin&ymin&xmax&ymax` | candidate buildings, GeoJSON |
| `GET /sc/proposed_addresses?xmin&ymin&xmax&ymax` | candidate addresses, GeoJSON |
| `POST /sc/proposed_buildings/report` | body is a JSON array of ids; removes them for everyone |
| `POST /sc/proposed_addresses/report` | same |
| `GET /random/` | `{lon, lat}`, server-weighted ~95% toward areas with many pending objects |
| `GET /layers/` | available layer ids |
| `GET /josm_data?filter_by=bbox&layers=addresses_to_import,buildings_to_import&...` | `.osm` XML, fallback path |
| `/orto` | their reverse proxy in front of the GUGiK ORTO WMS, **with CORS headers** |

GeoJSON feature shape is `properties: { id, tags }` where `id` is the upstream `lokalnyid` and
`tags` are already OSM-ready. The decision store keys on `bdot:<id>` / `prg:<id>` so a verdict
sticks to the object rather than to a coordinate hash.

`LAYERS=Raster` is confirmed from their `map.js`. Not a guess.

### CORS reality, measured 2026-08-16

Counted with `curl -D -` over 8 GETs per endpoint, then confirmed in headless Edge against the real
app origin's behaviour. The browser's own console messages are quoted below.

| endpoint | `Access-Control-Allow-Origin` headers | browser can fetch? |
|---|---|---|
| `/layers/` | exactly 1 | **yes** |
| `/sc/proposed_buildings` | **2** (`*, *`), all 8 times | no |
| `/sc/proposed_addresses` | **2**, all 8 times | no |
| `/josm_data` | **0**, all 8 times | no |
| `/random/` | 0 (and the body is a 500) | no |
| `/orto/` | **1 on a 404, 2 on a 200** — see below | no, never usefully |

Chromium's console, verbatim:

- `/sc/*` and `/orto/`: *"has been blocked by CORS policy: The 'Access-Control-Allow-Origin' header
  contains multiple values '\*, \*', but only one is allowed."*
- `/josm_data` and `/random/`: *"has been blocked by CORS policy: No 'Access-Control-Allow-Origin'
  header is present on the requested resource."*

**No client-side change can fix any of this.** A duplicated header and a missing header are both
fatal to `fetch`, and retrying cannot help where the fault is deterministic — `/sc/*` fails on every
single attempt. Consequences:

- Candidate fetching over `/sc/*` and `/josm_data` is **dead from a browser**. The file picker still
  works, and a direct browser *navigation* to `/josm_data` is not CORS-restricted, so
  download-then-open is a viable route with no third party involved.
- `/orto/` tiles still **draw**, because a plain `<img>` performs no CORS check at all. What breaks
  is `fetch`, which is what the IndexedDB tile cache and auto-fit's pixel reads need. So expect
  working imagery with no offline caching and no auto-fit until this is fixed upstream.
- `/orto/`'s header count is **not** random, and an earlier note here claiming it varied per request
  was wrong — it came from counting headers and reading the status in two *separate* requests. Paired
  in a single request, 14 samples out of 14: `200` carries two headers, `404` carries one. So a
  browser's `fetch` sees either a CORS rejection or a 404, never an image. Beware this measurement
  trap when re-checking any of the above.

Diagnostics now distinguish the two with a `no-cors` retry: if the cors fetch fails and a `no-cors`
fetch to the same URL resolves, the server was reached and its headers are the fault. That
replaces the old, actively misleading "blocked or offline" for this case.

The upstream fix is theirs: an `add_header` at both `server` and `location` level, or nginx and the
application both adding it. Worth reporting to gugik2osm.

### Upstream state, measured 2026-08-16

Probed directly from the shell, so these are server-side facts. They say nothing about CORS from a
browser beyond the headers observed; Settings → **Run diagnostics** is still what confirms the
browser's view.

| endpoint | result |
|---|---|
| `/layers/` | 200, `Access-Control-Allow-Origin: *` |
| `/sc/proposed_buildings` | 200 with features, `Access-Control-Allow-Origin: *` |
| `/sc/proposed_addresses` | 200, `Access-Control-Allow-Origin: *` |
| `/random/` | **500 on every attempt** (`{"message": "Internal Server Error"}`), 5/5 then 12/12 |
| `/orto` GetMap | **404 on roughly half of all requests**, transiently |

So `/sc/*` **is** live and does send the CORS header — the old "unverified" caveat is resolved.

Two upstream faults are live and are not ours to fix:

1. **`/random/` is simply broken.** It answered 500 every single time. "Find somewhere with work"
   cannot work; the app now says so and points at *Load this area* instead of blaming the network.
2. **`/orto` is about 50% reliable.** The identical GetMap URL returns 404 then 200 with no pattern —
   12 trials gave 4/12 on `/orto` and 7/12 on `/orto/`, and a retry of a 404'd URL succeeded every
   time. The trailing slash makes no real difference; an early reading that it did was an artefact of
   this flakiness, so do not "fix" the preset URL on that basis. Because the failure arrives as a
   404, the ordinary retry policy would ignore it, which is why imagery alone uses
   `transientImagery` and four attempts.

## Why auto-fit needs the proxy

Auto-fit reads orthophoto pixels: WMS `GetMap` → `createImageBitmap` → canvas → `getImageData` →
wasm Sobel → edge cross-correlation. `getImageData` taints on a cross-origin image without CORS. The
same constraint governs the IndexedDB tile cache, which needs `fetch` and therefore CORS. On failure
the app disables auto-fit and falls back to the manual drift pad.

> **Correction, 2026-08-16.** This section used to say the direct GUGiK endpoints "may not work for
> it" and that `/orto` "adds the headers, which is why it is the default imagery source". **It is the
> other way round.** Measured in a headless browser, six tiles per source:
>
> | source | `fetch` ok | CORS-blocked | pixels |
> |---|---|---|---|
> | `orto-high` (direct GUGiK) | 6/6 | 0 | **readable** |
> | `orto-std` (direct GUGiK) | 3/6 | 0 | **readable** |
> | `orto-proxy` (budynki) | **0/6** | 2 | **never readable** |
>
> The proxy duplicates `Access-Control-Allow-Origin` on precisely the responses that carry an image —
> 14 paired samples, `200` ⇒ two headers, `404` ⇒ one header, no exceptions — so `fetch` can never
> obtain a tile through it, and neither the cache nor auto-fit can ever work. The direct endpoints
> send exactly one header on both 200 and 404. **The default is now `orto-high`.** Do not "restore"
> the proxy as the default without re-running that measurement.
>
> Tiles still *draw* through the proxy, because a plain `<img>` performs no CORS check at all, which
> is why this went unnoticed: the map looked fine while the cache and auto-fit were dead.

## Environment constraints

- **Must be served over HTTPS or from `localhost`.** Chrome restricts IndexedDB on `file://`, and
  OAuth 2 PKCE needs a registered redirect URI and a secure context.
- **Never use `localStorage`/`sessionStorage` for app data.** Everything persistent is IndexedDB:
  stores `kv`, `tiles`, `ctx`, `decisions`, `queue`. TTL eviction runs at launch.
- **An iframe with an opaque origin blocks every outbound request.** Detected at boot; the app
  disables the fetch buttons and explains rather than failing a doomed request.
- No web fonts — the tool must work offline. System stacks only.

## OSM upload

OAuth 2 PKCE, public client, no secret. Redirect URI must match exactly, lowercase host, trailing
slash: `https://dexteriv.github.io/Osmmobile/`. Scopes `read_prefs` and `write_api`. The settings
sheet shows a tappable field containing the live URL — use it rather than typing.

Changeset tags:

```
created_by=orto-review
comment=<comment> — <locality>
source=BDOT10k;PRG
hashtags=#orto-review
review_count=<objects in this changeset>
```

`import=yes` is **off by default and should stay off.** Every candidate is inspected against
imagery, so these are not automated edits and labelling them as such invites unwarranted reverts.
`hashtags` is what OSMCha and the Tasking Manager index on. Reviewing each object does **not** make
this "not an import" in the wiki's sense — the geometry still originates from BDOT10k, so the Import
Guidelines still apply: announce in the Polska category on community.openstreetmap.org, use a
separate account, one locality per changeset.

Upstream reject reporting is **off by default** and destructive for other mappers. It is for objects
that should never be imported, not for "can't tell from this imagery" — that is what **Later** is
for.

## Regressions to not reintroduce

Each of these shipped once and was caught by testing:

1. **XML numeric character references.** `&#243;` must decode to `ó` before re-escaping, or every
   Polish street name with a diacritic uploads as `Kr&amp;#243;tka`.
2. **Shoelace centroid precision.** Computing area/centroid on raw degrees near 21.2/52.1 loses
   about seven significant digits to cancellation. Translate the ring to a local frame off its first
   vertex first.
3. **Wasm growth-capacity mismatch.** `grow()` and its call sites must derive capacity from the
   same `newCap(cap, need, floor)` helper. Divergent floors allocated 4× less than the recorded
   capacity and wrote past the buffer at ~40k buildings.
4. **Keymap collision.** `A` cannot be both *accept* and WASD-left. Nudging is the arrow keys, and
   Leaflet is constructed with `keyboard: false` so it does not pan underneath.
5. **Unguarded `cur()`.** Every candidate-dependent function must early-return when there is no
   current candidate, because keyboard handlers bypass `disabled` buttons.
6. **A frozen service worker.** `sw.js` had a hardcoded cache name and cache-first navigation, so
   the first `index.html` an installed PWA cached was the last one it ever ran. Every deploy after
   that was invisible on the device. The cache name now carries the build hash and the fetch handler
   is stale-while-revalidate.
7. **Treating a flaky network as blocked CORS.** A dropped request, a 5xx and a missing
   `Access-Control-Allow-Origin` all surface as the same opaque `fetch` rejection. Conflating them
   latched `pixelMode = 'blocked'` on the first mobile-data blip, which disabled auto-fit for the
   session *and* made every later tile bypass the IndexedDB cache. Missing CORS may only be inferred
   from the one pattern that implies it — a network-shaped `fetch` failure on a tile that a plain
   `<img>` then loads — and never from a timeout or an HTTP status.

## Measured performance, and an honest caveat

On a 17.2 MB / 45k-candidate synthetic package: wasm parse 459 ms, centroids 52 ms, keys 37 ms.
Grid index over 40k points 2 ms; 45k nearest-neighbour queries 36 ms. Sobel on 384×384 7.6 ms.
`alignOffset` with a 17×17 search over 320 edge samples 0.49 ms, which recovered a known 3 px
offset with a ~40× edge-gain.

**The wasm is not the speed win it was intended to be.** The same correlation loop in plain JS ran
0.60 ms — 1.2× slower — and a JS regex scan parsed faster than the wasm scanner. V8 JITs tight
typed-array loops very well. What actually mattered was the flat-array memory layout with tag
positions as byte offsets into the source string, keeping 45k candidates at ~184 MB RSS instead of
the several hundred MB a DOM tree needs, which is what gets a mobile tab killed. That layout is
language-independent. **The gap is expected to be wider on a mid-range Android than on desktop V8,
but that was never measured.** Do not describe the wasm as a large speedup.

## Open work

- Run diagnostics from the real origin and confirm `imagery` reports pixels readable. Published at
  `https://dexteriv.github.io/Osmmobile/` and serving; `/sc/*` and `/layers/` are confirmed live
  server-side, `/random/` is confirmed broken, `/orto` is confirmed ~50% flaky.
- Decide what to do about `/random/` being 500. Either report it upstream or drop the button.
- The `~50%` figure for `/orto` came from 24 requests on one connection. If it is really load
  dependent rather than random, jittered retries may be making it worse, not better — worth
  measuring per-tile attempt counts on a real screenful before trusting `TILE_TRIES = 4`. Replaying
  the shipped policy over 20 distinct tiles did give 20/20 loaded from 28 requests, 1.40 attempts
  each, no blanks — but that was one desktop connection, not a phone on mobile data.
- Tune the auto-fit confidence gate. Currently refuses below z=1.6; untested against real
  orthophoto over tree cover and snow.
- Addresses currently upload as standalone nodes. Merging an address into an existing OSM building
  when one clearly contains it would be more correct, and needs modifying an existing way rather
  than creating one.
- `streets` is an available upstream layer and is not used at all.
- `/lod1/not_in/osm/` exists upstream and could supply building heights.
