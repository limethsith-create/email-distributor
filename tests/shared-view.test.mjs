// The client's page — the shared view (docs/HUB-API.md "The client's page (shared view)"):
//   GET /api/c/dashboard, /api/c/emails, /api/c/threads, /api/c/thread (token = the dashboard link),
//   the Test run clients' preview (shareDashboard sends nothing, returns the link),
//   GET /api/mc/hub/{id} → dashboardAccess.url (owner only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kv, __reset } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { saveLead } from '@/lib/db/leads';
import { threadIdOf } from '@/lib/systems/maillog';
import { dashboardLink, resetRateLimit } from '@/lib/systems/clientdash';
import { demoWriteBlocked } from '@/middleware';
import { sim, clock, et, installJourney, call } from './journey-world.mjs';

const S = 'demo-summit-roofing';
const L = 'demo-lakeview-pt';
const tokenOf = (url) => /\/c\/([^/]+)\/dashboard$/.exec(url)[1];
const get = (route, q) => call(`api/c/${route}/route`, 'GET', { path: `/api/c/${route}?${q}` });
const page = (token) => get('dashboard', `token=${encodeURIComponent(token)}`);
const emails = (token, extra = '') => get('emails', `token=${encodeURIComponent(token)}${extra}`);
const threads = (token) => get('threads', `token=${encodeURIComponent(token)}`);
const thread = (token, id) => get('thread', `token=${encodeURIComponent(token)}&id=${encodeURIComponent(id)}`);
const act = (id, body, headers = {}) => call('api/mc/clients/[id]/route', 'POST', { path: `/api/mc/clients/${id}`, params: { id }, body, headers });
const hub = (id, headers = {}) => call('api/mc/hub/[id]/route', 'GET', { path: `/api/mc/hub/${id}`, params: { id }, headers });

// Words and fields that must never reach the client's page.
const NEVER_KEYS = ['invoice', 'fitScore', 'score', 'todo', 'todos', 'alerts', 'promises', 'rule', 'auto', 'template', 'passwordEnc', 'password', 'inboxRate7d', 'inboxRate', 'canaryPlacement', 'deliverability', 'health', 'grade', 'leadGrade', 'cost', 'costs', 'research', 'application', 'jobs', 'events'];
function assertClean(json, where) {
  const walk = (v, path) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { assert.ok(!NEVER_KEYS.includes(k), `${where}: no "${k}" (${path}.${k})`); walk(x, `${path}.${k}`); }
  };
  walk(json, '');
  const text = JSON.stringify(json);
  assert.doesNotMatch(text, /\binvoice/i, `${where}: no invoice`);
  assert.doesNotMatch(text, /\$\s?\d/, `${where}: no amounts`);
  assert.doesNotMatch(text, /INV-\d/, `${where}: no invoice number`);
  assert.doesNotMatch(text, /Fit score|fit_score|\b8[0-9]\/100\b/i, `${where}: no fit score`);
  assert.doesNotMatch(text, /Pay by/i, `${where}: no payment lines`);
}

