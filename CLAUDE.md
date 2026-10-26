# Orto Review — project context

Single-file offline PWA for reviewing BDOT10k building outlines and PRG address points against the
GUGiK orthophoto, one object at a time, on a phone. Accepted objects upload to OpenStreetMap as
ordinary changesets.

Owner: DexterIV · repo `DexterIV/Osmmobile` · live at `https://dexteriv.github.io/Osmmobile/`.
`README.md` is for users; this file is the working context — what the code assumes, what was
measured, and what must not be re-broken.

## Build, test, deploy

```bash
npm install
npm run build      # asc src/core.ts -> core.wasm, inlines Leaflet + wasm into index.html
npm test           # build, then all eight suites
npm run serve      # http://localhost:8080 (python3 -m http.server; on Windows use `python`)
```

- `index.html`, `sw.js` and `core.wasm` are **generated and gitignored**. Never edit or commit them;
  edit `src/` and rebuild. A local build is for testing.
- Deployment is `.github/workflows/deploy.yml`: push to `main` → Node 20 → `npm ci && npm run
  build` → Pages artifact. Nothing generated is committed.
- `build.mjs` compiles the wasm, inlines Leaflet and the wasm as base64, stamps `sw.js` with a build
  id hashed from the sources (CRLF normalised first, or Windows and CI stamp different ids), and
  refuses output if a `$('someId')` has no matching `id=` in `src/shell.html`, a bundled script fails
  to parse, or `__BUILD_ID__` went missing. Each of those shipped as a bug once.
- On Windows, npm and native binaries print `RemoteException` noise and exit 1 even when they
  succeeded. Judge by output (`index.html … KB`, `n groups passed`), not by the exit code.

## Environment constraints

- **Must be served over HTTPS or from `localhost`.** Chrome restricts IndexedDB on `file://`, and
  OAuth 2 PKCE needs a registered redirect URI and a secure context.
- **Never use `localStorage`/`sessionStorage` for app data.** Everything persistent is IndexedDB:
  `kv`, `tiles`, `ctx`, `decisions`, `queue`; TTL eviction runs at launch. The only `sessionStorage`
  item is the PKCE verifier, which is per-tab on purpose.
- **An iframe with an opaque origin blocks every outbound request.** Detected at boot; the app
  disables the fetch buttons and explains instead of failing a doomed request.
- No web fonts — the tool must work offline. System stacks only.

## Layout

| path | role |
|---|---|
| `src/core.ts` | AssemblyScript: `.osm` byte scanner, uniform grid index, Sobel, drift cross-correlation |
| `src/app.js` | all application logic |
| `src/shell.html` | markup + CSS |
| `build.mjs` | compiles the wasm, inlines everything, validates output |
| `src/sw.js` | service-worker source; `__BUILD_ID__` stamped at build time |
| `test/*.test.mjs` | see below; suites slice functions out of `src/app.js` rather than copy them |
| `test/fixtures/` | live captures: `/josm_data` export, z14 buildings (v1 and v2), z6 clusters, z6 agg_cells, an OSM `/map` cell, a land-cover multipolygon |
| `tools/mirror-worker/` | optional Cloudflare Worker that re-adds CORS to upstream |
| `setup.sh`, `publish.sh` | legacy WSL bootstrap/publish helpers; deployment is CI now |

## Tests

| suite | covers |
|---|---|
| `wasm.test.mjs` | the AssemblyScript kernels |
| `retry.test.mjs` | retry/timeout/backoff helpers against a stub fetch |
| `parse.test.mjs` | the wasm `.osm` scanner, against a real captured `/josm_data` response |
| `mvt.test.mjs` | the hand-written vector-tile decoder and tile math, plus the address-ingest wiring |
| `context.test.mjs` | overlap and duplicate-address verdicts, against a real OSM footprint cell |
| `tags.test.mjs` | the tag editor's draft-to-tags normalisation |
| `landuse.test.mjs` | land-cover changeset shape, class filtering, tile selection |
| `order.test.mjs` | `nearestChain`, against a stub `metresBetween` |

Fixtures are real captures, not hand-built: a decoder bug that only exists against the live schema
must be able to fail here. Add a new capture rather than editing one.

## Data source — upstream v2

