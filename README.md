# Orto Review

Review [BDOT10k](https://www.geoportal.gov.pl/) building outlines and PRG address points against the
GUGiK orthophoto, one object at a time, on a phone — then upload the good ones to OpenStreetMap as
ordinary changesets.

**Live: <https://dexteriv.github.io/Osmmobile/>** · Source: <https://github.com/DexterIV/Osmmobile>

The whole application is one file. `index.html` has Leaflet and a WebAssembly core inlined; there is
no bundler, no framework and no runtime dependency. Copy that single file to any HTTPS origin and it
works.

## What it does

- Shows one candidate at a time over the orthophoto, with **what is already in OpenStreetMap** drawn
  underneath: existing building footprints as dashed cyan outlines, existing address points with
  their house numbers. Overlap is judged from real geometry, so a candidate sitting inside a building
  that is already mapped is flagged instead of being called *clear*.
- **Accept / Reject / Later** per object, with the verdict stored against the upstream object id, so
  a decision sticks even if you meet the object again from a different download.
- Nudge the outline with a drift pad, drag individual vertices, or **auto-fit** by cross-correlating
  Sobel edges of the outline against the orthophoto pixels.
- **Edit tags** before accepting: add, change or remove any key, with one-tap presets for the keys
  these datasets usually need.
- **Review the whole queue before anything is sent**, including the exact changeset tags, and drop
  individual objects from it.
- Works offline once loaded: an IndexedDB tile cache, and everything persistent lives in IndexedDB
  rather than `localStorage`.

## Keys

`A` accept · `R` reject · `L` later · `G` auto-fit · `Z` undo · `V` toggle vertices · `E` open in iD · arrows nudge.

## Build

Requires Node and npm.

```bash
npm install
npm run build      # asc src/core.ts -> core.wasm, then inlines Leaflet + wasm into index.html
npm test           # wasm kernels, retry logic, .osm parsing, vector tiles, OSM context, tag editing
npm run serve      # http://localhost:8080
```

| path | role |
|---|---|
| `src/core.ts` | AssemblyScript: `.osm` byte scanner, uniform grid index, Sobel, drift cross-correlation |
| `src/app.js` | all application logic |
| `src/shell.html` | markup and CSS |
| `src/sw.js` | service worker source; `__BUILD_ID__` is stamped in at build time |
| `build.mjs` | compiles the wasm, inlines everything, validates the output |
| `index.html`, `sw.js` | **generated**, committed because GitHub Pages serves them |

`index.html` and `sw.js` are build artefacts. Edit `src/` and rebuild; never edit them directly.

The build refuses to produce output if any `$('someId')` in `src/app.js` has no matching `id=` in the
markup, if a bundled script fails to parse, or if `src/sw.js` has lost its `__BUILD_ID__` placeholder.
Each of those shipped as a bug once.

## Data

Candidates come from [gugik2osm](https://github.com/openstreetmap-polska/gugik2osm) at
`budynki.openstreetmap.org.pl`, and existing OSM data for comparison comes from the OpenStreetMap
API.

There is an important constraint. That server's `Access-Control-Allow-Origin` header is sent **twice**
on `/sc/*` and **not at all** on `/josm_data`, and a browser rejects both cases — so those endpoints
cannot be read from a web app at all, whoever hosts it. Consequently:

- Buildings are read from the **vector tiles** (`/tiles/{z}/{x}/{y}.pbf`), which send the header once.
  Their geometry is quantised to the tile grid, about 37 cm at the deepest zoom served, and the app
  says so on every load.
- **Addresses are not in those tiles**, so they arrive by file: *Get this area's data* opens the
  server's own export in a new tab — a plain navigation, which CORS does not restrict — and you paste
  it back or open the saved file.
- *Take me somewhere* uses the clustered tiles rather than the upstream `/random/` endpoint, which
  returns 500.

`CLAUDE.md` records the measurements behind all of that, including how to re-check it if the upstream
headers are fixed.

## Uploading

OAuth 2 with PKCE. Register an application at
<https://www.openstreetmap.org/oauth2/applications/new>:

- Redirect URI: this page's exact URL, e.g. `https://dexteriv.github.io/Osmmobile/` — the settings
  sheet shows it in a tappable field, so copy it from there.
- Scopes: `read_prefs` and `write_api`.
- **Leave "Confidential application?" unticked.** A browser holds no client secret, and a confidential
  registration makes the token exchange fail with `401 invalid_client`.

Each changeset carries:

```
created_by=orto-review
comment=<your comment> — <locality>
source=BDOT10k;PRG
host=<the app URL>
repo=https://github.com/DexterIV/Osmmobile
review_count=<objects in this changeset>
```

`import=yes` is **off by default and should stay off**. Every candidate is inspected against imagery,
so these are not automated edits, and labelling them as such invites reverts.

Reviewing each object does **not** make this "not an import" in the wiki's sense: the geometry still
originates from BDOT10k, so the [Import Guidelines](https://wiki.openstreetmap.org/wiki/Import/Guidelines)
still apply. Announce it in the Polska category on community.openstreetmap.org, use a separate
account, and keep one locality per changeset.

Reporting rejects upstream is **off by default** and is destructive for other mappers — it removes the
object for everyone. Use it only for things that should never be imported, not for "I cannot tell from
this imagery", which is what *Later* is for.

## Licence

GPL-3.0-or-later. See [LICENSE](LICENSE).

Bundled third-party code, both GPL-compatible:

- [Leaflet](https://leafletjs.com/) 1.9.4, BSD-2-Clause — inlined into `index.html`, its copyright
  banner preserved.
- The WebAssembly core is compiled from `src/core.ts` by
  [AssemblyScript](https://www.assemblyscript.org/) (Apache-2.0), a build-time dependency only.

Map data © OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright). Orthophoto and
BDOT10k/PRG data from GUGiK.
