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
| `test/order.test.mjs` | `nearestChain`, sliced out likewise, against a stub `metresBetween` |
| `test/mvt.test.mjs` | the hand-written vector-tile decoder, against real captured tiles |
| `test/context.test.mjs` | overlap and duplicate-address verdicts, against real OSM footprints |
| `test/tags.test.mjs` | the tag editor's draft-to-tags normalisation |
| `test/parse.test.mjs` | the wasm `.osm` scanner, against a real captured `/josm_data` response |
| `test/fixtures/` | live captures: a `/josm_data` export, z14 buildings and z6 cluster tiles, an OSM `/map` cell |
| `setup.sh` | WSL bootstrap: deps, gh auth, build, push, enable Pages, serve |
| `LICENSE` | GPL-3.0, verbatim from gnu.org — do not retype it |

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
| `/orto` | their reverse proxy in front of the GUGiK ORTO WMS. **Its CORS headers are broken — see below** |
| `GET /tiles/{z}/{x}/{y}.pbf` | **the only candidate source a browser can read.** MVT, one CORS header |

### Vector tiles are the working data path

Because `/sc/*` and `/josm_data` are unreadable from a browser (below), candidates come from the
vector tiles instead. `/tiles/{z}/{x}/{y}.pbf` sends `Access-Control-Allow-Origin` exactly once and
carries the same BDOT10k geometry with OSM-ready tags. The served pyramid, checked directly:

| zoom | layer | contents |
|---|---|---|
| ≤10 | `buildings_clustered` | points with `no_of_points`; used to find somewhere with work |
| 11–12 | `buildings_centroids` | points, no properties |
| 13–14 | `buildings` | full polygons plus tags |

`maxzoom` is **14** — z15 and above return 404. An earlier note here read those 404 pages as tiles
because it only looked at response size, not status; always check the status.

- **Tags.** The layer carries BDOT metadata (`status_bdot`, `funkcja_*`, `aktualnosc_*`, `lokalnyid`)
  beside genuine OSM tags. Only `building`, `amenity`, `man_made`, `leisure`, `historic`, `tourism`
  and `building_levels`→`building:levels` are promoted, plus `source:building=BDOT`, which is exactly
  what `/josm_data` emits for the same object. `lokalnyid` becomes `srcId`, so a verdict reached
  through tiles and one reached through a file key on the same `bdot:<id>`.
- **Precision.** MVT quantises to a 4096 grid, so at z14 outlines sit on a **~37 cm** grid (±18 cm
  per vertex). That is below BDOT10k's own positional accuracy, but it is not the official geometry,
  and the app says `±37 cm from tiles` on every load rather than hiding it. Exact geometry needs the
  `/josm_data` download route.
- **Clipping.** MVT clips polygons at tile edges. About 4.6% of features touch an edge (10 of 217
  sampled); deduplicating by `lokalnyid` across neighbouring tiles recovers most, because a polygon
  cut in one tile is usually whole in the next. Any that remain cut are **skipped, not uploaded** — a
  clipped outline is the wrong shape, and the count is reported.
- **No addresses.** The upstream style references `addresses`, `addresses_clustered` and
  `addresses_geomonly`, but **none are generated** — zero address features across 40 tiles in ten
  cities. Addresses are buildings-only territory for the in-app path; they need the file or paste
  route. Re-check this before assuming addresses are unavailable forever.
- `/random/` is **not used**. `buildings_clustered` answers the same question, weighted by how much
  work is actually there, from a readable endpoint. One z6 tile is ~110 KB, covers a large slice of
  Poland, and is cached in the `ctx` store, so it is fetched one at a time rather than country-wide.

GeoJSON feature shape is `properties: { id, tags }` where `id` is the upstream `lokalnyid` and
`tags` are already OSM-ready. The decision store keys on `bdot:<id>` / `prg:<id>` so a verdict
sticks to the object rather than to a coordinate hash.

`LAYERS=Raster` is confirmed from their `map.js`. Not a guess.

## What is already in OSM — the review's other half

A candidate cannot be judged without knowing what is mapped there already. This used to be one
Overpass query per area returning building **centroids** (`out center`), drawn as cyan dots, with the
`clear`/`near`/`overlap` tier computed from centroid distance. That was not enough, in two ways that
both produced false "clear" verdicts:

- A large existing building's centroid can be 30 m away while its footprint **covers the candidate
  completely**. Distance to a centroid says nothing about containment.
- The query fetched **no address nodes at all**, so every PRG address was judged with no idea whether
  that house number was already mapped.

Real geometry is now fetched for a ~300 m cell around the candidate on screen, snapped to a grid so
neighbouring candidates share a cell, cached in the `ctx` store under `osmctx/<cell>`.

**Source is the OSM API `/api/0.6/map`, not Overpass.** Overpass answered the identical cell query
with `504 Gateway Timeout` twice in a row under load, where `/map` returned in 0.25–0.32 s on four
consecutive tries. `/map` is also authoritative and current, echoes the request Origin so CORS works,
and its XML goes through the wasm scanner the app already has. Its 50 000-node ceiling rules it out
for the whole 3 km candidate box — that returns `400 too many nodes` — but a 300 m cell holds about
1 100 nodes and 283 KB. Per-cell, not up front: the same area from Overpass with full geometry was
4.2 MB.

`/map` returns every node of any way **touching** the box, so footprints straddling a cell edge
arrive whole and geometry legitimately extends outside the requested bbox. Do not "fix" that by
clipping.

Only ways actually tagged `building` become footprints; `/map` returns everything in the box, and
drawing every closed way would put car parks and hedges on screen as though they were buildings.

The verdict then comes from geometry, not distance: containment **either way** counts as an overlap,
since a candidate inside an existing footprint is a duplicate and so is an existing building sitting
inside the candidate. For addresses, the same house number within 30 m — on a node or on a building —
reports as already mapped, and the street is compared when both sides have one, because number 5
exists on every street in town. The number is echoed as tagged, not lowercased.

Verified in a browser: a cell loads in ~190 ms with 47 footprints, a candidate copied onto a real
footprint reads `covered by an OSM building`, the duplicate check reports `5 already in OSM here`,
and 53 dashed footprints plus house-number labels draw on screen.

### Review order walks to the nearest candidate

`orderCandidates` used to sort on tier, then latitude, then longitude, which made consecutive
candidates near in latitude and **arbitrary in longitude** — so essentially every step was a teleport.
That is not only a feel problem: a teleport makes Leaflet discard the whole screenful and refetch, where
a short step keeps the tiles it has and fetches only the newly exposed edge, and anything it does refetch
is likely already in the IndexedDB cache. On an origin capped at six connections at 1–4 s per tile, that
is the difference between waiting for a screenful and waiting for an edge.

