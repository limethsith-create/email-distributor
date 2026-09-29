// The hub's "Test run" (src/lib/systems/demo.js, /api/mc/demo): the two
// finished clients of tests/two-clients.test.mjs loaded into Redis with every
// date moved to today — shown in the hub with the demo flag and the same
// numbers — and removed without a trace. And the hard safety rule: with both
// loaded, a full run of the heartbeat sends nothing and calls nothing that it
// would not have without them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kv, __reset, __dump, __commands } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { DEMO_IDS, getAllClients } from '@/lib/db/client';
import { capacity } from '@/lib/systems/gatekeeper';
import { employeeMayAccess, demoWriteBlocked } from '@/middleware';
import { shiftText } from '@/lib/systems/demo';
import STATE from './fixtures/demo-state.json';
import { sim, world, clock, et, installJourney, call } from './journey-world.mjs';

const H = 'demo-harbor-dental';
const S = 'demo-summit-roofing';
const L = 'demo-lakeview-pt';
const ALL = [H, S, L];
const partOf = (id) => STATE.parts.find((p) => p.ids.includes(id));
const keyOf = (id, suffix) => partOf(id).keys[`client:${id}${suffix}`];
const EMPLOYEE = { 'x-hub-role': 'employee', 'x-hub-user': 'nimal@aviance.store' };
const rowOf = (board, id) => board.stages.flatMap((s) => s.clients).find((r) => r.id === id) || null;
const etDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);

/** A copy of the whole store (key → JSON of its value), to compare before / after. */
function snapshot() {
  const out = new Map();
  const ser = (v) => JSON.stringify(v instanceof Map ? [...v.entries()].sort() : v instanceof Set ? [...v].sort() : v);
  for (const [k, v] of __dump()) out.set(k, ser(v));
  return out;
}

async function setup() {
  __reset();
  installJourney({ seed: 7 });
  process.env.ENC_KEY = process.env.ENC_KEY || Buffer.alloc(32, 7).toString('base64');
  clock.set(et('2026-12-09', '10:00'));
  // A real client already in the machine: the test run must leave it exactly as it was.
  await kv.hset(K.client('acme'), { name: 'Acme', state: 'onboarding', plan: 'trial', createdAt: '2026-12-01T12:00:00Z' });
  await kv.sadd(K.clients(), 'acme');
  await kv.hset(K.meetings(), { mreal0001: JSON.stringify({ id: 'mreal0001', clientId: 'acme', status: 'confirmed', start: '2026-12-15T16:00:00.000Z' }) });
  await kv.zadd(K.meetingsByStart(), { member: 'mreal0001', score: Date.parse('2026-12-15T16:00:00.000Z') });
}

