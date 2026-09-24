// Stage D test helper: '@/x/dir' → src/x/dir/index.js when `dir` is a folder
// (Next resolves folder imports; the shared tests/loader.mjs does not yet —
// notify.js imports '@/lib/templates/client'). Chains to the shared loader
// for everything else.
import { pathToFileURL, fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';
import path from 'node:path';

const src = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'src');

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@/')) {
    const p = path.join(src, specifier.slice(2));
    try {
      if (statSync(p).isDirectory()) return { url: pathToFileURL(path.join(p, 'index.js')).href, shortCircuit: true };
    } catch {}
  }
  // Extension-less relative imports inside src (e.g. './stage-a') → .js
  if (specifier.startsWith('.') && !path.extname(specifier) && context.parentURL?.startsWith(pathToFileURL(src).href)) {
    const p = path.join(path.dirname(fileURLToPath(context.parentURL)), specifier);
    try {
      if (statSync(`${p}.js`).isFile()) return { url: pathToFileURL(`${p}.js`).href, shortCircuit: true };
    } catch {}
  }
  return next(specifier, context);
}