`nearestChain` walks the batch greedily to the nearest unvisited candidate. A uniform grid of ~65 m
cells — about a screen at review zoom, which is the scale at which two candidates share tiles — keeps it
affordable: the search expands ring by ring from the current cell and touches a handful of cells per
step. Ring *r+1* is checked after a hit in ring *r*, because a candidate just across a cell boundary can
be nearer than one in the far corner of the cell that hit; and a full scan is the fallback beyond 64
rings, so a sparse area cannot drop the rest of the queue.

Measured on a shuffled 164-object field, step distance between consecutive candidates:

| | latitude then longitude | nearest-neighbour |
|---|---|---|
| mean | 181 m | **72 m** |
| median | 38 m | 38 m |
| **p90** | 300 m | **41 m** |
| steps over 100 m | **28** | **1** |

The single remaining long step is the unavoidable hop to a detached cluster. p90 of 41 m means nine
steps in ten stay inside a screen at review zoom.

**Tier no longer participates in the order, and this was measured rather than assumed.** Chaining each
tier separately fragments one sweep into three interleaved ones, and the concatenation adds a long jump
at each seam — steps over 100 m went from 1 to 16 on the same field. Nothing was lost: no code ever
depended on the *order*, only on `c.tier` as a display label, and `paintChrome` overrides that with the
real geometric verdict from the `/map` cell as soon as it arrives. The centroid-distance tier was already
documented above as "not enough" on its own.

Two properties of greedy nearest-neighbour worth knowing before someone "fixes" them:

- **It backtracks.** Greedy can corner itself and need one long step back to a region it walked past.
  One backtrack per batch is not worth a 2-opt pass, so `test/order.test.mjs` asserts on how *rare* long
  steps are rather than on the maximum.
- **On a perfectly regular grid it ties with latitude order**, because sorting a regular grid by
  (lat, lon) already produces a clean raster scan. The first version of the test used a regular grid and
  therefore asserted nothing. Real buildings are irregular, which is where latitude order falls apart, so
  the test jitters by about a third of the pitch — enough to break row alignment, not enough to turn the
  field into noise and start measuring the input instead of the code.

### What you have already accepted is drawn too

Accepted objects are not in OSM yet, so they are absent from the `/map` cell that supplies the cyan
footprints, and nothing drew them: the only way to notice that a candidate overlapped one you accepted a
moment ago was to remember it. Reported as *"when adding buildings i cant see previously added building
on a map so i can get overlaying"*.

Queued objects within 250 m of the candidate are now drawn in **ochre** (`#e0a326`, dashed `6,2`),
distinct from the pink candidate and the cyan OSM footprints, and `queuedShapes` is kept in step by
`refreshQueueBadge`, which already runs after every verdict, after a drop from the review sheet, after an
upload and at boot.

They also feed `overlapVerdict`, which took a `{ways:[{ring,hn}]}` cell and so needed only a label
parameter to report *"covered by a building you already accepted"* instead of *"an OSM building"*. That
check runs **last**, so it wins the label: overlapping something you accepted a moment ago is a mistake
you can still fix, where overlapping OSM may be a considered decision. It also does not depend on the
`/map` cell, so it still reports while that is loading or after it has failed.

Verified with three ingested candidates: the first reads `clear` with nothing queued; the second, which
overlaps it, reads `overlap` with one ochre polygon on the map and *"covered by a building you already
accepted"*; the third, 1.2 km away, draws no ochre at all.

**Land-cover areas are drawn but excluded from the check**, for the reason `overlapVerdict` already skips
them — a farmland parcel containing a barn is not a duplicate of the barn.

### And so is everything still queued for review

Candidates still ahead in the queue are drawn faint — the same pink as the current one but thin, dashed
and mostly transparent, so it reads as "not this one yet" rather than competing with it. Asked for as
*"display all suspected buildings … so we know where prolly we will jump to next"*, and it pairs with the
ordering above: what you see nearby genuinely is what comes next now.

Selected by the **visible bounds** rather than a fixed radius, and redrawn on `moveend`/`zoomend`, because
the question it answers is one you ask by zooming out. Capped at 400 polygons. Measured 3 drawn at review
zoom, 63 at z17 and 143 at z14 on a 164-object batch.

## Provenance and staleness — why demolished buildings are still in the data

The candidates are **BDOT10k** (GUGiK's 1:10 000 topographic database) for buildings and **PRG** for
addresses, ingested by gugik2osm and diffed against OSM. They are **not** *ewidencja budynków* /
**EGiB**, the county-maintained cadastre, which is usually more current. The two disagree, and BDOT
being behind is the normal case rather than a fault.

The tiles carry a per-building currency date, `aktualnosc_geometrii`, and a separate
`aktualnosc_atrybutow` for the attributes. Measured over 644 buildings sampled from 15 Polish cities:

| geometry year | share | | attribute year | share |
|---|---|---|---|---|
| 2011–2014 | 9.0% | | 2011–2019 | 13.9% |
| **2015** | **32.8%** | | 2020 | 21.9% |
| 2017–2018 | 16.4% | | 2021–2022 | 26.7% |
| 2019–2020 | 5.6% | | 2023 | 26.7% |
| 2021–2022 | 19.1% | | 2024 | 10.7% |
| 2023–2024 | 17.1% | | | |

So roughly **half the geometry is 2018 or older and a third dates from 2015**. A building demolished
for a road built since then is still present, and correctly so as far as BDOT is concerned. This is
the explanation for the reported case of buildings near a new highway that EGiB no longer shows.

`status_bdot` is also worth attention: 632 of the 644 were `eksploatowany`, but **12 were
`w budowie`** — under construction at survey time. Those may now be finished, altered, or never
completed, and `building=yes` is probably the wrong tag for them.

Both fields are now **shown while reviewing** — `#srcAge` in the top strip, dim under 3 years, ochre
from 3, red from 7, and red for any status other than `eksploatowany`. Neither is uploaded: they are
not OSM tags, and `tagsFromTile` promotes only the OSM keys. There is a regression test for that in
the browser check (`tagsHaveBdotMeta` must stay `no`).

Upstream publishes no freshness metadata of its own — `/processes.json` and `/updates.geojson` both
return an empty body — so this per-object date is the only signal available.

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

- Candidate fetching over `/sc/*` and `/josm_data` is **dead from a browser**, and `fetchArea` — which
  read both — has been deleted rather than left to fail. Buildings now come from the vector tiles
  above, which is what makes **Load this area** work at all. For addresses and for exact geometry
  there are three further routes, none needing a third party: **Get this area's data** (opens the
  `/josm_data` bbox URL in a new tab — a *navigation* is not CORS-restricted), the **paste box**, and
  the **file picker**. A CORS proxy would restore one-tap loading of everything but would put every
  candidate fetch and the user's IP through someone else's server, so it is deliberately not
  implemented.
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