test('the fixture: three clients, no real domain, no credential, no link', () => {
  const text = JSON.stringify(STATE);
  assert.deepEqual(STATE.ids, ALL);
  assert.deepEqual(STATE.parts.map((p) => p.ids), [[H, S], [L]]);
  for (const part of STATE.parts) assert.ok(Object.keys(part.keys).every((k) => part.ids.some((id) => k.includes(id)) || k.startsWith('warmup:stats:')), 'only the part’s own clients’ keys');
  assert.ok(!/"(app|login)?[pP]assword(Enc)?":\s*"(?!\[redacted\])/.test(text), 'no password value');
  for (const bad of ['passwordEnc', 'harbordentalgroup', 'summitroofingco', '.com"', '.com/', '@gmail.com', 'machine.test', 'tokenidx:']) assert.ok(!text.includes(bad), `the fixture has ${bad}`);
  // The Lakeview trial is its own business: none of Harbor's names, trade or prospects in it.
  const lake = JSON.stringify(partOf(L));
  for (const bad of ['Harbor', 'harbor', 'Megan', 'megan', 'Ortiz', 'ental', 'Reyes']) assert.ok(!lake.includes(bad), `Lakeview has ${bad}`);
  const harborLeads = new Set(Object.keys(keyOf(H, ':leads').v));
  assert.deepEqual(Object.keys(keyOf(L, ':leads').v).filter((e) => harborLeads.has(e)), [], 'other prospects than Harbor’s');
  assert.equal(shiftText('Thursday 22 October · Tue 6 Oct · 2026-10-22 · 2026-10-22T13:00:00.000Z', 7, 2026), 'Thursday 29 October · Tue 13 Oct · 2026-10-29 · 2026-10-29T13:00:00.000Z');
  assert.equal(shiftText('Friday 20 November', 3, 2026), 'Monday 23 November', 'the weekday follows the date');
});

test('load → the hub shows both finished clients, flagged, with the same numbers; remove leaves nothing behind', { timeout: 120_000 }, async () => {
  await setup();
  const before = snapshot();
  const off = (await call('api/mc/demo/route', 'GET', { path: '/api/mc/demo' })).json;
  assert.deepEqual(off, { loaded: false, ids: [], at: null });

  const loaded = await call('api/mc/demo/route', 'POST', { path: '/api/mc/demo', body: { action: 'load' } });
  assert.equal(loaded.status, 200, JSON.stringify(loaded.json));
  assert.deepEqual(loaded.json, { ok: true, ids: ALL });
  const status = (await call('api/mc/demo/route', 'GET', { path: '/api/mc/demo' })).json;
  assert.deepEqual([status.loaded, status.ids], [true, ALL]);
  assert.equal(status.at, clock.iso());

  const board = (await call('api/mc/hub/route', 'GET', { path: '/api/mc/hub' })).json;
  const h = rowOf(board, H);
  const s = rowOf(board, S);
  const l = rowOf(board, L);
  assert.ok(h && s && l, 'all three on the board');
  assert.equal(rowOf(board, 'acme').demo, false, 'a real client is not flagged');
  const totals = (id) => keyOf(id, ':counters:total').v;
  for (const [row, id, plan, amount, state] of [[h, H, 'starter', 2497, 'converted'], [s, S, 'growth', 3997, 'sending'], [l, L, 'trial', null, 'sending']]) {
    assert.equal(row.demo, true, `${id}: the demo flag`);
    assert.deepEqual([row.state, row.plan], [state, plan]);
    if (amount) {
      assert.deepEqual([row.invoice.plan, row.invoice.amount, row.invoice.status], [plan, amount, 'paid'], JSON.stringify(row.invoice));
      assert.ok(row.invoice.paidAt && row.invoice.number && row.invoice.issuedAt);
      assert.ok(row.five.sent > 400, `${id}: a month of sending (${row.five.sent})`);
    } else {
      // The live trial: mid-way through its 30 days, sending, no invoice yet.
      assert.equal(row.invoice, null);
      assert.equal(row.simple.step, 'sending', JSON.stringify(row.simple));
      assert.match(row.simple.label, /^Sending — day 1[23] of 30/, JSON.stringify(row.simple));
      assert.ok(row.five.sent > 100, `${id}: about twelve days of sending (${row.five.sent})`);
    }
    for (const f of ['sent', 'replies', 'positive', 'booked', 'qualified']) assert.equal(row.five[f], Number(totals(id)[f]), `${id} ${f}`);
    assert.equal(row.openAlerts, 0, 'no alert of theirs in the owner’s list');
    const d = (await call('api/mc/hub/[id]/route', 'GET', { path: `/api/mc/hub/${id}`, params: { id } })).json;
    assert.equal(d.row.demo, true);
    assert.deepEqual(d.invoice?.paidAt ?? null, row.invoice?.paidAt ?? null);
    assert.equal(d.bookings.length, 1, 'the booked prospect call');
    if (id === L) assert.equal(d.bookings[0].status, 'booked', 'Lakeview’s call is still ahead');
    assert.ok(d.replies.length >= 5, 'the prospects’ replies');
    assert.ok(d.conversation.thread.some((e) => e.kind === 'owner_reply'), 'the client ↔ owner messages');
    assert.ok(d.conversation.thread.some((e) => e.auto && e.rule === 'wants_time') || id === S, 'the reply bot’s answer');
    assert.equal(d.inboxes.length, 2);
    assert.ok(d.inboxes.every((i) => i.email.endsWith('.example') && i.hasPassword === true), 'inboxes with a (fake) login');
    assert.ok(d.onboardCall && d.launchCall, 'both calls');
    assert.ok(String(d.links.dashboard || '').includes('/dashboard'), 'a working client dashboard link');
    // The dates end today: the last day with sends is today or within the last few days, never in the future.
    const g = (await call('api/mc/hub/[id]/growth/route', 'GET', { path: `/api/mc/hub/${id}/growth?days=45`, params: { id } })).json;
    const sum = g.email.sent.reduce((a, b) => a + (Number(b) || 0), 0);
    assert.equal(sum, row.five.sent, `${id}: growth adds up to the board`);
    const lastSent = g.days[g.email.sent.map((x) => Number(x) > 0).lastIndexOf(true)];
    assert.ok(lastSent <= etDay(clock.now) && lastSent >= etDay(new Date(clock.now.getTime() - 4 * 864e5)), `${id}: last send ${lastSent}, today ${etDay(clock.now)}`);
    const tok = /\/c\/([A-Za-z0-9_-]{20,})\/dashboard/.exec(d.links.dashboard)[1];
    const dash = (await call('api/c/dashboard/route', 'GET', { path: `/api/c/dashboard?token=${tok}` })).json;
    assert.deepEqual(dash.five, row.five, 'the client dashboard agrees');
  }
  // Their calls are on the Calendar, flagged; the owner's buttons on them are refused.
  const cal = (await call('api/mc/calendar/route', 'GET', { path: `/api/mc/calendar?from=${encodeURIComponent(new Date(clock.now.getTime() - 60 * 864e5).toISOString())}&to=${encodeURIComponent(clock.iso())}&all=1` })).json;
  const demoMeetings = cal.meetings.filter((m) => DEMO_IDS.has(m.clientId));
  assert.ok(demoMeetings.length >= 4 && demoMeetings.every((m) => m.demo === true && !m.googleEventId), JSON.stringify(demoMeetings.map((m) => [m.clientId, m.kind, m.demo])));
  const refused = await call('api/mc/calendar/route', 'POST', { path: '/api/mc/calendar', body: { action: 'cancel', id: demoMeetings[0].id, reason: 'x' } });
  assert.equal(refused.status, 409, JSON.stringify(refused.json));
  // Never against the trial cap or the queue.
  assert.equal(board.machine.activeTrials, 1, 'only acme (the Lakeview trial never counts)');
  assert.equal((await capacity()).active, 1);
  assert.deepEqual((await getAllClients()).map((c) => c.id), ['acme'], 'no job ever sees them');

  // A second load replaces the first (no duplicates).
  await call('api/mc/demo/route', 'POST', { path: '/api/mc/demo', body: { action: 'load' } });
  assert.equal((await kv.lrange(K.events(H), 0, -1)).length, keyOf(H, ':events').v.length);
  assert.equal((await kv.lrange(K.events(L), 0, -1)).length, keyOf(L, ':events').v.length);

  // The hub opens their pages (views may write their own caches) — remove still clears everything.
  await call('api/mc/hub/[id]/route', 'GET', { path: `/api/mc/hub/${H}`, params: { id: H } });
  const removed = await call('api/mc/demo/route', 'POST', { path: '/api/mc/demo', body: { action: 'remove' } });
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
  assert.ok(removed.json.ok && removed.json.removed > 300, JSON.stringify(removed.json));
  const after = snapshot();
  // demo:autoloaded stays on purpose: after a Remove the test run never loads itself again.
  const skip = (k) => /^(system:heartbeat|onboardcall:checkedat|cheapinboxes:syncedat|usage:|jobs:claim:|system:alerts:|demo:autoloaded$)/.test(k);
  const added = [...after.keys()].filter((k) => !before.has(k) && !skip(k));
  const lost = [...before.keys()].filter((k) => !after.has(k) && !skip(k));
  const changed = [...before.keys()].filter((k) => after.has(k) && after.get(k) !== before.get(k) && !skip(k));
  assert.deepEqual({ added, lost, changed }, { added: [], lost: [], changed: [] }, 'the store is exactly as before the load');
  assert.deepEqual((await call('api/mc/demo/route', 'GET', { path: '/api/mc/demo' })).json, { loaded: false, ids: [], at: null });
  const gone = (await call('api/mc/hub/route', 'GET', { path: '/api/mc/hub' })).json;
  for (const id of ALL) assert.equal(rowOf(gone, id), null);
});

test('owner only: employees get 403; nothing on a demo client can be changed', async () => {
  await setup();
  assert.equal(employeeMayAccess('GET', '/api/mc/demo'), false);
  assert.equal(employeeMayAccess('POST', '/api/mc/demo'), false);
  const g = await call('api/mc/demo/route', 'GET', { path: '/api/mc/demo', headers: EMPLOYEE });
  assert.equal(g.status, 403);
  const p = await call('api/mc/demo/route', 'POST', { path: '/api/mc/demo', headers: EMPLOYEE, body: { action: 'load' } });
  assert.equal(p.status, 403);
  assert.equal(await kv.exists(K.client(H)), 0, 'nothing loaded');
  // The hub's buttons on a demo client: refused by the middleware and by the routes themselves.
  assert.equal(demoWriteBlocked('POST', `/api/mc/clients/${H}/messages`), true);
  assert.equal(demoWriteBlocked('GET', `/api/mc/clients/${H}/messages`), false);
  assert.equal(demoWriteBlocked('POST', '/api/mc/clients/acme/messages'), false);
  await call('api/mc/demo/route', 'POST', { path: '/api/mc/demo', body: { action: 'load' } });
  const mark = sim.sent.length;
  for (const [route, body] of [
    ['api/mc/clients/[id]/messages/route', { action: 'reply', text: 'Hello' }],
    ['api/mc/clients/[id]/route', { action: 'shareDashboard', email: 'someone@example.org' }],
    ['api/mc/clients/[id]/intake/route', { action: 'resendWelcome' }],
    ['api/mc/clients/[id]/onboard-call/route', { action: 'reply', text: 'Hi' }],
    ['api/mc/clients/[id]/launch-call/route', { action: 'reply', text: 'Hi' }],
  ]) {
    const r = await call(route, 'POST', { path: `/api/mc/clients/${S}`, params: { id: S }, body });
    assert.equal(r.status, 409, `${route}: ${JSON.stringify(r.json)}`);
  }
  assert.equal(sim.sent.length, mark, 'nothing was sent');
});

test('safety: with all three demo clients loaded, a full run of the heartbeat sends and calls nothing more than without them', { timeout: 300_000 }, async () => {
  const run = async (withDemo) => {
    await setup();
    await call('api/mc/config/route', 'POST', { body: { action: 'set', key: 'OWNER', value: { ...(await call('api/mc/config/route', 'GET')).json.settings.find((x) => x.key === 'OWNER').value, signerName: 'Limeth Sith' } } });
    if (withDemo) assert.equal((await call('api/mc/demo/route', 'POST', { path: '/api/mc/demo', body: { action: 'load' } })).status, 200);
    const theirs = () => JSON.stringify([...__dump().entries()].filter(([k]) => [...DEMO_IDS].some((id) => k.includes(id))).map(([k, v]) => [k, v instanceof Map ? [...v.entries()] : v instanceof Set ? [...v] : v]));
    const demoBefore = theirs();
    const sent0 = sim.sent.length;
    const calls0 = world.calls.length;
    const alerts0 = ((await kv.lrange(K.alertLog(), 0, -1)) || []).length;
    const c0 = __commands();
    // Three days of the heartbeat, every 15 minutes (a Wednesday → Friday: Friday updates, invoice reminders, digests),
    // and the hub's own check each hour.
    let ticks = 0;
    for (let t = et('2026-12-09', '10:15').getTime(); t <= et('2026-12-11', '18:00').getTime(); t += 15 * 60e3) {
      clock.set(t);
      const r = await call('api/cron/tick/route', 'GET', { path: '/api/cron/tick?source=cronjob', headers: { authorization: 'Bearer journey-cron' } });
      assert.equal(r.status, 200);
      ticks++;
      if (new Date(t).getUTCMinutes() === 0) await call('api/mc/onboard-calls/check/route', 'POST', { path: '/api/mc/onboard-calls/check' });
    }
    const alerts = ((await kv.lrange(K.alertLog(), 0, -1)) || []).slice(0, ((await kv.lrange(K.alertLog(), 0, -1)) || []).length - alerts0);
    // Nothing of theirs moved: no job ran for them, nothing was written under their ids.
    assert.equal(theirs(), demoBefore, 'the demo clients’ records did not change');
    return {
      sent: sim.sent.slice(sent0).map((m) => `${m.from} → ${m.to}: ${m.subject}`),
      calls: world.calls.slice(calls0).map((c) => `${c.kind} ${c.method} ${c.url}`),
      alerts: alerts.map((a) => `${a.key}:${a.clientId}`),
      perTick: (__commands() - c0) / ticks,
      unknown: [...world.unknown],
    };
  };
  const without = await run(false);
  const withDemo = await run(true);
  assert.deepEqual(withDemo.sent, without.sent, 'the same emails (none of them for a demo client)');
  assert.ok(!withDemo.sent.some((x) => /\.example|demo-/.test(x)));
  assert.deepEqual(withDemo.calls, without.calls, 'the same outside calls (Google, CheapInboxes, DNS, …)');
  assert.ok(!withDemo.calls.some((x) => /\.example|demo-/.test(x)));
  assert.deepEqual(withDemo.alerts, without.alerts, 'no owner alert or push for a demo client');
  assert.deepEqual(withDemo.unknown, []);
  // Redis budget: the demo clients add nothing to a tick (their ids are dropped before any read).
  assert.ok(withDemo.perTick - without.perTick < 1, `${withDemo.perTick.toFixed(2)} vs ${without.perTick.toFixed(2)} commands a tick`);
});

test('the owner’s own outreach numbers are the same with the test run loaded', async () => {
  await setup();
  const a = (await call('api/mc/outreach/route', 'GET', { path: '/api/mc/outreach' })).json;
  await call('api/mc/demo/route', 'POST', { path: '/api/mc/demo', body: { action: 'load' } });
  const b = (await call('api/mc/outreach/route', 'GET', { path: '/api/mc/outreach' })).json;
  assert.deepEqual(b.totals, a.totals);
  assert.equal(b.days.length, a.days.length);
});
