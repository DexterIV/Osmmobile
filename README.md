# Orto Review — install

Couch-side review of BDOT10k buildings and PRG addresses against the orthophoto.

## Build from source

```bash
npm install
npm run build      # compiles src/core.ts to wasm, inlines everything into index.html
npm run serve      # http://localhost:8080
```

Layout:

```
src/core.ts                AssemblyScript kernels: .osm scanner, grid index, Sobel, drift correlation
src/app.js                 application logic
src/shell.html             markup and styles
build.mjs                  compiles the wasm and inlines Leaflet + wasm into index.html
index.html                 built artifact, committed so Pages can serve it
setup.sh                   WSL bootstrap: deps, gh auth, build, push, enable Pages, serve
```

`index.html` is generated. Edit the files in `src/` and re-run `npm run build`.

## The minimum you need is one file

`index.html` is the entire app — Leaflet and the WASM core are inlined. Upload just that and it
works. The other files only add the standalone launcher and offline shell:

```
index.html                 the app, complete and self-contained
manifest.webmanifest       optional - launches without browser chrome
sw.js                      optional - opens with no network
icon-192.png               optional
icon-512.png               optional
icon-maskable-512.png      optional
deploy.sh                  optional - publish from a computer
```

It has to be served over HTTPS. Not because of the app, but because Chrome restricts IndexedDB on
`file://` (that is your tile and decision cache) and OAuth 2 PKCE needs a registered redirect URI.

---

## Option A - from the phone, no terminal

The whole flow in mobile Chrome.

1. Download `index.html` to your phone.
2. Go to `github.com/new`. Name it `Osmmobile`, public, **no** README. Create.
3. On the empty repo page tap **uploading an existing file**. Pick `index.html` from Downloads.
   Commit. (If the repo already has a commit, that shortcut is gone - use **Add file** ->
   **Upload files** instead.)
4. Repo -> **Settings** -> **Pages** -> Source: *Deploy from a branch* -> branch `main`, folder
   `/ (root)` -> Save. Chrome's menu -> *Desktop site* makes Settings easier to navigate.
5. Wait a minute or two, then open:

   ```
   https://dexteriv.github.io/Osmmobile/
   ```

To add the PWA extras later, upload the other files into the same repo the same way. Include the
empty `.nojekyll` file - it turns off Jekyll processing, which this site does not need and which
only slows the build down.

## Option B - from a computer

```bash
./deploy.sh
```

Creates `DexterIV/Osmmobile` public, pushes, enables Pages. Re-run to publish updates. `gh` is
pinned to `github.com` explicitly so it cannot pick up any other configured host.

## Option C - Netlify Drop

`app.netlify.com/drop` gives an instant HTTPS site with no repo. Tap the dropzone and select the
file. Claim the site afterwards or the URL is temporary, and rename it to something stable - the
URL becomes your OAuth redirect URI, so it must not change.

**This may be awkward from mobile Chrome; the dropzone is built for desktop drag-and-drop.** If it
does not cooperate, use Option A.

## Option D - no hosting at all

`http://localhost` counts as a secure context, so a local server works and stays fully offline.

1. Termux from F-Droid - the Play Store build is abandoned.
2. `pkg install python`
3. `cd ~/storage/shared/orto && python -m http.server 8080`
4. Open `http://localhost:8080/`

Termux must stay running. The service worker will not register over plain `http`, so no standalone
launcher, but IndexedDB caching works fine. **Whether openstreetmap.org accepts an
`http://localhost:8080/` redirect URI is untested - most providers allow localhost, but if it is
rejected you can review and queue, just not upload.**

---

## Register the OAuth application

openstreetmap.org -> **My Settings** -> **OAuth 2 applications** -> *Register new application*.

- Redirect URI, exactly, lowercase, trailing slash:

  ```
  https://dexteriv.github.io/Osmmobile/
  ```

  Not `DexterIV.github.io` - browsers normalise hostnames, so that will not match. The path stays
  case-sensitive and must match the repo name, capital O included.