### Candidates are sparse — small bboxes return nothing

`/josm_data` answers `<osm version="0.6"/>`, exactly 20 bytes, for any box without pending objects,
and that is most boxes. Around 52.2/21.0:

| requested span | bytes | nodes | ways |
|---|---|---|---|
| ~0.0015° (a z18 viewport) | **20** | 0 | 0 |
| ~0.006° (z16) | **20** | 0 | 0 |
| 0.024° (z14) | 3,897 | 56 | 2 |
| 0.030° (what the app now requests) | 8,116 | 104 | 10 |
| 0.1° (z12) | 58,204 | 676 | 95 |

The app used to open at **z18** and request the raw viewport, so the very first "Get this area's
data" always downloaded a bare header — which reads as a broken server rather than an empty area.
Every data request is now widened to `MIN_DATA_SPAN` (0.03°, about 3.3 km) about the centre of the
view, and the map opens at z14. Review zoom is unaffected: `show()` re-frames each candidate with
`fitBounds`, so the opening zoom only influences the hunt for an area.

`areaTooBig` judges the *widened* bounds, and no longer has a zoom floor — span is what the server
cares about, and the floor rejected legal requests from a short window.

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

## Imagery transport, measured 2026-08-19

Everything here was measured **from a wired datacentre link, not a phone**, against `orto-high` =
`https://mapy.geoportal.gov.pl/wss/service/PZGIK/ORTO/WMS/HighResolution`. A phone on mobile data will
be worse. Re-derive the constants on a real device before treating any of them as settled.

| fact | measurement | why it decides the design |
|---|---|---|
| **HTTP/1.1 only** | every response `HTTP/1.1 200`; no h2, no ALPN upgrade. `budynki` by contrast answers HTTP/2 with `alt-svc: h3` | the browser caps this origin at **6 connections**, and `fetch` and `<img>` share that one pool. **Requests, not bytes, are the scarce resource** |
| **No caching headers at all** | `Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials`, `Vary: Origin`, `Content-Type`, `Date`, two `Set-Cookie`, `Transfer-Encoding: chunked`. **No `Cache-Control`, no `Expires`, no `ETag`, no `Last-Modified`** | zero freshness lifetime and no validator, so **every request is a real download** and the browser's own HTTP cache can never help. This is what rules out "paint from `<img>`, then fetch the same URL to fill the cache" — that is two downloads of the same bytes |
| CORS is clean and echoes the Origin | `Access-Control-Allow-Origin: https://dexteriv.github.io` plus `Vary: Origin`, exactly one header | a credential-less `fetch(mode:'cors')` does work here, so one request can both paint and fill the cache |
| **TTFB is seconds** | 256×256 GetMap: 1.0 / 1.5 / 1.6 / 1.6 / 1.8 / 2.0 / 2.1 / 2.5 / 2.5 / 2.8 / 4.0 / 4.2 / 5.7 / 6.9 / 8.6 s. Mean 1.13 s over 20 successes at concurrency 6 | the old 12 000 ms tile timeout was only ~1.4× the worst observed *success*, so on mobile data it was crossed routinely |
| **12–17 % of requests are dropped mid-connection** | 24 @ P6 → 20 ok; 12 @ P6 → 10 ok; 12 @ P2 → 11 ok. The failures are `TLS unexpected EOF` / `Connection reset` — **fast**, not timeouts | in a browser a reset arrives as `TypeError: Failed to fetch`, i.e. `kind: 'network'`, which is indistinguishable from a missing CORS header at the level of one request. See the amendment to regression #12 |
| **Bursts are cut off, then recover** | five back-to-back requests were dropped **5/5** with zero bytes after 15 s; the same URLs succeeded **7/8** minutes later when spaced out | **this settles the old open question: the flakiness is load dependent.** Piling retries on is self-harm, and a *deferred, spaced* retry is the only kind worth making |
| Higher concurrency is *better* | 12 tiles @ P6 = 6.9 s wall; 12 @ P2 = 6.5 s but half the parallelism idle; 24 @ P6 = 4.5 s | **do not add an app-level concurrency limiter.** Let the browser's six do their job; the fix is to stop handing them junk |
| `MaxWidth`/`MaxHeight` = 4096 | `GetCapabilities` | `tileSize: 512` would be legal. It is **deliberately not used** — see below |

The two `Set-Cookie`s (one is an F5 BIG-IP ASM cookie) are both `SameSite`-unspecified, hence `Lax`,
hence never sent on a cross-site subresource — so every tile looks like a new session to that WAF
whichever path it takes. That is a **plausible mechanism** for the burst cut-off and nothing more; it
was not measured, and no client-side header trick could earn a session anyway.

### One request per tile

The pipeline was: IndexedDB read → `fetch(mode:'cors', tries:2, timeout:12000)` → and *only if that
failed* the plain `<img>` that actually paints. So `img.src` was assigned at least one full round trip
late and up to **24.5 s** late, six connections deep in aborted fetches. Worse, its escape hatch could
not arm: it keyed on `err.kind === 'network'`, but a hung server yields `'timeout'`, so `pixelMode`
never latched and **every tile paid the full 24.5 s indefinitely, with no self-correction.**

Measured in a headless browser on a cold cache, nine tiles, before and after:

| | old | new |
|---|---|---|
| tiles painted at t = 2 / 5 / 10 / 20 / 30 s | **0 / 0 / 0 / 0 / 0** | 1 / 5 / 8 / 9 / 9 (bad moment) · **9 / 9 / 9 / 9 / 9** (normal) |
| median `createTile` → first `src` | **24 341 ms** | 704–910 ms, i.e. server TTFB |
| GetMap requests for 9 tiles | **77** (8.56 per tile) | 9–13 (**1.00–1.44** per tile) |
| `imgLayer.isLoading()` at t = 30 s | **still `true`** | `false` |

The old build is **bimodal**, which is exactly why the report was "*often* when I jump to a new area":
when the cors fetch happened to succeed first try it was fine (14 requests, 9/9 painted by 10 s), and
when it did not it collapsed. The new pipeline is not bimodal.

Three restructurings were weighed; the header dump and the connection cap pick the winner:

