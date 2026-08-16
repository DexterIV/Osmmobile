import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const src = (f) => join(root, 'src', f);

const asc = join(root, 'node_modules', 'assemblyscript', 'bin', 'asc.js');
if (!existsSync(asc)) {
  console.error('missing dependencies — run: npm install');
  process.exit(1);
}

execFileSync(process.execPath, [
  asc, src('core.ts'),
  '-o', join(root, 'core.wasm'),
  '--runtime', 'minimal',
  '--optimize', '-O3',
  '--noAssert',
], { stdio: 'inherit' });

const wasm = readFileSync(join(root, 'core.wasm'));
const leafletJs = readFileSync(join(root, 'node_modules/leaflet/dist/leaflet.js'), 'utf8')
  .replace(/\/\/# sourceMappingURL=.*/g, '');
const leafletCss = readFileSync(join(root, 'node_modules/leaflet/dist/leaflet.css'), 'utf8');
const shell = readFileSync(src('shell.html'), 'utf8');
const app = readFileSync(src('app.js'), 'utf8');

const head = [
  '<link rel="manifest" href="./manifest.webmanifest">',
  '<link rel="apple-touch-icon" href="./icon-192.png">',
  '<style>', leafletCss, '</style>',
].join('\n');

const tail = [
  '<script>', leafletJs, '</script>',
  '<script>', `const WASM_B64="${wasm.toString('base64')}";`, '</script>',
  '<script>', app, '</script>',
  '<script>',
  "if ('serviceWorker' in navigator && location.protocol === 'https:') {",
  "  addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));",
  '}',
  '</script>',
].join('\n');

const out = shell.replace('</head>', head + '\n</head>').replace('</body>', tail + '\n</body>');

for (const m of out.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
  try { new Function(m[1]); } catch (err) {
    console.error('bundled script failed to parse:', err.message);
    process.exit(1);
  }
}
const ids = new Set([...out.matchAll(/id="([\w]+)"/g)].map((m) => m[1]));
const missing = [...new Set([...out.matchAll(/\$\('([\w]+)'\)/g)].map((m) => m[1]))]
  .filter((u) => !ids.has(u));
if (missing.length) {
  console.error('markup is missing ids referenced by the code:', missing.join(', '));
  process.exit(1);
}

writeFileSync(join(root, 'index.html'), out);

// Stamp the service worker with a hash of what it is caching. Without this
// sw.js is byte-identical between deploys, so the browser never checks for an
// update and an installed PWA keeps serving the index.html it first cached.
const buildId = createHash('sha256').update(out).digest('hex').slice(0, 12);
const swSrc = readFileSync(src('sw.js'), 'utf8');
if (!swSrc.includes('__BUILD_ID__')) {
  console.error('src/sw.js no longer contains __BUILD_ID__ — updates would stop reaching installed clients');
  process.exit(1);
}
const sw = swSrc.replace(/__BUILD_ID__/g, buildId);
try { new Function(sw); } catch (err) {
  console.error('sw.js failed to parse:', err.message);
  process.exit(1);
}
writeFileSync(join(root, 'sw.js'), sw);

console.log(`index.html  ${(out.length / 1024).toFixed(0)} KB   wasm ${(wasm.length / 1024).toFixed(1)} KB   sw ${buildId}`);
