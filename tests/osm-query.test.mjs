import test from 'node:test';
import assert from 'node:assert/strict';
import { namePattern, overpassQuery } from '../scripts/leadfinder/sources.mjs';

const matches = (kw, name) => new RegExp(namePattern(kw), 'i').test(name);

test('OSM name search: "managed IT services" no longer matches any "... Services" business', () => {
  assert.equal(matches('managed IT services', 'First Texas Corporate Services'), false);
  assert.equal(matches('managed IT services', 'Premier Therapy Services'), false);
  assert.equal(matches('managed IT services', 'Kit Managed Items'), false);
  assert.equal(matches('managed IT services', 'Dallas Managed IT'), true);
  assert.equal(matches('managed IT services', 'ManagedIT Pros LLC'), true);
  assert.equal(matches('plumb', 'Smith Plumbing'), true);
});

test('OSM query: a keyword with no telling word is searched by its tag only', () => {
  assert.equal(namePattern('IT support'), null);
  const q = overpassQuery('IT support', 'Dallas', 'TX');
  assert.match(q, /"office"="it"/);
  assert.doesNotMatch(q, /"name"~/);
  // No tag and no telling word: the whole phrase, never an empty search.
  assert.match(overpassQuery('services', 'Dallas', 'TX'), /"name"~"\(\^\|\[\^a-z0-9\]\)services"/);
});