async function paying() {
  __reset();
  resetRateLimit();
  installJourney({ seed: 3 });
  clock.set(et('2026-12-09', '10:00'));
  const id = 'oak-legal';
  await kv.hset(K.client(id), { id, name: 'Oak Legal', contactName: 'Olive Oak', contactEmail: 'olive@oaklegal.com', state: 'sending', plan: 'growth', onboardCallSentAt: '2026-11-01T15:00:00.000Z' });
  await kv.hset(K.profile(id), { senderName: 'Olive Oak' });
  await kv.sadd(K.inboxes(id), 'olive@oaklegalhq.com');
  await kv.hset(K.inbox(id, 'olive@oaklegalhq.com'), { email: 'olive@oaklegalhq.com', enabled: '1', passwordEnc: 'secret-enc', inboxRate7d: '0.93', dailyCap: '30' });
  await kv.hset(K.invoice(id), { number: 'INV-0042', amount: '1500', status: 'paid', plan: 'growth', paidAt: '2026-11-20T10:00:00.000Z' });
  await kv.hset(K.application(id), { company: 'Oak Legal', email: 'olive@oaklegal.com' });
  await kv.hset(K.research(id), { score: JSON.stringify({ score: 84, grade: 'A' }) });
  await kv.hset(K.countersTotal(id), { sent: 400, replies: 20, positive: 6, booked: 3, bounces: 8, qualified: 2 });
  await kv.hset(K.countersDay(id, '2026-12-08'), { sent: 25, replies: 2 });
  await kv.hset(K.countersDay(id, '2026-12-09'), { sent: 12 });
  await kv.hset(K.onboardCall(id), { sentAt: '2026-11-01T15:00:00.000Z', bookedFor: '2026-11-04T15:00:00.000Z', bookedAt: '2026-11-02T10:00:00.000Z', heldAt: '2026-11-04T15:40:00.000Z', fromInbox: 'owner@aviance.test' });
  // The conversation with us: a welcome, an invoice, their price question and the bot's price answer, the owner's note.
  const convo = [
    { id: 'o1', dir: 'out', at: '2026-11-01T15:00:00.000Z', from: 'owner@aviance.test', to: 'olive@oaklegal.com', subject: 'Welcome to Aviance', text: 'Hi Olive,\n\nGlad to have you.', kind: 'acceptance' },
    { id: 'o2', dir: 'out', at: '2026-11-19T15:00:00.000Z', from: 'owner@aviance.test', to: 'olive@oaklegal.com', subject: 'Invoice INV-0042 — Growth, month one', text: 'Invoice INV-0042 · Total due: $1,500\n\nPay by: bank transfer', kind: 'system', template: 'invoice_month1' },
    { id: 'i1', dir: 'in', at: '2026-11-19T16:00:00.000Z', from: 'olive@oaklegal.com', to: 'owner@aviance.test', subject: 'Re: Welcome', text: 'What does the next month cost?', kind: 'reply', rule: 'price' },
    { id: 'o3', dir: 'out', at: '2026-11-19T16:05:00.000Z', from: 'owner@aviance.test', to: 'olive@oaklegal.com', subject: 'Re: Welcome', text: 'It is the same as this month.', kind: 'auto_reply', auto: true, rule: 'price' },
    { id: 'o4', dir: 'out', at: '2026-11-20T09:00:00.000Z', from: 'owner@aviance.test', to: 'olive@oaklegal.com', subject: 'Re: Welcome', text: 'All set — the first emails go out Monday.', kind: 'owner_reply' },
    { id: 'i2', dir: 'in', at: '2026-11-20T10:00:00.000Z', from: 'olive@oaklegal.com', to: 'owner@aviance.test', subject: 'Re: Welcome', text: 'Great, thank you!', kind: 'reply' },
  ];
  for (const e of convo) await kv.rpush(K.onboardThread(id), e);
  // Prospects: 250 cold emails (paging), one reply handed to the client, a booked call.
  for (let i = 0; i < 250; i++) {
    const at = new Date(Date.parse('2026-11-23T14:00:00.000Z') + i * 60e3).toISOString();
    await saveLead(id, { email: `p${i}@firm${i}.example`, name: `Pat ${i}`, company: `Firm ${i}`, status: i === 7 ? 'replied' : 'in_sequence', sent_at: at, original_subject: `Firm ${i} and Oak Legal`, account_used: 'olive@oaklegalhq.com', grade: 'A', leadScore: 91 });
  }
  await kv.hset(K.replies(id), { r1: { leadEmail: 'p7@firm7.example', kind: 'interested', receivedAt: '2026-11-24T10:00:00.000Z', text: 'Interested — call me.', snippet: 'Interested — call me.', rule: 'yes_keyword' } });
  await kv.hset(K.hot(id), { h1: { leadEmail: 'p7@firm7.example', kind: 'interested', sentAt: '2026-11-24T10:01:00.000Z', inbox: 'olive@oaklegalhq.com' } });
  await kv.hset(K.bookings(id), { b1: { id: 'b1', leadEmail: 'p7@firm7.example', scheduledAt: '2026-11-26T15:00:00.000Z', status: 'held', qualified: true }, b2: { id: 'b2', leadEmail: 'p9@firm9.example', scheduledAt: '2026-12-11T15:00:00.000Z', status: 'booked' } });
  return id;
}

