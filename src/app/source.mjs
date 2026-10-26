// Reads the app fragments in manifest order and joins them into the single
// classic script that build.mjs inlines. Node-only: this file is not part of
// the concatenation itself.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { APP_PARTS } from './manifest.mjs';

const dir = dirname(fileURLToPath(import.meta.url));

export function readApp() {
  return APP_PARTS.map((part) => readFileSync(join(dir, part), 'utf8')).join('');
}
