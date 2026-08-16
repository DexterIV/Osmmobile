#!/usr/bin/env bash
# Publish Orto Review to GitHub Pages. Run from the repo root:  bash publish.sh
set -euo pipefail

OWNER=DexterIV
REPO=Osmmobile
export PATH="$HOME/.local/bin:$PATH"

say() { printf '\n\033[1;35m==\033[0m %s\n' "$*"; }

command -v gh >/dev/null || { echo "gh not found in ~/.local/bin"; exit 1; }

if ! gh auth status --hostname github.com >/dev/null 2>&1; then
  say "Signing in to github.com"
  echo "Choose: GitHub.com  ->  HTTPS  ->  authenticate with a browser."
  gh auth login --hostname github.com --git-protocol https --web
fi
gh auth setup-git --hostname github.com

say "Pushing to $OWNER/$REPO"
git push -u origin main

say "Enabling GitHub Pages"
if gh api "repos/$OWNER/$REPO/pages" >/dev/null 2>&1; then
  echo "already enabled"
else
  gh api -X POST "repos/$OWNER/$REPO/pages" \
    -f 'source[branch]=main' -f 'source[path]=/' >/dev/null \
    && echo "enabled" \
    || echo "enable it by hand: Settings -> Pages -> main / root"
fi

URL="https://$(echo "$OWNER" | tr 'A-Z' 'a-z').github.io/$REPO/"
say "Done"
echo "Phone URL (first build takes a minute or two): $URL"
echo
echo "Then, for OSM sign-in, register that exact URL as the redirect URI:"
echo "  https://www.openstreetmap.org/oauth2/applications/new"
echo "  public client with PKCE, scopes read_prefs + write_api"
