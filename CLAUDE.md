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
| `test/mvt.test.mjs` | the hand-written vector-tile decoder, against real captured tiles |
| `test/context.test.mjs` | overlap and duplicate-address verdicts, against real OSM footprints |
| `test/tags.test.mjs` | the tag editor's draft-to-tags normalisation |
| `test/parse.test.mjs` | the wasm `.osm` scanner, against a real captured `/josm_data` response |
| `test/fixtures/` | live captures: a `/josm_data` export, z14 buildings and z6 cluster tiles, an OSM `/map` cell |
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
7. **The drift pad painting under the tiles.** `#map` had `position:absolute` with no `z-index`, so
   it created no stacking context and Leaflet's own panes — tilePane 200 up to popupPane 700, plus
   controls at 800 — competed directly with `#map`'s siblings in `#wrap`. Anything without a
   `z-index` of its own, which was `#pad` and `#padTools`, therefore drew *beneath the tiles*.
   `#start`, `#stage` and `#toast` only escaped because they happened to set one. `#map` is now
   pinned to `z-index: 0` so the panes stay contained. This was invisible for the entire project
   until candidates actually loaded, because the pad is only shown when there is one.
   Verified with `elementFromPoint` over each control rather than by eye.
8. **A permanently disabled file picker.** `shell.html` shipped `#pickBtn` with a hard `disabled`
   attribute and the label "Loading…", and nothing ever cleared either — `setControls` only touches
   `#pad`, `#padTools` and `#bar`. The file-open route was dead from the first commit and nobody
   noticed, because the button looked like it was still initialising. `bindUI` now enables it.
9. **Keyboard shortcuts firing while typing.** The `keydown` handler skipped `INPUT` and `SELECT` but
   not `TEXTAREA`, so typing in the paste box nudged the outline and an `a` in pasted text accepted
   the candidate. It now also skips `TEXTAREA` and `isContentEditable`, and ignores everything except
   Escape while the tag sheet is open.
10. **Deleting a tag on a single tap.** Tapping a tag chip used to delete it outright — no
    confirmation, no undo, and it was the only tag interaction there was. Chips now open the editor,
    and `pushUndo` snapshots tags as well as geometry so `Z` reverts a tag edit.
11. **Treating a flaky network as blocked CORS.** A dropped request, a 5xx and a missing
   `Access-Control-Allow-Origin` all surface as the same opaque `fetch` rejection. Conflating them
   latched `pixelMode = 'blocked'` on the first mobile-data blip, which disabled auto-fit for the
   session *and* made every later tile bypass the IndexedDB cache. Missing CORS may only be inferred
   from the one pattern that implies it — a network-shaped `fetch` failure on a tile that a plain
   `<img>` then loads — and never from a timeout or an HTTP status.

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