test('the shared view of a paying client: the five tabs’ data, and nothing on the never list', { timeout: 60_000 }, async () => {
  const id = await paying();
  const token = tokenOf(await dashboardLink(id));

  const d = await page(token);
  assert.equal(d.status, 200, JSON.stringify(d.json));
  const v = d.json;
  assert.deepEqual(Object.keys(v).sort(), ['calls', 'company', 'day', 'demo', 'five', 'journey', 'last30', 'messages', 'ok', 'openedTracked', 'paid', 'plan', 'rates', 'replyTo', 'sentSince', 'status', 'updatedAt'].sort());
  assert.equal(v.company, 'Oak Legal');
  assert.equal(v.plan, 'Growth plan');
  assert.equal(v.day, null, 'no trial day on a paid plan');
  assert.deepEqual(v.five, { sent: 400, opened: null, replies: 20, bounced: 8, interested: 6, booked: 3 });
  assert.deepEqual(v.rates, { replies: 0.05, bounced: 0.02, interested: 0.3 });
  assert.equal(v.openedTracked, false);
  assert.equal(v.last30.days.length, 30);
  assert.equal(v.last30.days.at(-1), '2026-12-09');
  assert.deepEqual([v.last30.sent.at(-2), v.last30.sent.at(-1), v.last30.replies.at(-2)], [25, 12, 2]);
  assert.deepEqual(v.last30.totals, { sent: 37, replies: 2, booked: 0 });
  assert.deepEqual(v.journey.steps.map((s) => s.label), ['Applied', 'Onboarding call', 'Setting up', 'Sending emails', 'Done']);
  assert.equal(v.journey.current, 3);
  assert.equal(v.journey.status, 'Sending emails.');
  assert.equal(v.status, v.journey.status);
  // Calls: prospects newest first with who and status; their own onboarding call.
  assert.deepEqual(v.calls.prospects.map((c) => [c.at, c.name, c.company, c.status]), [
    ['2026-12-11T15:00:00.000Z', 'Pat 9', 'Firm 9', 'booked'],
    ['2026-11-26T15:00:00.000Z', 'Pat 7', 'Firm 7', 'showed'],
  ]);
  assert.deepEqual(v.calls.ours, [
    { kind: 'onboarding', label: 'Onboarding call', at: '2026-11-04T15:00:00.000Z', status: 'done' },
    { kind: 'launch', label: 'Launch call', at: null, status: 'not_needed' },
  ]);
  // Messages: the conversation with us, without the invoice or the price question and answer.
  assert.deepEqual(v.messages.map((m) => m.text), ['Hi Olive,\n\nGlad to have you.', 'All set — the first emails go out Monday.', 'Great, thank you!']);
  assert.deepEqual(v.messages.map((m) => [m.dir, m.by]), [['out', 'system'], ['out', 'owner'], ['in', 'client']]);
  assertClean(v, 'dashboard');

  // Emails sent: prospects only, 200 a page, "Show more" with ?before=.
  const e1 = await emails(token);
  assert.equal(e1.status, 200);
  assert.deepEqual(Object.keys(e1.json).sort(), ['next', 'sent', 'total']);
  assert.equal(e1.json.total, 250, 'the emails to prospects — none of the emails to the client');
  assert.equal(e1.json.sent.length, 200);
  assert.ok(e1.json.sent.every((e) => e.threadId !== 'client' && ['first', 'followup', 'bot'].includes(e.kind)));
  assert.deepEqual(Object.keys(e1.json.sent[0]).sort(), ['at', 'company', 'from', 'id', 'kind', 'status', 'subject', 'threadId', 'to', 'toName']);
  assert.equal(e1.json.next, e1.json.sent.at(-1).at);
  const e2 = await emails(token, `&limit=200&before=${encodeURIComponent(e1.json.next)}`);
  assert.equal(e2.json.sent.length, 50);
  assert.equal(e2.json.next, null);
  assert.equal(new Set([...e1.json.sent, ...e2.json.sent].map((e) => e.id)).size, 250, 'no email twice');
  assert.equal([...e1.json.sent, ...e2.json.sent].find((e) => e.to === 'p7@firm7.example').status, 'replied');
  assertClean(e1.json, 'emails');
  assert.equal((await emails(token, '&before=yesterday')).status, 400);

  // Conversations and one whole thread.
  const t = await threads(token);
  assert.equal(t.status, 200);
  assert.equal(t.json.threads.length, 1);
  assert.deepEqual(Object.keys(t.json.threads[0]).sort(), ['count', 'handledBy', 'kind', 'lastAt', 'lead', 'snippet', 'threadId']);
  assert.equal(t.json.threads[0].kind, 'interested');
  assert.equal(t.json.threads[0].handledBy, 'client');
  assertClean(t.json, 'threads');
  const th = await thread(token, t.json.threads[0].threadId);
  assert.equal(th.status, 200);
  assert.deepEqual(th.json.messages.map((m) => [m.dir, m.by]), [['out', 'system'], ['in', 'prospect'], ['out', 'system']]);
  assertClean(th.json, 'thread');
  const c = await thread(token, 'client');
  assert.equal(c.status, 200);
  assert.deepEqual(c.json.messages, v.messages, 'the Messages tab = the client thread without money');
  assertClean(c.json, 'client thread');
  assert.equal((await thread(token, threadIdOf('stranger@nowhere.example'))).status, 404);
  assert.equal((await thread(token, 'nonsense')).status, 404);
});

