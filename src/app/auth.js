const OSM = 'https://www.openstreetmap.org';
const API = OSM + '/api/0.6';

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The authorize and token requests must send a byte-identical redirect_uri, and
// it must equal the registered one. These were computed in two places and did
// not agree: login stripped any fragment, finishLogin did not.
function redirectUri() {
  return location.href.split('?')[0].split('#')[0];
}

async function login() {
  if (!S.clientId) { openSettings(); toast('Paste an OAuth client ID first', 'warn'); return; }
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  sessionStorage.setItem('pkce', verifier);
  const redirect = redirectUri();
  location.href = OSM + '/oauth2/authorize?client_id=' + encodeURIComponent(S.clientId) +
    '&redirect_uri=' + encodeURIComponent(redirect) + '&response_type=code' +
    '&scope=' + encodeURIComponent('read_prefs write_api') +
    '&code_challenge=' + challenge + '&code_challenge_method=S256';
}

async function finishLogin() {
  const p = new URLSearchParams(location.search);
  const code = p.get('code');
  if (!code) return;
  const verifier = sessionStorage.getItem('pkce');
  const redirect = redirectUri();
  history.replaceState({}, '', redirect);
  if (!verifier) {
    // sessionStorage is per-tab, so finishing the flow in a different tab or
    // window loses the verifier. This used to return in silence.
    authFail('the PKCE verifier was lost — start and finish sign-in in the same tab');
    return;
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code', code, redirect_uri: redirect,
    client_id: S.clientId, code_verifier: verifier,
  });
  const r = await fetch(OSM + '/oauth2/token', { method: 'POST', body });
  if (!r.ok) {
    // The status alone was all this used to report, which hid the one thing
    // that identifies the fault. OSM answers 401 invalid_client when the app is
    // registered as confidential, or when the client id is simply unknown.
    const j = await r.json().catch(() => null);
    const err = (j && j.error) || ('HTTP ' + r.status);
    let hint;
    if (r.status === 401 || err === 'invalid_client') {
      hint = 'the OAuth app must be a public client — edit it on openstreetmap.org and untick ' +
        '“Confidential application?”, and check the client ID matches exactly';
    } else if (err === 'invalid_grant') {
      hint = 'the redirect URI must equal ' + redirect +
        ' exactly, and an authorization code can only be used once — start sign-in again';
    } else {
      hint = (j && j.error_description) || 'see the browser console for the response';
    }
    console.warn('oauth token exchange failed', r.status, j);
    authFail(err + ' — ' + hint);
    return;
  }
  const j = await r.json();
  await dbPut('kv', 'token', j.access_token);
  sessionStorage.removeItem('pkce');
  await dbDel('kv', 'authError');
  paintUser();
  toast('Signed in to OpenStreetMap');
}

// A toast lasts three seconds and this needs reading while you fix the
// registration, so the reason is also parked in settings beside the client ID.
async function authFail(msg) {
  await dbPut('kv', 'authError', msg).catch(() => {});
  const el = $('authNote');
  if (el) { el.textContent = 'Last sign-in attempt: ' + msg; el.style.color = 'var(--ochre)'; }
  toast('Sign-in failed: ' + msg, 'warn');
  openSettings();
}

async function token() { return await dbGet('kv', 'token'); }

async function paintUser() {
  const t = await token();
  $('userBtn').textContent = t ? 'signed in' : 'sign in';
  $('userBtn').className = t ? 'ok' : '';
}

// Show the build id in the top strip so you can tell at a glance whether
// you're running the deployed build (matches Settings → Run diagnostics)
function paintBuildId() {
  const el = $('buildId');
  if (!el) return;
  el.textContent = typeof BUILD_ID === 'string' ? 'v:' + BUILD_ID : 'v:dev';
  el.title = 'Build id — matches Settings → Run diagnostics';
}

// The tags every changeset carries. Built as pairs so the review sheet can show
// exactly what will be sent instead of describing it.
//
// There is no `hashtags` tag. It read `#orto-review`, which tells a reviewer
// nothing they cannot see from `created_by`, and hashtags are for campaigns that
// someone is actually coordinating. `host` and `repo` replace it: `host` is what
// iD and Rapid use for the editor's address, and `repo` points at the source so
// anyone querying an edit can read the code that made it.
function csTags(count, city) {
  const t = [
    ['created_by', 'orto-review'],
    ['comment', S.comment + ' — ' + city],
    ['source', S.source],
    ['host', location.href.split('?')[0].split('#')[0]],
  ];
  if (S.repo) t.push(['repo', S.repo]);
  if (S.importTag) t.push(['import', 'yes']);
  t.push(['review_count', String(count)]);
  return t;
}

// ---- Land cover, from the importer's own server -----------------------------
// Kept deliberately separate from the buildings path. Buildings come from vector
// tiles and need nothing here, so with no server configured or reachable the
// building review still works in full — that separation is a requirement, not a
// side effect, so do not fold these together.
//
// The geometry work stays in vibe-osm-importer: it clips against fresh Overpass,
// de-overlaps exactly, preserves holes and drops slivers. serve_review.py only
// indexes and serves what it wrote. Nothing is re-derived here; this fetches,
// filters by class, and reviews.

// Every class the importer emits. Order is the order shown in settings.