- **Hedging the `<img>` behind a ~1 s head start** — rejected. Median TTFB is 1.0–2.5 s so the hedge
  would fire on most tiles, both requests contend for the same six slots, and with no `Cache-Control`
  the loser is pure waste rather than a warm cache.
- **`<img>` first, background cache-fill `fetch`** — rejected by the absent caching headers: a second
  real download of every tile, on the origin where requests are the constraint.
- **A one-shot per-source capability probe** — chosen. One extra request per *source selection*, never
  per tile, so a tile takes exactly one path.

`img.crossOrigin` stays unset. The premise that would justify it (a cheap cache-hit follow-up) is
false here, and it would turn the one path that performs **no CORS check at all** — the only path that
works through `orto-proxy` — into one that fails on a header mismatch. Keeping the `<img>` maximally
dumb is the point. The one design where `crossOrigin` earns its place is caching via `canvas.toBlob()`
from the single painting request on a proven-clean source; nothing reads pixels back out of the `tiles`
store, so a JPEG re-encode there would be acceptable. Not implemented.

The cost accepted in exchange: `fetch` + `r.blob()` buffers the whole body before a pixel appears, so
the browser's progressive JPEG decode is forfeited on the cache-filling path. At 1–8 s TTFB against a
~20 KB body, TTFB dominates and the loss is small.

**`tileSize: 512` is deliberately not used**, though it is legal and would quarter the request count.
The rewritten pipeline already measures 1.00 requests per tile, so the win is now marginal; the 512
evidence is n=1 (one success in three attempts); it would orphan every 256-keyed cache entry until TTL
eviction; and against a burst-throttler a larger render may cost more *server time* per request, which
is the resource actually under pressure. Revisit only with a real per-tile server-time measurement.

### Constants, and why those numbers

`TILE_FETCH_TIMEOUT` 6 000 ms — clear of the 95th-percentile success while capping what one hung tile
costs a connection. The cors fetch runs `tries: 1`; the retry belongs on the `<img>`, where it is both
cheaper and independent of CORS. `TILE_IMG_TIMEOUT` 8 000 ms, because an `<img>` has no
`AbortController` and previously waited out the OS TCP timeout. `TILE_IMG_TRIES` 3 with
`backoff(i-1, 300, 1500)`, and the whole loop bounded by `TILE_DEADLINE` 15 000 ms — a blank tile now
beats a connection still tied up when the next screenful arrives.

`TILE_FETCH_GIVEUP` 6 consecutive cors-fetch failures routes tiles straight to `<img>`;
`TILE_FETCH_REARM` 24 img-served tiles routes them back. **The re-arm is not decoration.** At a
give-up of 4 and no re-arm, a cold boot's 30-tile burst tripped the latch against a source whose CORS
headers are perfect — because the server throttles bursts, so consecutive failures cluster exactly
there — and the session then lost its **entire tile cache**: 21 tiles painted by `<img>`, 0 cached.
Verified after the fix, network-free against a local stub: 9 tiles cold = 9 requests and 9 stored, then
the same view warm = **9 cache hits, 0 requests, store unchanged**.

The IndexedDB cache is keyed on the full tile URL. Leaflet's WMS `getTileUrl` derives `BBOX` from the
tile coords, so the key is stable for the same z/x/y — but it changes when the *map size* changes,
because a different size covers a different set of coords. A cache test that does not pin the view and
let `invalidateSize` settle first will measure zero hits and be wrong about it.

### Truncated bodies, and why the cache had to be purged once

Reported as *"now instead of black tiles i see white only tiles"*, immediately after the pipeline above
shipped, and resolved on the reporter's device by clearing the cache. That last detail is the whole
diagnosis.

The source drops 12–17 % of connections **mid-body** and answers with `Transfer-Encoding: chunked` and
no `Content-Length`, so a dropped connection delivers a **200 whose JPEG simply stops early**. A browser
fires `load` for that — it decodes the rows it received and fills the rest — so nothing downstream could
tell the difference, the body went into the tile cache, and it was served from there for the rest of the
TTL. It only became visible once the fetch path started succeeding often enough to cache anything at
all: before, tiles mostly failed outright and you saw the dark `#map` background.

`imageBlobOk` now checks that the bytes contain a whole image: a complete JPEG ends with the
end-of-image marker `FFD9`, a complete PNG with an `IEND` chunk. Both are definitive where size and
decoded dimensions are not — **a truncated JPEG still reports the full width and height from its
header.** Verified against five real GUGiK tiles across four locations and four zooms: all `ffd8…ffd9`,
so complete imagery is never rejected.

Three things follow, and the second was only found by measuring:

- A truncated body is **not cached**, and cached entries are re-checked on read as well as on write, so
  anything stored by an earlier build is dropped the first time it is touched.
- It is also **not painted**, and the reason is not obvious: rejecting it on the fetch path alone simply
  handed the same URL to the `<img>` fallback, which cannot inspect what it received and painted it
  anyway. Measured 9 bodies rejected and then 21 painted, 12 visible partial tiles. A tile that is half
  imagery and half fill is worse than a blank one here — the entire point of the app is judging a
  building against what is on the ground, and a partial tile invites a verdict over ground that was
  never seen. So it goes blank and `healTile` asks again.
- `healOnce` prefers the cors fetch over a plain `<img>` wherever the source supports one, because only
  the fetch can see whether the body was complete. Healing was the last path that would otherwise still
  paint a partial tile.

Measured against a stub serving a real GUGiK JPEG cut to 40 %: `paintedCls: 0`, `visible: 0`,
`cachedEntries: 0`, 30 bodies rejected — and the flaky-503 stub still heals 9 of 9, and the cache still
goes 6 stored cold → 6 hits and 0 requests warm.

**A truncated JPEG renders black in Chromium, not white** — measured: top rows real imagery, everything
below `[0,0,0]`. So the reported white was engine-specific (the device was not Chromium-on-desktop) and
that particular appearance was never reproduced here. What *was* reproduced is the cause: partial bodies
being cached and painted. Do not go looking for a white-coloured bug in this repo; look for a partial
image.

`S.tilesChecked` purges the tile store once on upgrade, in the same shape as `S.offProxy`, because a
build that starts checking bodies cannot vouch for any stored by a build that did not. Rejection on read
alone would leave the first view of every poisoned tile blank.

### Blank tiles heal themselves

A tile that spent its attempts used to stay blank until the user panned or zoomed — reported as *"i had
to do sth so it retries"*. Isolated against a stub that answers on the seventh request: **90 seconds of
sitting perfectly still produced not one further request, and 12 of 12 tiles stayed blank.** The app
stopped asking.

