import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, kv } from '@vercel/kv';
import { createClient, setState } from '@/lib/db/client';
import { dashboardLink, dashboardView } from '@/lib/systems/clientdash';
import { currentLinks } from '@/lib/pagetokens';

beforeEach(() => { __reset(); });
const tokenOf = (url) => /\/c\/([^/]+)\/dashboard$/.exec(url)[1];

test('client dashboard: one lasting link per client (the hub shows it), a read-only view of their own numbers, and a bad link says so', async () => {
  await createClient('oak-legal', { name: 'Oak Legal', contactName: 'Olive Oak', contactEmail: 'olive@oaklegal.com', mainDomain: 'oaklegal.com', plan: 'growth', state: 'applied' });
  const url = await dashboardLink('oak-legal');
  assert.match(url, /\/c\/[A-Za-z0-9_-]{20,}\/dashboard$/);
  assert.equal(await dashboardLink('oak-legal'), url, 'the same link every time');
  assert.equal((await currentLinks('oak-legal')).dashboard, url, 'the hub sees it');
  const v = await dashboardView(tokenOf(url));
  assert.equal(v.ok, true);
  assert.equal(v.company, 'Oak Legal'); assert.equal(v.plan, 'Growth plan'); assert.equal(v.paid, true);
  assert.ok(Array.isArray(v.inboxes) && Array.isArray(v.replies) && Array.isArray(v.bookings));
  for (const k of ['alerts', 'jobs', 'events', 'invoice', 'promises', 'holds', 'todo']) assert.ok(!(k in v), 'no owner-only data: ' + k);
  // a new link replaces the old one
  const url2 = await dashboardLink('oak-legal', { fresh: true });
  assert.notEqual(url2, url);
  assert.equal((await dashboardView(tokenOf(url))).ok, false, 'the old link stops working');
  assert.equal((await dashboardView('nonsense-token-that-is-long-enough')).ok, false);
  // a trial client's dashboard says so
  await createClient('elm-dental', { name: 'Elm Dental', contactEmail: 'eli@elmdental.com', mainDomain: 'elmdental.com', plan: 'trial', state: 'applied' });
  assert.equal((await dashboardView(tokenOf(await dashboardLink('elm-dental')))).plan, '30-day trial');
  // the API
  const { GET } = await import('@/app/api/c/dashboard/route');
  assert.equal((await GET(new Request(`http://x/api/c/dashboard?token=${tokenOf(url2)}`))).status, 200);
  assert.equal((await GET(new Request('http://x/api/c/dashboard?token=bad'))).status, 404);
});