test('a bad, expired or unshared link → 404 on every route', { timeout: 60_000 }, async () => {
  const id = await paying();
  const old = tokenOf(await dashboardLink(id));
  for (const r of [page, emails, threads, (tk) => thread(tk, 'client')]) assert.equal((await r(old)).status, 200);
  // The owner takes access away: the old link stops everywhere.
  const u = await act(id, { action: 'unshareDashboard' });
  assert.equal(u.status, 200, JSON.stringify(u.json));
  for (const r of [page, emails, threads, (tk) => thread(tk, 'client')]) {
    const res = await r(old);
    assert.equal(res.status, 404);
    assert.equal(res.json.ok, false);
  }
  assert.equal((await page(tokenOf(u.json.url))).status, 200, 'the new link works');
  for (const bad of ['', 'short', 'x'.repeat(43)]) {
    assert.equal((await page(bad)).status, 404);
    assert.equal((await emails(bad)).status, 404);
    assert.equal((await threads(bad)).status, 404);
  }
  // Another purpose's token is not a dashboard token.
  const { mintToken } = await import('@/lib/pagetokens');
  const other = await mintToken(id, 'approval');
  assert.equal((await page(other)).status, 404);
  assert.equal((await threads(other)).status, 404);
});

test('rate limit: past 120 calls a minute on one link → 429', { timeout: 60_000 }, async () => {
  const id = await paying();
  const token = tokenOf(await dashboardLink(id));
  const { overLimit } = await import('@/lib/systems/clientdash');
  const now = new Date('2026-12-09T15:00:10.000Z');
  for (let i = 0; i < 120; i++) assert.equal(await overLimit(token, { now }), false);
  assert.equal(await overLimit(token, { now }), true);
  assert.equal(await overLimit(token, { now: new Date('2026-12-09T15:01:10.000Z') }), false, 'the next minute starts fresh');
});