`healTile` keeps trying afterwards, on a schedule the same measurements dictate: five back-to-back
requests were dropped 5/5 while the identical URLs answered 7/8 minutes later when spaced, so this
origin recovers with **time, not pressure**. Four slots at 6 s doubling to a 60 s cap, each jittered
±30% by `backoff`, put the first attempt 4–8 s after the tile gave up and the last 1–2 minutes after. A
schedule that finished inside 30 s would never sample a recovered server.

Measured against the same stub, sitting still:

| at idle+90 s | before | after |
|---|---|---|
| blank tiles | **12 / 12** | 1 / 9 |
| painted | **0** | 8 |
| requests after the pipeline gave up | **0, frozen** | 71 (~4 per tile) |
| tiles recovered | 0 | **20** |

Four details are load-bearing, and each is a trap someone will otherwise walk into again:

- **The re-attempt reveals the tile itself.** Leaflet adds `leaflet-tile-loaded` at exactly one line and
  only when the tile did not error, and `.leaflet-tile` is `visibility: hidden` until that class
  arrives, so a repaired tile is invisible without `L.DomUtil.addClass`. Re-calling `done()` would not
  do it — `TileLayer._tileReady` bails while `src` is the 1×1 gif — and would fire a second, spurious
  `tileerror`. Opacity needs no help: `_updateOpacity` fades any `current && loaded` tile to 1 without
  checking whether it errored.
- **`<img>` only, never the cors fetch.** Nine blank tiles retried through the fetch path are nine
  *consecutive* fetch failures, `tileFetchMisses` latches `tilePath` to `'img'` at six, and that latch
  was measured costing a session its entire tile cache. A retry of a known-bad tile is not evidence
  about the source, so it must not vote. The cost accepted: a healed tile is not cached, so panning back
  to it is a fresh download.
- **`gone()` is re-checked after a *successful* load.** `_abort()` cancels by pointing `src` at the gif,
  which fires `load` — so a cancelled tile can resolve `loadImg` looking like a success.
- **No batch size and no shared timer.** Each tile heals in the async closure it already has, so a
  screenful of nine blanks makes at most nine spaced attempts — the same shape as any pan — and the
  independent jitter smears them apart instead of aligning them. Higher concurrency measured *better*
  on this origin, so a limiter would be the same mistake here as in the pipeline.

`heal` and `healed` are counted apart from `net` and `tiles` in `tileStats` on purpose: folding a repair
into either would make "requests per tile" read healthy exactly when a screenful is costing double, and
that ratio is how this work is judged.

The old "imagery is failing" toast counted raw `tileerror`s and fired during any passing burst-throttle,
telling the user to change a source that was working. It now says blank tiles keep retrying and to
change source only if they are *still* blank afterwards.

**A skipped slot is waited, not spent.** `healTile` makes no request while `document.hidden` or
`navigator.onLine === false`, but it does not consume the slot either — it loops. That distinction is
the difference between working and not on a phone, where switching away mid-review is the normal case:
spending the slots meant coming back to tiles that would never try again until the map moved. Waiting
needs no resume hook and no `visibilitychange` listener, because a hidden tab's timers are throttled by
the browser, so the loop paces itself instead of queueing a burst for the moment of unhide, and
`backoff`'s jitter smears whatever does resume together. `TILE_HEAL_WAITS` bounds it at roughly twenty
minutes so a tab left in a pocket cannot hold the closure for ever.

Measured with `document.hidden` overridden, against the flaky stub:

| | hidden for 120 s | then visible |
|---|---|---|
| heal requests | **0** | 29 → 54 |
| server hits | **frozen at 75** | 104 → 129 |
| painted | 0 / 9 | 4 → **9 / 9** by +100 s |

Zero requests while hidden, and full recovery afterwards. A resume hook was the obvious alternative and
is deliberately **not** used: one that re-creates tiles would send them back through the cors fetch,
which is exactly the path that must not vote on `tileFetchMisses`.

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

**`401` from `/oauth2/token` is always `invalid_client`**, verified against the live endpoint:
*"Client authentication failed: unknown client, no authentication provided, or unsupported
authentication method."* It means the registration is **confidential** — so OSM demands a client
secret the browser cannot hold — or the client id does not match. On the registration form
**“Confidential application?” must be unticked.** A wrong redirect URI or a reused code gives `400
invalid_grant` instead, so the status tells you which of the two it is.

The token exchange used to report only the status code, which hid exactly this. It now reads the
error body, gives the specific remedy, and parks the reason in the settings sheet next to the client
id, because a toast is gone long before you have finished editing the registration.

`redirectUri()` is a single helper on purpose: `login` stripped the fragment and `finishLogin` did
not, so the two requests could disagree about `redirect_uri` and earn a spurious `invalid_grant`.

The PKCE verifier lives in `sessionStorage`, which is per-tab: finishing the flow in a different tab
loses it. That case used to return silently and now says so.

Changeset tags, built by `csTags()` as key/value pairs so the review sheet can display exactly what
will be sent rather than paraphrasing it:

```
created_by=orto-review
comment=<comment> — <locality>
source=BDOT10k;PRG
host=<the app URL it ran from>
repo=https://github.com/DexterIV/Osmmobile   (settings-configurable)
review_count=<objects in this changeset>
```

**There is deliberately no `hashtags` tag.** It used to read `#orto-review`, which says nothing a
reviewer cannot already see from `created_by`, and a hashtag implies a coordinated campaign that
nobody is running. `host` replaces it — the key iD and Rapid use for the editor's address — together
with `repo`, so anyone looking at an edit can go and read the code that made it. If a real campaign
ever exists, add `hashtags` back then, with the campaign's actual tag.

`import=yes` is **off by default and should stay off.** Every candidate is inspected against
imagery, so these are not automated edits and labelling them as such invites unwarranted reverts.
Reviewing each object does **not** make this "not an import" in the wiki's sense — the geometry still
originates from BDOT10k, so the Import Guidelines still apply: announce in the Polska category on
community.openstreetmap.org, use a separate account, one locality per changeset.

## Open in iD

The `iD` button in the tool column (or `E`) opens `https://www.openstreetmap.org/edit?editor=id` at
the current candidate, for when one-object-at-a-time is the wrong tool and you want iD's imagery
switcher, history, measurement or relation editing.

- **A new tab, deliberately.** Navigating away would discard the in-memory queue; only the verdicts
  are persisted.
