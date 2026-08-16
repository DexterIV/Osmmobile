#!/usr/bin/env bash
set -euo pipefail

OWNER=DexterIV
REPO=Osmmobile
PORT=8080

say() { printf '\n\033[1;35m==\033[0m %s\n' "$*"; }

say "Installing dependencies"
sudo apt-get update -qq
sudo apt-get install -y -qq git curl python3 nodejs npm

if ! command -v gh >/dev/null; then
  if ! sudo apt-get install -y -qq gh 2>/dev/null; then
    sudo mkdir -p -m 755 /etc/apt/keyrings
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
    sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
    sudo apt-get update -qq
    sudo apt-get install -y -qq gh
  fi
fi

echo "git  $(git --version | awk '{print $3}')"
echo "node $(node -v)"
echo "gh   $(gh --version | head -1 | awk '{print $3}')"

if ! gh auth status >/dev/null 2>&1; then
  say "Signing in to GitHub"
  echo "Pick HTTPS when asked about git protocol, and let it configure git credentials."
  gh auth login
fi
gh auth setup-git

WORK="$HOME/$REPO"
if [ ! -d "$WORK/.git" ]; then
  say "Cloning $OWNER/$REPO"
  git clone "https://github.com/$OWNER/$REPO.git" "$WORK" 2>&1 | tail -2
fi

say "Copying project files"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$HERE" != "$WORK" ]; then
  cp -r "$HERE"/src "$HERE"/test "$HERE"/build.mjs "$HERE"/package.json "$HERE"/CLAUDE.md \
        "$HERE"/manifest.webmanifest "$HERE"/sw.js "$HERE"/icon-*.png "$HERE"/.nojekyll \
        "$HERE"/README.md "$WORK"/
fi
cd "$WORK"

cat > .gitignore <<'EOF'
node_modules/
core.wasm
EOF

say "Building"
npm install --no-audit --no-fund --silent
npm run build

say "Committing and pushing"
git add -A
git -c user.name="$OWNER" -c user.email="$OWNER@users.noreply.github.com" \
    commit -m "Orto Review: source, build script and bundled app" || echo "nothing to commit"
git branch -M main
git push -u origin main

say "Enabling GitHub Pages"
if gh api "repos/$OWNER/$REPO/pages" >/dev/null 2>&1; then
  echo "already enabled"
else
  gh api -X POST "repos/$OWNER/$REPO/pages" --input - <<JSON || echo "enable it by hand: Settings -> Pages -> main / root"
{"source":{"branch":"main","path":"/"}}
JSON
fi

URL="https://$(echo "$OWNER" | tr 'A-Z' 'a-z').github.io/$REPO/"
say "Done"
echo "Published (allow a minute or two): $URL"
echo "Register that exact URL as the OAuth redirect URI:"
echo "  https://www.openstreetmap.org/oauth2/applications/new"
echo "  scopes read_prefs + write_api, public client with PKCE"
echo
if command -v claude >/dev/null; then
  echo "Claude Code is installed. From $WORK you can run: claude"
  echo "CLAUDE.md in the repo carries the full project context."
else
  echo "To hand this project to Claude Code:  curl -fsSL https://claude.ai/install.sh | bash"
fi
echo
say "Serving locally on http://localhost:$PORT"
echo "localhost counts as a secure context, so IndexedDB and PKCE both work here."
echo "To test sign-in locally, register http://localhost:$PORT/ as a second redirect URI."
echo "Ctrl-C to stop."
exec python3 -m http.server "$PORT"