test('the hub gets dashboardAccess.url (owner only), and the journey follows the state', { timeout: 60_000 }, async () => {
  const id = await paying();
  const h = await hub(id);
  assert.equal(h.status, 200);
  assert.match(h.json.dashboardAccess.url, /\/c\/[A-Za-z0-9_-]{20,}\/dashboard$/);
  assert.equal((await hub(id)).json.dashboardAccess.url, h.json.dashboardAccess.url, 'the same link each time');
  assert.equal((await page(tokenOf(h.json.dashboardAccess.url))).status, 200);
  const emp = await hub(id, { 'x-hub-role': 'employee', 'x-hub-user': 'nimal@aviance.store' });
  assert.equal(emp.json.dashboardAccess.url, undefined, 'employees do not get the link');
  assert.ok(Array.isArray(emp.json.dashboardAccess.sharedWith));

  const token = tokenOf(h.json.dashboardAccess.url);
  const steps = { applied: 0, queued: 0, onboarding: 1, awaiting_purchase: 2, warming: 2, ready: 2, sending: 3, paused: 3, converted: 3, deciding: 4, retired: 4 };
  for (const [state, want] of Object.entries(steps)) {
    await kv.hset(K.client(id), { state, plan: 'trial' });
    const v = (await page(token)).json;
    assert.equal(v.journey.current, want, state);
    assert.ok(v.status && !/answer them|mark it|press|alert|to-do/i.test(v.status), `${state}: plain words for the client (${v.status})`);
  }
  // The sentences the hub shows too.
  const line = async (fields, trial = null) => { await kv.hset(K.client(id), fields); if (trial) await kv.hset(K.trial(id), trial); return (await page(token)).json.status; };
  assert.equal(await line({ state: 'applied' }), 'Application received — it is being reviewed.');
  assert.equal(await line({ state: 'queued' }), 'Accepted — waiting for a start date.');
  await kv.hdel(K.onboardCall(id), 'bookedFor', 'heldAt');
  assert.equal(await line({ state: 'onboarding' }), 'Accepted — next is the onboarding call.');
  await kv.hset(K.onboardCall(id), { bookedFor: '2026-12-10T15:00:00.000Z' });
  assert.equal(await line({ state: 'onboarding' }), 'The onboarding call is booked for Thu, Dec 10, 10:00 AM ET.');
  assert.equal(await line({ state: 'awaiting_purchase' }), 'Setting up the new email inboxes and the list of people to write to.');
  await kv.hset(K.client(id), { launchCallSentAt: '2026-12-01T15:00:00.000Z' });
  await kv.hset(K.launchCall(id), { sentAt: '2026-12-01T15:00:00.000Z', bookedFor: '2026-12-12T16:30:00.000Z' });
  assert.equal(await line({ state: 'ready' }), 'Setting up. The launch call is booked for Sat, Dec 12, 11:30 AM ET.');
  assert.equal(await line({ state: 'warming' }, { day1Date: '2026-12-14' }), 'Warming up the new inboxes, so the emails land in the inbox and not in spam. Emails start on Monday, December 14.');
  assert.equal(await line({ state: 'sending', plan: 'trial' }, { day1Date: '2026-12-01' }), 'Sending emails — day 9 of 30.');
  assert.equal(await line({ state: 'paused' }), 'Sending is paused for now.');
  assert.equal(await line({ state: 'deciding' }), 'The 30 days are done. Next: choosing whether to go on.');
  assert.equal(await line({ state: 'declined' }), 'Not going ahead.');
  assert.equal(await line({ state: 'retired' }), 'The trial is finished.');
  assert.equal(await line({ state: 'converted', plan: 'growth' }), 'On the Growth plan.');
  assert.equal(await line({ state: 'sending', plan: 'growth' }), 'Sending emails.');
  await kv.hset(K.client(id), { state: 'sending', plan: 'trial' });
  const v = (await page(token)).json;
  assert.equal(v.plan, '30-day trial');
  assert.deepEqual(v.calls.ours.map((c) => [c.kind, c.status]), [['onboarding', 'booked'], ['launch', 'booked']]);
  assert.equal(v.sentSince, '2026-12-01');
  // Prospect calls: moved, being checked, cancelled.
  await kv.hset(K.bookings(id), { b3: { id: 'b3', leadEmail: 'p3@firm3.example', scheduledAt: '2026-12-01T15:00:00.000Z', status: 'rebooked' }, b4: { id: 'b4', leadEmail: 'p4@firm4.example', scheduledAt: '2026-12-02T15:00:00.000Z', status: 'disputed' }, b5: { id: 'b5', leadEmail: 'p5@firm5.example', scheduledAt: '2026-12-03T15:00:00.000Z', status: 'booked', cancelledAt: '2026-12-02T10:00:00.000Z' } });
  assert.deepEqual((await page(token)).json.calls.prospects.map((c) => c.status), ['booked', 'cancelled', 'checking', 'moved', 'showed']);
});