- `background=` is set from the imagery preset via `ID_BACKGROUND`, using ids from the
  editor-layer-index — the same catalogue iD reads — so iD opens on the imagery you were reviewing
  against. `orto-high` maps to `Geoportal2-PL-HighResolution-aerial_image_WMS`, `orto-std` and
  `orto-proxy` to `Geoportal2-PL-aerial_image_WMS` (the proxy fronts StandardResolution). An
  unrecognised id is ignored by iD, so a stale entry degrades to "iD picks its own background"
  rather than breaking.
- `comment` and `source` are prefilled so an edit made over there is attributed like one made here.
- **The candidate itself is not in OSM**, so iD cannot select it — there is no id to pass. The button
  says so in a toast. Only objects already mapped are editable there.

It sits in `#padTools`, not in the verdict bar. The bar's three buttons are muscle memory and also
carry swipe handlers, so a fourth button there would both shift them and risk a swipe navigating away
mid-review.

## Land cover — foundations (buildings path untouched)

Planned split, per the owner: the **vibe-osm-importer** (private, `DexterIV/vibe-osm-importer`) keeps
doing the geometry — fetch, clip against fresh Overpass, `repair_overlaps_exact`, holes, sliver
filter — and runs as a small server on the laptop; the phone reviews area by area. **Land cover and
buildings must stay independent**, so that with no server reachable the building review still works
in full. Buildings come from vector tiles and need nothing from the importer.

Why the app does not fetch those sources itself, measured 2026-08-18:

- **BDOT10k opendata** `1003_GML.zip` is **33.4 MB per powiat** and sends **no
  `Access-Control-Allow-Origin`**. Unfetchable from a browser regardless of size.
- **ARiMR WFS** (`geoportal-w2.arimr.gov.pl/geoserver/gsa_public/uprawy_2025/wfs`) sits behind a WAF
  that rejected every request from this environment — including with the importer's own
  `python-requests` User-Agent — answering with a malformed `HTTP/1.1 0` status line and a *Request
  Rejected* page. Its CORS headers could not be observed. GeoServer sends none by default.

### What was wrong for land cover, and is now fixed

1. **Relations were ignored entirely.** The scanner reads nodes and ways only, so the importer's
   `type=multipolygon` output arrived as two unrelated solid rings and accepting the farmland would
   have uploaded it over the forest — gotcha #1 in the importer's own notes, reintroduced here.
   Relations are now parsed in JS (a land-cover file has a handful against thousands of nodes, so a
   regex pass is cheaper than teaching the AssemblyScript scanner a third element type). Way ids come
   from the source in document order, which is the order the scanner appends them; **the count is
   checked and relations are skipped wholesale on any mismatch**, because a mis-resolved member would
   attach the wrong hole to the wrong field.
2. **Upload discarded shared topology.** `write_landuse_osm_file` deduplicates nodes by rounded
   coordinate so neighbours share boundary nodes; `osmChange` emitted a fresh node per ring. It now
   dedupes across the whole changeset at OSM's 7-decimal limit — two adjacent squares give six nodes,
   not eight — and emits holes as a `type=multipolygon` with **untagged** rings, since tagging the
   outer way fills the hole back in.
3. **Untagged closed ways became candidates.** In a land-cover file those are the inner rings.
4. **Review UI assumed buildings.** Land cover is `kind: 'area'`: drawn in green with its holes,
   auto-fit refuses it (Sobel edge correlation against a building outline means nothing on a field),
   vertex handles are suppressed above 80 points, and `overlapVerdict` skips areas — a farmland parcel
   containing a barn is not a duplicate of the barn, and judging areas against footprints would flag
   every field. Comparing against existing *land cover* would be the useful check and is not written.

### The server, and how it is reached

`serve_review.py` in the importer repo indexes and serves the `.osm` tiles the pipeline has already
written — `GET /health`, `GET /index` (id, bbox, per-class counts), `GET /tile/<id>.osm`. Stdlib only,
binds `127.0.0.1`, reindexes when a file's mtime or the file set changes, CORS wide open.

**It must be reached over HTTPS.** The app is served over HTTPS from GitHub Pages, and a browser
refuses `http://` from an `https://` page, so a LAN address cannot work — a locally-trusted cert or
serving the app from the laptop were the alternatives, and the latter also costs PKCE sign-in because
`crypto.subtle` is absent on an insecure origin. The chosen route is a tunnel:

```bash
python serve_review.py --dir ./out --port 8000
cloudflared tunnel --url http://localhost:8000
```

The https URL goes in Settings → *Land-cover server*, which also shows a live reachability line.

In the app: **Land cover from server** in the `⋯` panel, disabled until a server is set. It fetches
`/index`, takes every tile whose bbox *overlaps* `dataBounds()` (overlap, not containment — a parcel
straddling the view edge still matters), caps at 12 tiles a go, parses each with `parseOsmXml` so
holes survive, and filters by class. Classes are **opt-out**, listed in settings, so a class the
importer starts emitting later appears rather than being silently dropped. With no tile covering the
view it names the nearest one's centre instead of saying nothing.

Buildings never touch any of this.

## Nothing is sent without being read first

The up-arrow opens the **queue review sheet**; it does not upload. Previously a single tap on it
started a live changeset, with nothing in between and no way to see what had accumulated across
sessions. The sheet lists every queued object with its kind, locality, tags and whether it was
nudged, shows the exact changeset tags for the first batch, and only then offers Upload.

Dropping an object from that list deletes its `queue` entry **and** its `decisions` entry. Deleting
only the queue entry would lose the object permanently — it would be filtered out of every future
load as "already decided" while never having been uploaded.

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
7. **The start panel overlaying the map.** `#start` was absolutely positioned inside `#wrap` at
   `bottom:10px; right:10px`, i.e. on top of the imagery and in the exact corner the drift pad
   occupies. It is now a flow element between `#tags` and `#bar`, so the map keeps its full area and
   grows back into the space when a candidate is showing. Verified with rectangles rather than by
   eye: at 496x822 the map is 42-603, the panel 645-746, and it overlaps neither the map nor the pad.
8. **The drift pad painting under the tiles.** `#map` had `position:absolute` with no `z-index`, so
   it created no stacking context and Leaflet's own panes — tilePane 200 up to popupPane 700, plus
   controls at 800 — competed directly with `#map`'s siblings in `#wrap`. Anything without a
   `z-index` of its own, which was `#pad` and `#padTools`, therefore drew *beneath the tiles*.
   `#start`, `#stage` and `#toast` only escaped because they happened to set one. `#map` is now
   pinned to `z-index: 0` so the panes stay contained. This was invisible for the entire project
   until candidates actually loaded, because the pad is only shown when there is one.
   Verified with `elementFromPoint` over each control rather than by eye.
