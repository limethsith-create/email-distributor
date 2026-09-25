// Fixes found by the real-world dry run (2026-09-25).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rdapLookup } from '@/lib/ext/porkbun';
import { pickContacts } from '../scripts/leadfinder/lib.mjs';
import { titleFits } from '@/lib/leadquality/rules.mjs';
import { sanityCheck } from '@/lib/systems/sanity';
import { nicheOf } from '@/lib/systems/copy';

test('domain lookups: registry answers only; rdap.org refusals and TLDs without RDAP are "unknown"', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), ua: init.headers?.['user-agent'] });
    const u = String(url);
    if (u.includes('rdap.verisign.com/com/v1/domain/free-name.com')) return new Response('', { status: 404 });
    if (u.includes('rdap.verisign.com/com/v1/domain/taken-name.com')) return Response.json({ events: [{ eventAction: 'registration', eventDate: '2001-01-01T00:00:00Z' }] });
    if (u.startsWith('https://rdap.org/domain/some-name.co')) { const r = new Response('', { status: 404 }); Object.defineProperty(r, 'url', { value: u }); return r; }
    return new Response('', { status: 403 });
  };
  try {
    assert.deepEqual(await rdapLookup('free-name.com'), { status: 'free', registeredAt: null });
    assert.equal((await rdapLookup('taken-name.com')).status, 'taken');
    assert.equal((await rdapLookup('some-name.co')).status, 'unknown', 'rdap.org 404 without a registry redirect says nothing');
    assert.equal((await rdapLookup('blocked.xyz')).status, 'unknown');
    assert.ok(calls.every((c) => /AvianceBot/.test(c.ua || '')), 'every lookup says who is asking');
    assert.ok(calls[0].url.startsWith('https://rdap.verisign.com/com/v1/domain/'), '.com goes straight to the registry');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('an email is only guessed for a real person, never an organisation name', () => {
  const found = { cards: [{ name: 'Sweco Norway', title: 'CEO' }, { name: 'Andy Woods', title: 'Chief Executive Officer' }] };
  const out = pickContacts(found, 'example-it.com', ['CEO', 'Chief Executive Officer'], { max: 2 });
  assert.deepEqual(out.map((c) => c.name), ['Andy Woods']);
  assert.equal(out[0].email, 'andy@example-it.com');
  assert.equal(pickContacts({ cards: [{ name: 'Sweco Norway', title: 'CEO' }] }, 'ncc.com', ['CEO']).length, 0);
});

const LIST = ['Owner', 'Founder', 'President', 'Managing Partner', 'Partner', 'Principal', 'CEO', 'Office Manager'];

test('titles: one rule for finder and batch check — owner-level words count, other titles do not', () => {
  assert.equal(titleFits('Founding Attorney', LIST), true);
  assert.equal(titleFits('Managing Attorney', LIST), true);
  assert.equal(titleFits('Senior Partner', LIST), true);
  assert.equal(titleFits('Operations Manager', LIST), false);
  assert.equal(titleFits('Firm Administrator', LIST), false);
  assert.equal(titleFits('', LIST), true);
  // A client who only wants office managers does not get owners by synonym.
  assert.equal(titleFits('Founding Attorney', ['Office Manager']), false);
});

test('titles: the finder never picks a person the batch check would fail', () => {
  const found = { cards: [{ name: 'Mary Stone', title: 'Operations Manager' }, { name: 'John Hale', title: 'Founding Attorney' }] };
  const out = pickContacts(found, 'halelaw.com', LIST, { max: 1 });
  assert.deepEqual(out.map((c) => c.name), ['John Hale']);
  assert.equal(pickContacts({ cards: [{ name: 'Mary Stone', title: 'Operations Manager' }] }, 'x.com', LIST).length, 0);
  const rows = [
    { email: 'john@halelaw.com', title: 'Founding Attorney', state: 'TX', website: 'halelaw.com' },
    { email: 'ann@cpa.com', title: 'Managing Attorney', state: 'TX', website: 'cpa.com' },
    { email: 'bo@firm.com', title: 'Owner', state: 'TX', website: 'firm.com' },
  ];
  assert.equal(sanityCheck(rows, { titles: LIST }, { maxFail: 0, chains: new Set() }).failCount, 0);
});

test('copy niche: what the client sells, not who they sell to', () => {
  assert.equal(nicheOf({ sellsTo: 'Bookkeeping for contractors and roofers' }), 'pro-services');
  assert.equal(nicheOf({ defaultNiche: 'managed IT', industry: 'accountant, law firm' }), 'msp');
  assert.equal(nicheOf({ sellsTo: 'IT support for law firms and accountants' }), 'msp');
});