Base: `https://budynki.openstreetmap.org.pl`. Upstream was rewritten on 2026-10-11 ("OSM Polska
budynki/adresy v2", `openstreetmap-polska/osmpbudynkiv2`, Rust). v1's `/sc/*`, `/josm_data`,
`/layers/`, `/random/` and `/orto/` are **gone** (404), not flaky.

| endpoint | use |
|---|---|
| `GET /tiles/{z}/{x}/{y}` | the primary candidate source. MVT, **no `.pbf`** — the router parses path segments as integers and answers `.pbf` with `400` |
| `GET /package?bbox=w,s,e,n&datasets=bdot10k,egib,prg` | v2's `/josm_data`: GeoJSON of everything still unmatched in the box. Addresses as Points with `addr:*`, buildings as Polygons/MultiPolygons. **No per-object id.** Area-capped at `0.04 sq deg` |
| `POST /report` | `{"objects":[{source,key}]}` — vetoes an object out of the unmatched sets for everyone |
| `GET /status` | server config and job log |
| `GET /updates` | recent OSM-matching FeatureJSON |

The served pyramid, measured from live tiles:

| zoom | layer | contents |
|---|---|---|
| 5–11 | `agg_cells` | bins with unmatched counts `n_bdot10k`/`n_egib`/`n_prg`, totals, ratios, recent-change dates |
| 12–13 | `points` | one point per still-unmatched object |
| 14 | `buildings` / `buildings_all` | full polygons; the unmatched layer carries a `tags` string of `key=value` pairs joined by `;`, plus `source:building` (`BDOT` or `EGiB`), `building:levels`, and registry columns |
| 14 | `addresses` / `addresses_all` | PRG points; unmatched carries ready `addr:*` tags and `lokalny_id` |

`maxzoom` is 14; z15+ returns 404. Always read the status, not the body size — a 404 page is not a
tile.

- **Tags are curated upstream.** Whatever `tags` holds is what ships; the v1 client-side whitelist is
  gone. Addresses have each tag as its own property, and the code uploads only `addr:*` and
  `source:addr` — `numer_porzadkowy`, `ulica`, `gmina`, `teryt_gmina`,
  `wazny_od_lub_data_nadania` and friends are source metadata, and `lokalny_id` is identity, never a
  tag.
- **Precision.** MVT quantises to a 4096 grid, so z14 geometry sits on a ~37 cm grid (±18 cm per
  vertex). Below BDOT10k's own error, but resampled rather than original, and the app says
  `±37 cm from tiles` on every load. Exact geometry comes from `/package`.
- **Clipping.** MVT clips polygons at tile edges. Dedupe by `id` across neighbouring tiles recovers
  most; any still cut are skipped rather than uploaded, and the count is reported. Points are not
  clipped; a point on a shared edge can arrive twice, so addresses dedupe by `lokalny_id`.
- **No per-object dates.** v1 carried `aktualnosc_geometrii`; v2 only keeps recent government-change
  dates in the z5-13 bins. `srcAge` shows blank rather than inventing a year.
- **Addresses are ingested from tiles.** A load reports `N buildings + M addresses`. An address
  without `addr:housenumber` is skipped rather than uploaded as a nameless node.
- **Finding work.** `clusterJump` picks an `agg_cells` bin weighted by
  `n_bdot10k + n_egib + n_prg`, target the bin centroid. One z6 tile is ~110 KB, covers a large
  slice of Poland, and is cached in the `ctx` store. Addresses are the smaller share (0.31 M against
  1.34 M buildings on one central-Poland z6 tile, and 842 of 854 occupied bins hold both), so they
  add weight to the same bins rather than steering towards address-only areas.
- **Requests are widened.** Candidates are sparse: a viewport-sized bbox legitimately returns
  nothing. Every data request is grown to at least `MIN_DATA_SPAN` (0.03°, ~3.3 km) about the view
  centre, and `areaTooBig` judges the widened bounds.

### Decision keys

`bdot:<uuid>`, `egib:<teryt-ref>` (split by registry; plain `bdot:` keeps v1-era decisions valid) and
`prg:<lokalny_id>` for tile addresses, so a verdict sticks to the object rather than to a coordinate.
`/package` and paste features carry no id and key on a geometry+housenumber hash, so the tile route
is the one whose decisions survive reloads.

## What is already in OSM — the review's other half

Real geometry for a ~300 m cell around the candidate comes from the **OSM API
`/api/0.6/map`** (Overpass answered the same query with 504s). Cells are snapped to a
0.003° × 0.005° grid, cached in IndexedDB under `osmctx/<cell>`, and shared by neighbouring
candidates. Only ways tagged `building` become footprints; `/map` returns everything in the box, and
drawing every closed way would put car parks and hedges on screen as buildings.

The verdict comes from geometry, not distance:

- Containment **either way** is an overlap — a candidate inside a footprint is a duplicate, and so
  is a footprint inside the candidate.
- For addresses, the same `addr:housenumber` within **30 m** — on a node or on a building — reports
  as already mapped. Streets are compared when both sides have one, because number 5 exists on every
  street in town. The number is echoed as tagged, not lowercased.
- An address inside a mapped building is an overlap; the note names that building's number when it
  has one. It does **not** yet say "this building has no address", and accepting an address still
  creates a standalone node rather than merging it into the containing building.

**Every address already in OSM is labelled**: free-standing nodes get a cyan dot and their number,
and a building carrying `addr:housenumber` gets its number on the footprint (dimmed, so a node still
reads as the primary address). In a typical Polish cell most numbers are on buildings — 47 numbered
buildings against 3 standalone nodes in one Mokotów cell — so labelling only nodes made the map look
address-free.

**Also drawn:** accepted objects within 250 m in ochre (they are not in OSM yet, and the queued check
wins the label over OSM because it is a mistake you can still fix); candidates still ahead in the
queue, faint, selected by visible bounds and capped at 400; land-cover areas but never judged against
footprints, since a field containing a barn is not a duplicate of the barn.

The centroid index gives a first guess for the tier before the cell arrives. It is a placeholder, not
a verdict: a large building's centroid can be 30 m away while its footprint covers the candidate.

### Review order walks to the nearest candidate

`nearestChain` walks the batch greedily to the nearest unvisited candidate. Sorting by latitude first
left longitude arbitrary, so most steps were teleports; measured on a shuffled 164-object field, p90
step went from 300 m to 41 m and steps over 100 m from 28 to 1 (the remainder is the unavoidable hop
to a detached cluster). Short steps also keep Leaflet from discarding a whole screenful of tiles.

Tier deliberately does **not** participate: chaining each tier separately fragmented the sweep and
raised long steps from 1 to 16 on the same field, and nothing depends on order — `paintChrome`
overrides `c.tier` with the real verdict as soon as the cell loads. Greedy backtracks; the test
asserts on how *rare* long steps are, not on the maximum, and jitters the grid because a perfectly
regular grid ties with latitude order and would assert nothing.

## Editing the outline

Nudge with the pad or arrows (`S.driftStep` per press), drag a vertex, `G` auto-fit, `Q` square the
corners. Every edit snapshots geometry **and** tags with `pushUndo`; the drift readout compares the
centroid against `c.orig`, so it is the only place the original position survives.

`Q` follows iD's orthogonalize rather than snapping to the nearest axis: a corner already within 13°
of a right angle is moved along its bisector, and vertices on nearly straight runs are dropped. A
rotated building keeps its orientation and a 45° bay keeps its angle, because forcing every corner
to 0/90° would invent geometry the source never had — and the tests pin that restraint. It is a
building-only action; land-cover rings share boundaries and must not be reshaped. Projection is to
local metres first: dot products in degrees would bias every move north-south.

## Provenance and staleness

Candidates are **BDOT10k** (GUGiK topographic database) and **PRG**, not *ewidencja budynków*
(EGiB), the county cadastre, which is usually more current. The two disagree, and BDOT being behind
is the normal case rather than a fault.

v1 shipped per-object currency dates; v2 does not, so `srcAge` is blank and undated geometry is
treated as possibly stale. Historically the useful scale was that about half of v1's geometry was
2018 or older and a third dated from 2015, which is why buildings demolished for newer roads were
still present. Registry status (`w budowie`) was similarly worth flagging. Neither is uploaded — they
are not OSM tags.

## CORS

v1 duplicated the header on `/sc/*` and omitted it on `/josm_data`, so neither was readable from a
browser. The v2 rewrite then sent no `Access-Control-Allow-Origin` anywhere, which broke the app
until the header was restored upstream: `openstreetmap-polska/osmpbudynkiv2#6` merged 2026-10-23,
and server `0.4.2` now serves `*` on `/status`, `/tiles` and `OPTIONS /report`.

`tools/mirror-worker/` is the fallback if upstream regresses, selected via Settings → API base. The
`/package` download route never depended on CORS — a navigation is not subject to it — and imagery
comes straight from GUGiK.

**Stale text to fix:** `diagnose()` and the `areaDataUrl()` comment still claim v2 sends no CORS
header. They predate 0.4.2 and are now wrong.

## Imagery

Direct GUGiK WMS (`orto-high` by default), never the budynki proxy: the proxy duplicates
`Access-Control-Allow-Origin` on image responses, so `fetch` can never obtain a tile through it and
the cache and auto-fit are dead while the map still *looks* fine. Do not restore it without
re-measuring.

The origin is HTTP/1.1, so the browser caps it at **six connections** shared by `fetch` and `<img>`,
and it sends no caching headers at all. Requests, not bytes, are the scarce resource. It also drops
roughly 12–17 % of connections mid-body and cuts off bursts that recover with time, which drives the
whole transport design:

- **One request per tile.** A healthy path is IndexedDB hit → paint, or one `fetch` that both paints
  and fills the cache; a probe per source selection decides which. Never `<img>` plus a background
  cache-fill `fetch`: with no cache headers that is two real downloads.
- **No app-level concurrency limiter.** Higher concurrency measured better; the browser's six are
  the cap, and the fix is to stop handing them junk.
- **Spaced healing, not more retries.** Bursts fail; the same URLs succeed minutes later. Blank tiles
  retry later through `<img>` only, on a jittered schedule, so a screenful of blanks cannot look like
  a source-wide failure. A skipped slot while hidden/offline is waited, not spent.
- **A 200 can be a truncated image.** Bodies stop mid-JPEG and still report full dimensions. Reject
  anything without `FFD9`/`IEND` on both read and write, and never let the `<img>` fallback paint what
  the fetch path refused. The `tiles` store was purged once via `S.tilesChecked` for this reason.
- **Missing CORS is inferred in exactly one place.** Only `probeImagery` — network-shaped failure,
  then a resolving `no-cors` fetch, then a loading `<img>` — may set `pixelMode = 'blocked'`. A
  timeout or an HTTP status never does; the per-tile latch is purely a performance switch. At a 12 %
  drop rate, the older per-tile rule false-positived on about six screenfuls in ten.
- **`img.crossOrigin` stays unset.** The `<img>` path must perform no CORS check at all; pixels that
  need reading are read through the `fetch` path, not by tainting the only path that always paints.
- **Constants live at the top of `app.js`** (`TILE_FETCH_TIMEOUT`, `TILE_IMG_TIMEOUT`,
  `TILE_DEADLINE`, `TILE_HEAL_*`). They were derived from a wired link, not a phone — see Open work.
- `tileSize: 512` is legal and would quarter the request count, but the pipeline already runs ~1.0–1.4
  requests per tile, it would orphan 256-keyed cache entries, and a bigger render may cost more server
  time per request, which is what the throttler reacts to. Not used.

## OSM upload

OAuth 2 PKCE, public client, no secret. Redirect URI must match exactly: lowercase host, trailing
slash (`https://dexteriv.github.io/Osmmobile/`). Scopes `read_prefs`, `write_api`.

**`401` from `/oauth2/token` is always `invalid_client`** and means the registration was marked
*confidential* — a browser cannot hold a secret — or the client id is wrong. A wrong redirect URI or
a reused code gives `400 invalid_grant`. The token exchange reads the error body and parks the remedy
in Settings, because a toast is gone before the registration is fixed. `redirectUri()` is one helper
so login and finish cannot disagree.

Changeset tags (`csTags()`, displayed verbatim in the review sheet):

```
created_by=orto-review
comment=<comment> - <locality>
source=BDOT10k;PRG            (settings)
host=<app URL it ran from>
repo=https://github.com/DexterIV/Osmmobile   (settings; omitted when blank)
review_count=<objects in this changeset>
```

No `hashtags`: a hashtag implies a coordinated campaign, and `host` is what iD and Rapid use anyway.
`import=yes` is appended only when the setting is on, and it is **off by default and stays off** —
every object is inspected against imagery, but the geometry still originates from government data, so
the Import Guidelines still apply: announce in the Polska category, use a separate account, one
locality per changeset.

The up-arrow opens the **queue review sheet**, not an upload. Dropping an object there deletes both
its `queue` and `decisions` entry; deleting only the queue entry would hide it from every future
load while never uploading it. Upstream reject reporting is off by default and destructive for other
mappers — it is for objects that should never be imported, not for "cannot tell from this imagery"
(that is *Later*).

## Open in iD

`iD` (or `E`) opens `openstreetmap.org/edit?editor=id` at the candidate, in a new tab (navigating away
would discard the in-memory queue). `background=` is mapped from the imagery preset via
`ID_BACKGROUND`; `comment` and `source` are prefilled. The candidate itself is not in OSM, so iD
cannot select it — the button only helps for objects that are already mapped.

## Land cover

Independent of the buildings path: with no server reachable, building review still works in full.
The private **vibe-osm-importer** keeps producing clipped, overlap-repaired `.osm` tiles; the app
fetches them from `serve_review.py` over HTTPS (localhost HTTP cannot be reached from the GitHub
Pages origin — use a tunnel):

```bash
python serve_review.py --dir ./out --port 8000
cloudflared tunnel --url http://localhost:8000
```

Classes are opt-out so a newly emitted class appears rather than being silently dropped. Areas are
`kind: 'area'`: green, holes preserved, auto-fit refuses them, vertex handles stop at 80 points, and
`overlapVerdict` skips them.

Upload details that bite: relations are parsed in JS and skipped wholesale if the way count disagrees
(a mis-resolved member attaches the wrong hole); shared boundary nodes dedupe across the changeset at
OSM's 7-decimal limit; holes upload as a `type=multipolygon` with **untagged** rings, since tagging
the outer way fills the hole back in.

The app does not fetch source land-cover data itself: BDOT10k opendata is ~33 MB per powiat and sends
no CORS header, and ARiMR's WFS sits behind a WAF that rejected every request from this environment.

`serve_review.py` (importer repo) serves `GET /health`, `GET /index` (tile id, bbox, per-class counts)
and `GET /tile/<id>.osm`. It binds `127.0.0.1`, so a tunnel is the only way a browser on the Pages
origin can reach it.

## Regressions to not reintroduce

Each shipped once and was caught by testing.

1. **XML numeric references.** Decode `&#243;` before re-escaping, or every Polish street uploads as
   `Kr&amp;#243;tka`.
2. **Shoelace precision.** Area and centroid off raw degrees near 21° loses seven digits to
   cancellation; translate to a local frame off the first vertex first.
3. **Wasm growth capacity.** `grow()` and its call sites must derive capacity from the same
   `newCap(cap, need, floor)`; divergent floors wrote past the buffer at ~40k buildings.
4. **Keymap collision.** `A` cannot be accept and WASD-left. Nudging is the arrow keys, and Leaflet is
   constructed with `keyboard: false` so it does not pan underneath.
5. **Unguarded `cur()`.** Every candidate-dependent function early-returns when there is none;
   keyboard handlers bypass `disabled` buttons.
6. **A frozen service worker.** A hardcoded cache name plus cache-first navigation pins the first
   shell forever. The name carries the build id and navigation is stale-while-revalidate.
7. **The start panel over the map.** It is a flow element between `#tags` and `#bar`, not an overlay.
8. **The pad painting under the tiles.** `#map` is `z-index: 0` so Leaflet's panes stay contained;
   controls without their own z-index otherwise draw beneath the tiles.
9. **A permanently disabled file picker.** `#pickBtn` shipped `disabled` with "Loading…" and nothing
   cleared it; `bindUI` enables it.
10. **Shortcuts while typing.** `keydown` must skip `INPUT`, `SELECT`, `TEXTAREA` and
    `isContentEditable`, and ignore everything but Escape while the tag sheet is open.
11. **Deleting a tag on one tap.** Chips open the editor; `pushUndo` snapshots tags as well as
    geometry.
12. **Treating a flaky network as blocked CORS.** A drop, a 5xx and a missing header are the same
    opaque rejection. Only `probeImagery` may latch `pixelMode` (see Imagery); the per-tile latch is
    performance-only and must never touch it.
13. **Tile events on the map.** `GridLayer` fires them without a `propagate` flag, so
    `map.on('tileunload')` never fires. Bind on the layer.
14. **`img.complete` as "still in flight".** An `<img>` with no `src` reports `true`; track your own
    flag or the abort path skips exactly the tiles that need stopping.
15. **Assigning `img.onload`/`onerror` on a tile.** Leaflet nulls both when unloading; use
    `addEventListener` or aborted tiles' promises never settle.
16. **A layer `maxZoom` below the map's.** `_pruneTiles` then calls `_removeAllTiles()`; the imagery
    layer's `maxZoom` must match the map's **and** `maxNativeZoom` must cap real tiles (`osm` needs
    19).
17. **Leaflet's cached container size.** There is no `ResizeObserver` in Leaflet and no `resize`
    event when the panel or tag chips change height. Use one on `#map`, plus a synchronous
    `syncMapSize()` in `fitShape()` because a frame arrives too late.
18. **Trusting a 200 to be a whole image.** Check the format terminator; reject on read as well as
    write; do not let the `<img>` fallback repaint refused bytes.
19. **A cache purge that changes nothing on screen.** Rebuild the imagery layer, or the button looks
    dead.

## Driving it in a browser

Use the desktop browser tools in this environment, or Edge headless on Windows, against
`python -m http.server`. What makes harness results trustworthy:

- **Never `--virtual-time-budget` for network behaviour.** It fires timers instantly, aborting every
  in-flight request; use real wall-clock time and a marker fetch.
- **`--user-data-dir` must be on a native filesystem** (e.g. `%TEMP%`). On a UNC/WSL path IndexedDB
  is unavailable and the app throws before `initMap()`.
- **Send a mobile UA.** Leaflet selects `updateWhenIdle` from it, which changes when tiles load.
- **Fresh profile per run**, and clear the tile cache; a warm cache measures nothing. A cache test
  must also pin the view and let `invalidateSize` settle, because the cache key includes the WMS
  `BBOX`, which depends on the map size.
- **Prefer a local stub tile server** (query-string-keyed failure counter) for tile behaviour. The
  real origin starts throttling after a dozen runs, so late A/B numbers there are noise.

## Performance

On a 17.2 MB / 45k-candidate synthetic package: wasm parse 459 ms, centroids 52 ms, keys 37 ms,
45k nearest-neighbour queries 36 ms, Sobel on 384×384 7.6 ms. **The wasm is not the speed win it was
meant to be** — the same correlation in plain JS ran 1.2× slower, and a regex scan parsed faster than
the wasm scanner. What mattered was the flat-array layout (byte offsets into the source string),
keeping 45k candidates at ~184 MB RSS instead of the several hundred MB a DOM tree needs. Do not
describe the wasm as a large speedup; the mobile gap was never measured.

## Open work

- Update the stale CORS text in `diagnose()` and the `areaDataUrl()` comment — upstream sends the
  header again as of `0.4.2`.
- `README.md` still says addresses are not in the tiles, `/tiles` needs `.pbf`, `/sc/*` sends a
  duplicated header, and the generated `index.html`/`sw.js` are committed. All four are out of date.
- Re-derive the imagery timeouts and heal schedule on the owner's mobile connection. Every number in
  *Imagery* came from a wired link; healing is verified against a stub, not against the real origin
  on a phone.
- Decide whether tile-derived geometry should upload at all, or whether accepting should re-fetch the
  exact outline. ±18 cm is inside BDOT10k's own error, but it is resampled, not original.
- Merging a PRG address into a building that clearly contains it would be more correct than the
  current standalone node, and needs modifying an existing way.
- Tune the auto-fit confidence gate (currently refuses below z=1.6; untested over tree cover and
  snow).
- `streets` is an available upstream layer and is unused; `/lod1/not_in/osm/` could supply heights.

## Licence

GPL-3.0-or-later. `LICENSE` is the canonical text from gnu.org, not transcribed. Each source file
carries a short notice; for `src/app.js` and `src/sw.js` that notice is inlined into the distributed
`index.html` and `sw.js` too.