9. **A permanently disabled file picker.** `shell.html` shipped `#pickBtn` with a hard `disabled`
   attribute and the label "Loading…", and nothing ever cleared either — `setControls` only touches
   `#pad`, `#padTools` and `#bar`. The file-open route was dead from the first commit and nobody
   noticed, because the button looked like it was still initialising. `bindUI` now enables it.
10. **Keyboard shortcuts firing while typing.** The `keydown` handler skipped `INPUT` and `SELECT` but
   not `TEXTAREA`, so typing in the paste box nudged the outline and an `a` in pasted text accepted
   the candidate. It now also skips `TEXTAREA` and `isContentEditable`, and ignores everything except
   Escape while the tag sheet is open.
11. **Deleting a tag on a single tap.** Tapping a tag chip used to delete it outright — no
    confirmation, no undo, and it was the only tag interaction there was. Chips now open the editor,
    and `pushUndo` snapshots tags as well as geometry so `Z` reverts a tag edit.
12. **Treating a flaky network as blocked CORS.** A dropped request, a 5xx and a missing
   `Access-Control-Allow-Origin` all surface as the same opaque `fetch` rejection. Conflating them
   latched `pixelMode = 'blocked'` on the first mobile-data blip, which disabled auto-fit for the
   session *and* made every later tile bypass the IndexedDB cache. Missing CORS may only be inferred
   from the one pattern that implies it — a network-shaped `fetch` failure on a tile that a plain
   `<img>` then loads — and never from a timeout or an HTTP status.
13. **A tile layer event listener on the map.** `GridLayer` fires `tileunload` as
   `this.fire('tileunload', {tile, coords})` — two arguments, **no `propagate` flag** — and
   `Evented.fire` only walks `_eventParents` when that flag is truthy. `Layer._layerAdd` never calls
   `addEventParent(map)`; the only two callers in all of Leaflet are `FeatureGroup.addLayer` and
   popup/tooltip binding. So `map.on('tileunload', …)` **never ran once.** Measured: 0 firings on the
   map against 9 on the layer for a single `fitBounds`. That silently disabled the whole
   cancellation-and-revocation mechanism, so every tile that painted leaked its object URL for the life
   of the session, and every tile panned away from downloaded to completion against a 6-connection cap.
   Tile events go on the **layer**.
14. **`img.complete` as a "still in flight" test.** An `<img>` that has never been given a `src`
   reports `complete === true` — measured `true` in a real browser. The abort path guarded on
   `!el.complete`, so it skipped precisely the tiles that were still waiting on the cache read or the
   fetch, which are the ones whose retry chains most needed stopping. Leaflet's own `_abortLoading` is
   blocked by the same guard and leaves them in `_tiles` too. Stock Leaflet gets away with it because
   its `createTile` assigns `src` synchronously; anything that assigns it after an `await` must track
   its own flag.
15. **Assigning `img.onload` / `img.onerror` on a tile.** Leaflet owns those two properties:
   `TileLayer._abortLoading` sets both to a no-op **unconditionally**, before its `complete` check, and
   `TileLayer._onTileRemove` nulls `onload`. Assigning them meant every aborted tile's promise never
   settled and its async pipeline stayed suspended for the rest of the session, holding the `<img>`, the
   `Blob` and the object URL. Use `addEventListener`.
16. **A layer `maxZoom` below the map's.** `_setView` sets `_tileZoom = undefined` when the rounded
   zoom exceeds the layer's `maxZoom` and then skips `_update`; `_pruneTiles` then hits
   `zoom > options.maxZoom` and calls **`_removeAllTiles()`**. The map was built with `maxZoom: 22` and
   the imagery layer with `maxZoom: 21`, so two pinches past review zoom blanked the imagery entirely
   and it returned only on the way back down, as a full cold reload. Measured: 6 tiles at z21, **0 at
   z22**, 6 again at z21. Note `_clampZoom` — where `maxNativeZoom` acts — is only reached in the
   *else* branch, so `maxNativeZoom` alone does not fix it: `maxZoom` must match the map's **and**
   `maxNativeZoom` must cap the real tiles. The `osm` preset needs `maxNativeZoom: 19`, since
   `tile.openstreetmap.org` serves no deeper and `transientImagery` treats the resulting 404s as worth
   retrying.
17. **Trusting Leaflet's cached container size.** `_sizeChanged` is set in exactly two places in all of
   Leaflet 1.9.4 — `Map.initialize` and `invalidateSize`, whose only internal caller is the window
   `resize` handler — and there is no `ResizeObserver` anywhere in it. `#map` is absolutely positioned
   inside `#wrap`, a flex sibling of `#tags` and `#start`, so hiding the start panel, expanding it, or
   painting a different number of tag chips resizes the map with no `resize` event anywhere. Measured at
   496×822: **+386 px** with the panel expanded, **−101 px** with it hidden, and still wrong two frames
   later. **Both signs hurt** — too tall requests up to 2.5× the visible area from an origin capped at
   six connections, too short leaves a blank strip along the bottom — and which one you get depends on
   the layout state the map happened to be in when the last window `resize` fired, so the symptom is
   not stable. A `ResizeObserver` on `#map` fixes the tiling, but a *synchronous* `syncMapSize()` is
   still needed in `fitShape()`, because `ingest` hides the panel and re-fits inside one task while the
   observer only runs a frame later.

18. **Trusting a 200 to contain a whole image.** The imagery source drops 12-17 % of connections
   mid-body and sends `Transfer-Encoding: chunked` with no `Content-Length`, so a dropped connection
   delivers a 200 whose JPEG stops early. A browser fires `load` for it, decoding the rows it got and
   filling the rest, and **a truncated JPEG still reports the full width and height from its header** —
   so neither `load`, nor `naturalWidth`, nor the byte count can detect it. Those bodies were cached and
   served for the rest of the TTL. Check the format's terminator instead (`FFD9` for JPEG, `IEND` for
   PNG), reject on read as well as on write, and do not let the `<img>` fallback quietly paint the same
   bytes the fetch path just refused — measured 9 rejected and then 21 painted.
19. **A cache purge that purges nothing visible.** Emptying the `tiles` store changes nothing on screen
   until something happens to re-request a tile, so the button appeared to do nothing — and this button
   exists precisely for when what is on screen is wrong. It rebuilds the imagery layer now.