test('the Test run clients: the page works, shareDashboard returns the link and sends nothing', { timeout: 120_000 }, async () => {
  __reset();
  resetRateLimit();
  installJourney({ seed: 7 });
  process.env.ENC_KEY = process.env.ENC_KEY || Buffer.alloc(32, 7).toString('base64');
  clock.set(et('2026-12-09', '10:00'));
  assert.equal((await call('api/mc/demo/route', 'POST', { path: '/api/mc/demo', body: { action: 'load' } })).status, 200);
  const mark = sim.sent.length;

  // The middleware lets only this through on a demo client.
  assert.equal(demoWriteBlocked('POST', `/api/mc/clients/${S}`, 'shareDashboard'), false);
  assert.equal(demoWriteBlocked('POST', `/api/mc/clients/${S}`, 'dashboardLink'), false);
  assert.equal(demoWriteBlocked('POST', `/api/mc/clients/${S}`, 'unshareDashboard'), true);
  assert.equal(demoWriteBlocked('POST', `/api/mc/clients/${S}`, 'setState'), true);
  assert.equal(demoWriteBlocked('POST', `/api/mc/clients/${S}`), true);
  assert.equal(demoWriteBlocked('POST', `/api/mc/clients/${S}/messages`, 'shareDashboard'), true);

  const r = await act(S, { action: 'shareDashboard', email: 'someone@example.org' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual({ ...r.json, url: undefined }, { ok: true, url: undefined, sent: false, demo: true });
  assert.match(r.json.url, /\/c\/[A-Za-z0-9_-]{20,}\/dashboard$/);
  assert.equal(sim.sent.length, mark, 'no email');
  assert.equal(await kv.hget(K.trial(S), 'dashboardSharedWith'), null, 'nobody recorded');
  assert.equal((await act(S, { action: 'shareDashboard', email: 'nope' })).status, 400);
  assert.equal((await act(S, { action: 'unshareDashboard' })).status, 409, 'every other button stays refused');
  assert.equal((await act(S, { action: 'dashboardLink', fresh: true })).status, 409);
  assert.equal((await act(S, { action: 'dashboardLink' })).json.url, r.json.url);

  for (const id of [S, L]) {
    const url = id === S ? r.json.url : (await hub(id)).json.dashboardAccess.url;
    const token = tokenOf(url);
    const v = await page(token);
    assert.equal(v.status, 200, JSON.stringify(v.json));
    assert.equal(v.json.demo, true);
    assert.ok(v.json.five.sent > 0, `${id}: sending shows`);
    assert.equal(v.json.journey.current, 3);
    assertClean(v.json, `${id} dashboard`);
    const e = await emails(token);
    assert.equal(e.status, 200);
    assert.ok(e.json.total > 0 && e.json.sent.every((x) => x.threadId !== 'client'));
    assertClean(e.json, `${id} emails`);
    const t = await threads(token);
    assert.ok(t.json.threads.length > 0);
    assertClean(t.json, `${id} threads`);
    for (const x of t.json.threads.slice(0, 5)) {
      const th = await thread(token, x.threadId);
      assert.equal(th.status, 200);
      assertClean(th.json, `${id} thread`);
    }
    const c = await thread(token, 'client');
    if (c.status === 200) assertClean(c.json, `${id} client thread`);
  }
  assert.equal(sim.sent.length, mark, 'nothing was sent');
  // Remove clears the preview links' lookups too.
  assert.equal((await call('api/mc/demo/route', 'POST', { path: '/api/mc/demo', body: { action: 'remove' } })).status, 200);
  assert.equal((await page(tokenOf(r.json.url))).status, 404);
});