- Permissions: `read_prefs` and `write_api`.
- Tick the public client / PKCE option. Never paste a client secret anywhere.

The app shows its own URL in the settings sheet - tap the field to select it and copy from there
rather than typing it.

Client ID goes in: gear -> *OSM OAuth 2 client ID* -> Save -> `sign in`.

## Install to the home screen

Chrome -> menu -> **Add to Home screen**. With the manifest present it launches without browser
chrome; without it you get a shortcut that opens a tab.

Sign in **once in a normal browser tab before installing**. Same origin means the installed app
reads the same IndexedDB, so the token is already there. This dodges the flakiest part of PWA
OAuth, where the authorize redirect leaves the app's scope and Chrome hands it to a Custom Tab.

## First run

No downloading, no file picking. The app talks to budynki.openstreetmap.org.pl directly - every
endpoint there sends `Access-Control-Allow-Origin: *`.

1. **Take me somewhere** jumps to a spot with lots waiting (`GET /random/`, which the server
   weights 95% toward high-count areas).
2. Or pan the map and hit **Load this area**. Needs zoom 12 or closer.
3. Review. `Accept` only queues - nothing leaves the phone until you press the up arrow.

Candidates come from `/sc/proposed_buildings` and `/sc/proposed_addresses` as GeoJSON, each feature
carrying its upstream `lokalnyid`. That id is what the decision store keys on, so a reject sticks
to the actual object rather than to a coordinate hash.

Opening a downloaded `.osm` package still works - it is behind the `...` button.

### Reporting rejects upstream

Off by default. Enabled, a reject POSTs the id to `/sc/proposed_{buildings,addresses}/report`,
which drops the object from everyone's candidate list. Use it for things that should never be
imported - a building demolished years ago, an address on an empty field. Do **not** use it for
"cannot tell from this imagery"; press **Later** instead.

### Imagery

Default is `budynki.openstreetmap.org.pl/orto`, their own reverse proxy in front of the GUGiK ORTO
WMS, which adds CORS headers. That is what makes Auto-fit and the tile cache work at all - reading
pixels needs `fetch`, and `fetch` needs CORS. `LAYERS=Raster` is confirmed from their `map.js`, not
a guess any more. The direct GUGiK endpoints are still selectable if you want to compare.

Keys, if you dock a keyboard: `A` accept, `R` reject, `L` later, `G` auto-fit, `Z` undo,
`V` vertices, arrow keys nudge.

## Changeset tagging

Defaults, assuming one decision per object:

```
created_by=orto-review
comment=<your comment> - <locality>
source=BDOT10k;PRG
hashtags=#orto-review
review_count=<objects in the changeset>
```

`import=yes` is **off** by default. Because every candidate is looked at against imagery, these are
not automated edits and should not be labelled as such - mislabelling invites reverts that are not
warranted. `hashtags` is what OSMCha and the Tasking Manager index on, so the work stays findable
and auditable without the wrong label. The toggle is in settings if you ever switch to unreviewed
bulk upload.

Reviewing each object does not make this *not an import* in the wiki's sense - the geometry still
comes from BDOT10k, so the Import Guidelines still apply. It just is not a *mechanical* edit.
Announce yourself in the Polska category on community.openstreetmap.org, use a separate account,
and keep changesets to one locality.

## Troubleshooting

**Imagery blank.** Switch imagery to one of the direct GUGiK options, or check that the proxy at
`budynki.openstreetmap.org.pl/orto` is up.

**Auto-fit greyed out.** Means pixel reads were blocked. Should not happen on the default proxy
source; it will happen on the direct GUGiK endpoints if they omit CORS headers. Switch back to the
proxy. The drift pad works either way.

**Fetch failed / 4xx on load.** The area may be too large - zoom to 12 or closer. Server caps
results at 50000 objects per layer.

**"Low confidence" on auto-fit.** Deliberate - it will not move anything below z=1.6. Tree cover
and fresh snow defeat edge matching. Nudge by hand.

**Upload returns 409.** Someone edited the area while the package sat in your queue. Re-download
it; already-decided candidates are skipped.
