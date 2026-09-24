/**
 * Read the plain-text tables in /config (SPEC §12: chains, spamwords, …).
 * One entry per line, `#` comments, blank lines ignored, lower-cased.
 * Throws when the file cannot be read — callers alert instead of guessing.
 */

import fs from 'fs';
import path from 'path';

const cache = new Map();

export function readListFile(name) {
  if (cache.has(name)) return cache.get(name);
  const file = path.join(process.cwd(), 'config', name);
  const text = fs.readFileSync(file, 'utf8');
  const list = text.split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#'));
  cache.set(name, list);
  return list;
}

export function chainHosts() {
  return new Set(readListFile('chains.txt').map((h) => h.replace(/^www\./, '')));
}

export function spamWords() {
  return readListFile('spamwords.txt');
}