**Amendment to #12, measured 2026-08-19.** The rule above is right but was **insufficient at the tile
level.** A connection dropped mid-flight is `network`-shaped, and the `<img>` retry right after it
succeeds — which is *literally* the blessed pattern, yet a false positive, because the fault was
transient and per-request rather than a header. At the measured drop rate of ~0.12 and
`corsSignals >= 2`:

> P(≥2 such tiles in a 16-tile screenful) ≈ 1 − 0.88¹⁶ − 16·0.12·0.88¹⁵ ≈ **0.62**

So roughly **six screenfuls in ten latched `pixelMode = 'blocked'` on a source whose CORS headers are
perfect**, disabling auto-fit for the session *and* making every later tile skip the cache. A header
fault is deterministic and origin-wide; a reset is not, and only somewhere that can afford three
requests can tell them apart. **`probeImagery` is now the only place allowed to set
`pixelMode = 'blocked'`**, and it needs all three signals: a network-shaped `fetch` failure, then a
`no-cors` fetch that resolves (the server was reached, so the fault is its headers), then a plain
`<img>` that loads (the bytes really are there). The per-tile path keeps a purely *performance* latch
(`tileFetchMisses`) that never touches `pixelMode`.

`onAttempt` therefore reports `(attempt, message, kind)` for every failed attempt, not just the last.
Only the last attempt's kind reaches the thrown error, and the budynki proxy fails **two different
ways within one probe** — 404 to about half its GetMaps, duplicated CORS headers on the rest — so a
probe reading only `err.kind` sees whichever came last. Measured ending on `'http'`, which meant it
never diagnosed the header fault at all despite a CORS rejection having occurred.

## Driving the app headlessly

There is no Linux browser in the WSL environment, but `msedge.exe` on the Windows side is reachable
and Windows can see WSL's listening ports, so `python3 -m http.server` plus
`msedge.exe --headless=new` works for real end-to-end checks.

**Do not trust `--virtual-time-budget` for anything involving the network.** It fires every timer
instantly, which means each `AbortController` timeout in `fetchRetry` aborts its own in-flight
request, and the budget is exhausted before the async tail of `main()` runs. It reported the app
stalling at boot when it does not. To check real behaviour, serve a copy with a small probe script
appended that `fetch`es a marker URL back at the stub server once `#start` is visible, launch Edge
with real wall-clock time, and read the marker. Measured that way, boot completes in about 10 s.

`--enable-logging=stderr --v=1` is what surfaces the browser's own CORS console messages, which is
how the duplicated-header fault above was identified. `--dump-dom` is enough to confirm markup and
that `bindUI` ran.

Three more things the harness gets wrong by default, each of which produced a confidently wrong answer
before it was found:

- **`--user-data-dir` must live on the Windows filesystem**, not under `/home` or anywhere reached by a
  `\\wsl.localhost` UNC path. On a UNC path Edge cannot get sandbox access or SQLite locks, the quota
  database never opens, **IndexedDB is unavailable**, and the app throws during boot before `initMap()`
  runs. The log says `Could not open the quota database, resetting` among a hundred lines of unrelated
  noise, and the symptom reads as "the app is broken". `/mnt/c/Users/<you>/AppData/Local/Temp/...` works.
- **The mobile user agent is load-bearing, not cosmetic.** `Browser.mobile` is
  `typeof orientation !== 'undefined' || userAgentContains('mobile')`, and it selects Leaflet's
  `updateWhenIdle` — which decides whether tiles load during a pan or only on `moveend`. With a desktop
  UA the harness silently exercises a different code path from the phone.
- **A fresh profile per run, and `dbClear('tiles')` in the probe.** Otherwise the second run of any
  timing measurement is served from the IndexedDB tile cache and means nothing. A cold cache *is* the
  case worth measuring.

For anything about tile behaviour, prefer a **local stub tile server** over the real origin. Serving a
small PNG with a query-string-keyed failure counter — 503 for the first N requests per distinct bbox,
then 200 forever — makes "does a blank tile ever retry" a deterministic question instead of a question
about GUGiK's mood that afternoon. Setting N above the in-pipeline budget (one cors fetch plus
`TILE_IMG_TRIES`) isolates the healing path specifically. Note also that after a dozen harness runs the
real origin starts throttling *you*, so late A/B numbers against it are noise; alternate old and new
runs and use distinct bboxes.

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
- `/random/` being 500 no longer matters — the button uses `buildings_clustered` instead — but the
  endpoint is still broken upstream and diagnostics still probes it.
- Decide whether tile-derived geometry should upload at all, or whether accepting a candidate loaded
  from tiles should require re-fetching that one object's exact outline. At ±18 cm per vertex it is
  well inside BDOT10k's own error, but it is resampled rather than original, and an importer may
  reasonably want the source geometry byte-for-byte.
- Re-check whether the upstream address tile layers have started being generated; if they have, the
  in-app path covers addresses too and the paste route becomes a convenience rather than a necessity.
- **Resolved 2026-08-19, and the answer was yes.** The flakiness *is* load dependent: five
  back-to-back requests were dropped 5/5 while the identical URLs answered 7/8 minutes later when
  spaced. So the old policy's retries were making it worse, and `TILE_TRIES = 4` is gone — see
  *Imagery transport*. What remains open is that **every number in that section came from a wired
  datacentre link, not a phone.** Re-run the harness on the owner's mobile connection and re-derive
  `TILE_FETCH_TIMEOUT`, `TILE_IMG_TIMEOUT`, `TILE_HEAL_BASE` and `TILE_HEAL_CAP` before treating them
  as settled.
- Healing is verified against a local stub, not against the real origin on a phone. The stub proves the
  *mechanism* — suspend while hidden, resume visible, recover every tile — but the schedule's fit to
  GUGiK's real recovery timescale rests on the burst measurement from a wired link.
- Tune the auto-fit confidence gate. Currently refuses below z=1.6; untested against real
  orthophoto over tree cover and snow.
- Addresses currently upload as standalone nodes. Merging an address into an existing OSM building
  when one clearly contains it would be more correct, and needs modifying an existing way rather
  than creating one.
- `streets` is an available upstream layer and is not used at all.
- `/lod1/not_in/osm/` exists upstream and could supply building heights.

## Licence

GPL-3.0-or-later. `LICENSE` is the canonical text fetched from gnu.org, not transcribed. Each source
file carries a short notice, which for `src/app.js` and `src/sw.js` means the notice is inlined into
the distributed `index.html` and `sw.js` too.

Bundled Leaflet is BSD-2-Clause and GPL-compatible; `build.mjs` strips only its sourcemap comment, so
its `@preserve` copyright banner survives into `index.html`. Verify that after touching the inlining
step — removing it would be a licence violation, not just impolite.
