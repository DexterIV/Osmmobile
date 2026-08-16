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

`index.html` is **generated** — never edit it directly. Edit `src/` and rebuild. It is committed
because GitHub Pages serves it.

The build fails if any `$('someId')` in `src/app.js` has no matching `id=` in `src/shell.html`.
That check exists because a missing id previously shipped as a runtime crash.

## Layout

| path | role |
|---|---|
| `src/core.ts` | AssemblyScript: `.osm` byte scanner, uniform grid index, Sobel, drift cross-correlation |
| `src/app.js` | all application logic |
| `src/shell.html` | markup + CSS |
| `build.mjs` | compiles wasm, inlines everything, validates output |
| `sw.js`, `manifest.webmanifest`, `icon-*.png` | PWA shell |
| `setup.sh` | WSL bootstrap: deps, gh auth, build, push, enable Pages, serve |

## Data source — verified by reading gugik2osm's source

Base: `https://budynki.openstreetmap.org.pl`. **Every nginx location sets
`Access-Control-Allow-Origin: *`** — browser-side fetching works without a proxy. This was checked
in their `conf/nginx.conf`, not assumed.

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

**Unverified:** whether `/sc/*` is actually live in production. The routes are in the repo's current
`main` and its nginx config, but the authoring environment was firewalled off from that host, so no
endpoint ever returned a real response. Settings → **Run diagnostics** probes all of them.

## Why auto-fit needs the proxy

Auto-fit reads orthophoto pixels: WMS `GetMap` → `createImageBitmap` → canvas → `getImageData` →
wasm Sobel → edge cross-correlation. `getImageData` taints on a cross-origin image without CORS, so
the direct GUGiK endpoints may not work for it. `/orto` adds the headers, which is why it is the
default imagery source. On failure the app disables auto-fit and falls back to the manual drift pad.
The same constraint governs the IndexedDB tile cache, which needs `fetch` and therefore CORS.

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

- Run diagnostics from the real origin and confirm all probes pass, especially `imagery` reporting
  pixels readable.
- Tune the auto-fit confidence gate. Currently refuses below z=1.6; untested against real
  orthophoto over tree cover and snow.
- Addresses currently upload as standalone nodes. Merging an address into an existing OSM building
  when one clearly contains it would be more correct, and needs modifying an existing way rather
  than creating one.
- `streets` is an available upstream layer and is not used at all.
- `/lod1/not_in/osm/` exists upstream and could supply building heights.
