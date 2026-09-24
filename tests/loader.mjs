// Test-only module hooks: '@/…' → src/…, '@vercel/kv' → the in-memory fake,
// src/**/*.js treated as ES modules, and .json imported as a default export.
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');

export async function resolve(specifier, context, next) {
  if (specifier === '@vercel/kv') return { url: pathToFileURL(path.join(root, 'tests/fake-kv.mjs')).href, shortCircuit: true };
  if (specifier.startsWith('@/')) {
    let p = path.join(src, specifier.slice(2));
    if (!path.extname(p)) p += '.js';
    return { url: pathToFileURL(p).href, shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.startsWith('file:') && url.endsWith('.json')) {
    const text = await readFile(fileURLToPath(url), 'utf8');
    return { format: 'module', source: `export default ${text};`, shortCircuit: true };
  }
  if (url.startsWith(pathToFileURL(src).href) && url.endsWith('.js')) {
    return { format: 'module', source: await readFile(fileURLToPath(url), 'utf8'), shortCircuit: true };
  }
  return next(url, context);
}
