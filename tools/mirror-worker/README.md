# Mirror worker — makes budynki v2 fetchable again from the deployed PWA

The deployed app lives at `https://dexteriv.github.io/Osmmobile/` but its data
lives at `https://budynki.openstreetmap.org.pl`. Upstream's 2026-10 v2 rewrite
stopped sending any `Access-Control-Allow-Origin` (v1 sent `*`), so the browser
refuses every cross-origin fetch to it. This Worker adds exactly that one
header and forwards everything else verbatim. No auth, no proxy tricks, no
third party — the traffic goes through your own Cloudflare account.

## Deploy (once, ~10 minutes)

1. `npm install -g wrangler` (or use `npx wrangler`).
2. Create the mirror directory first (this file lives in `tools/mirror-worker/`
   in the repo): it needs to be its own tiny `worker.js` + `wrangler.toml`,
   deploy it from anywhere:

   ```bash
   npx wrangler login
   npx wrangler deploy tools/mirror-worker/worker.js --name osmmobile-mirror --compatibility-date 2026-10-01
   ```

   (Or make a real project from `worker.js` here plus a `wrangler.toml` with
   `name = "osmmobile-mirror"` — same result.)
3. It answers at `https://osmmobile-mirror.<your-subdomain>.workers.dev`.
4. In the app: Settings → **API base**, paste that URL, Save.
5. Settings → **Run diagnostics** must now show `tiles ok ...`, `status ok v...`,
   `package ok ... features` — the build id line tells you the deployed
   front-end actually contains the v2 migration (merged PR #6).

## Optional hardening

- `ALLOWED_ORIGINS` variable (comma-separated, e.g.
  `https://dexteriv.github.io`) restricts who may call the mirror. Unset = `*`,
  which is tolerable because the Worker only ever mirrors public upstream data
  and the four app endpoints.
- POST `/report` vetoes an object for *everyone* using upstream — the app ships
  it off by default (`reportRejects` off in Settings), keep it that way.

## Cost / load

Free tier: 100 000 requests/day. A review session costs roughly one request per
screenful — this will never come close. Tiles pass through uncached on purpose:
they update minute-by-minute and `public, max-age=60` in the response headers
lets the browser dedupe a moving map instead.

## If upstream restores the header instead

Delete the Worker and flip API base back to the default — nothing in the app
depends on the mirror existing; it is one settings value.
