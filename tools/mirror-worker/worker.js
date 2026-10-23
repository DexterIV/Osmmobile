// CORS-adding reverse proxy in front of https://budynki.openstreetmap.org.pl
//
// Why this exists, in one line: on 2026-10-11 upstream replaced their server
// ("budynki/adresy v2", openstreetmap-polska/osmpbudynkiv2) and the rewrite
// stopped sending Access-Control-Allow-Origin on every endpoint — v1 sent `*`.
// Their own page is same-origin so they never noticed, but a hosted PWA at
// dexteriv.github.io is refused cross-origin before any response body is seen,
// no matter what the client does. A mirror that we control adding ONE header is
// the smallest honest fix; it was deliberately NOT a third-party CORS proxy
// (see CLAUDE.md's privacy notes) precisely so the traffic stays in infra we
// own.
//
// Scope is locked to the four endpoints the app actually uses, so this cannot
// become a general-purpose open proxy:
//   GET  /tiles/{z}/{x}/{y}      vector tiles (NOTE: no .pbf suffix in v2)
//   GET  /package?bbox=...       the /josm_data successor, GeoJSON
//   GET  /status, GET /updates   diagnostics / recent changes
//   POST /report                 veto an unmatched object
// Everything else 404s here without touching upstream.

const UPSTREAM = 'https://budynki.openstreetmap.org.pl';

// Restrictive CORS by default: set ALLOWED_ORIGINS in the Worker settings
// (wrangler vars or dashboard) to a comma-separated list, e.g.
//   ALLOWED_ORIGINS=https://dexteriv.github.io
// Unset means *. Fine for a personal mirror; an import tool's runs show up as
// ordinary edits anyway, and everything it serves is already public.
function corsHeaders(env, origin) {
  const allowed = String(env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
  const match = allowed.includes('*')
    ? origin : allowed.find((a) => a === origin);
  return match
    ? { 'Access-Control-Allow-Origin': match, Vary: 'Origin' }
    : { Vary: 'Origin' };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+/, '/');

    // Path allowlist: tiles need leading "/" then digit segments only.
    const tiles = path.match(/^\/tiles\/(\d+)\/(\d+)\/(\d+)$/);
    const ok = tiles || ['/package', '/status', '/updates', '/report'].includes(path);
    if (!ok) {
      return new Response('not a mirrored upstream path\n', {
        status: 404,
        headers: Object.assign({ 'Content-Type': 'text/plain' }, corsHeaders(env, request.headers.get('Origin') || '*')),
      });
    }

    const upstream = new URL(UPSTREAM + path);
    for (const [k, v] of url.searchParams) upstream.searchParams.set(k, v);

    // Re-triplicate pass-through: send method, body and headers, FORWARD the
    // response verbatim. No caching: tiles change with OSM replication every
    // minute and packages are byte-fresh per bbox; workers.dev free tier gives
    // 100k requests/day, ~40x a day of reviewing.
    const resp = await fetch(upstream, {
      method: request.method,
      headers: request.method === 'POST'
        ? new Headers({ 'Content-Type': request.headers.get('Content-Type') || 'application/json' })
        : undefined,
      body: request.method === 'POST' ? request.body : undefined,
    });

    const headers = new Headers(resp.headers);
    headers.delete('access-control-allow-origin');
    const cors = corsHeaders(env, request.headers.get('Origin'));
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    headers.set('Cache-Control', 'public, max-age=60');

    return new Response(resp.body, { status: resp.status, headers });
  },
};
