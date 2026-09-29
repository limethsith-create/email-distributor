// The hub's email log and prospect conversations, per client (src/lib/systems/maillog.js):
//   GET /api/mc/hub/{id}/emails, /threads, /threads/{threadId}
// on the Test run's three clients (full texts from the simulation) and on a hand-made client (paging
// ties, emails sent before texts were kept, 404s); plus the Test run's automatic first load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kv, __reset } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { saveLead } from '@/lib/db/leads';
import { employeeMayAccess } from '@/middleware';
import { threadIdOf, NOT_STORED } from '@/lib/systems/maillog';
import { resetAutoloadMemo, DEMO_AUTOLOADED } from '@/lib/systems/demo';
import { clock, et, installJourney, call } from './journey-world.mjs';

const H = 'demo-harbor-dental';
const S = 'demo-summit-roofing';
const L = 'demo-lakeview-pt';
const EMPLOYEE = { 'x-hub-role': 'employee', 'x-hub-user': 'nimal@aviance.store' };
const KINDS = ['interested', 'question', 'not_now', 'out_of_office', 'bounce', 'unsubscribe', 'not_interested', 'referral', 'unclear', 'legal', 'angry'];

const emails = async (id, q = '', headers = {}) => call('api/mc/hub/[id]/emails/route', 'GET', { path: `/api/mc/hub/${id}/emails${q}`, params: { id }, headers });
const threads = async (id, headers = {}) => call('api/mc/hub/[id]/threads/route', 'GET', { path: `/api/mc/hub/${id}/threads`, params: { id }, headers });
const thread = async (id, threadId, headers = {}) => call('api/mc/hub/[id]/threads/[threadId]/route', 'GET', { path: `/api/mc/hub/${id}/threads/${threadId}`, params: { id, threadId }, headers });

async function allPages(id, limit) {
  const out = [];
  let r = (await emails(id, `?limit=${limit}`)).json;
  const total = r.total;
  for (let guard = 0; guard < 500; guard++) {
    assert.equal(r.total, total, 'the total is the same on every page');
    out.push(...r.sent);
    if (!r.next) break;
    assert.equal(r.next, r.sent.at(-1).at, 'next = the time of the last email returned');
    r = (await emails(id, `?limit=${limit}&before=${encodeURIComponent(r.next)}`)).json;
  }
  return { out, total };
}

async function withDemo() {
  __reset();
  installJourney({ seed: 7 });
  process.env.ENC_KEY = process.env.ENC_KEY || Buffer.alloc(32, 7).toString('base64');
  clock.set(et('2026-12-09', '10:00'));
  const r = await call('api/mc/demo/route', 'POST', { path: '/api/mc/demo', body: { action: 'load' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
}

test('the Test run clients: every email that went out, every conversation, word for word', { timeout: 120_000 }, async () => {
  await withDemo();
  const seen = {};
  for (const id of [H, S, L]) {
    const first = await emails(id);
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.deepEqual(Object.keys(first.json).sort(), ['next', 'sent', 'total']);
    const e0 = first.json.sent[0];
    assert.deepEqual(Object.keys(e0).sort(), ['at', 'company', 'from', 'id', 'kind', 'status', 'subject', 'threadId', 'to', 'toName']);
    const want = Math.min(200, first.json.total);
    assert.ok(first.json.sent.length <= want && first.json.sent.length > want - 10, `${id}: the default page is 200 less the emails of its last second (${first.json.sent.length} of ${first.json.total})`);
    const { out, total } = await allPages(id, 200);
    assert.equal(out.length, total, `${id}: the pages add up to the total`);
    assert.equal(new Set(out.map((e) => e.id)).size, out.length, 'no email twice');
    assert.deepEqual(out.map((e) => e.at), [...out.map((e) => e.at)].sort().reverse(), 'newest first');
    for (const e of out) {
      assert.ok(['first', 'followup', 'bot', 'owner', 'client'].includes(e.kind), e.kind);
      assert.ok(['sent', 'bounced', 'replied', 'failed'].includes(e.status), e.status);
      assert.match(e.threadId, /^[A-Za-z0-9_-]+$/, 'a URL-safe thread id');
      assert.ok(Date.parse(e.at) <= clock.now.getTime(), `${id}: nothing in the future (${e.at})`);
    }
    const cold = out.filter((e) => e.kind === 'first' || e.kind === 'followup');
    const board = (await call('api/mc/hub/[id]/route', 'GET', { path: `/api/mc/hub/${id}`, params: { id } })).json;
    assert.equal(cold.length, board.row.five.sent, `${id}: every cold email counted on the board is in the log`);
    assert.ok(cold.every((e) => e.to.endsWith('.example') && e.from.endsWith('.example') && e.subject && e.company && e.toName));
    assert.ok(out.some((e) => e.status === 'replied') && out.some((e) => e.status === 'bounced'), `${id}: replied and bounced marked`);
    assert.ok(out.some((e) => e.kind === 'bot') && out.some((e) => e.kind === 'owner') && out.some((e) => e.kind === 'client'));
    // A smaller page gives the same list (the page edge never drops or repeats an email).
    const small = await allPages(id, 7);
    assert.deepEqual(small.out.map((e) => e.id), out.map((e) => e.id));
    // ?kind= narrows it.
    const firsts = (await emails(id, '?kind=first&limit=500')).json;
    assert.ok(firsts.sent.length && firsts.sent.every((e) => e.kind === 'first') && firsts.total === out.filter((e) => e.kind === 'first').length);

    const list = (await threads(id)).json.threads;
    assert.ok(list.length >= (id === L ? 5 : 12) && list.length <= 19, `${id}: ${list.length} threads`);
    assert.deepEqual(Object.keys(list[0]).sort(), ['count', 'handledBy', 'kind', 'lastAt', 'lead', 'snippet', 'threadId']);
    assert.deepEqual(list.map((t) => t.lastAt), [...list.map((t) => t.lastAt)].sort().reverse(), 'newest first');
    for (const t of list) {
      assert.ok(KINDS.includes(t.kind), t.kind);
      assert.ok([null, 'bot', 'client', 'owner'].includes(t.handledBy));
      assert.ok(t.lead.email && t.lead.name && t.lead.company);
    }
    for (const k of ['interested', 'not_now', 'out_of_office', 'bounce', 'unsubscribe']) assert.ok(list.some((t) => t.kind === k), `${id}: a ${k} thread`);
    const hot = list.find((t) => t.kind === 'interested');
    assert.equal(hot.handledBy, 'client');
    const th = (await thread(id, hot.threadId)).json;
    assert.deepEqual(Object.keys(th).sort(), ['lead', 'messages', 'threadId']);
    assert.equal(th.messages.length, hot.count);
    assert.equal(th.messages.at(-1).at, hot.lastAt);
    const [ours, theirs] = th.messages;
    assert.deepEqual([ours.dir, ours.by, theirs.dir, theirs.by], ['out', 'system', 'in', 'prospect']);
    assert.match(ours.text, new RegExp(`^Hi ${th.lead.name.split(' ')[0]},\\n\\n`), 'our first email in full');
    assert.match(ours.text, /reply STOP/);
    assert.ok(ours.text.length > 300);
    assert.equal(ours.to, `${th.lead.name} <${th.lead.email}>`);
    assert.match(theirs.text, /Interested/);
    assert.match(th.messages.find((m) => m.by === 'bot').text, /glad it’s of interest/);
    assert.ok(th.messages.some((m) => m.by === 'client' && m.dir === 'in'), 'the client answered the hand-off');
    for (const m of th.messages) assert.deepEqual(Object.keys(m).sort(), ['at', 'by', 'dir', 'from', 'subject', 'text', 'to']);
    // Every sent email opens its conversation, a reply or not.
    for (const e of [out.find((x) => x.kind === 'first' && x.status === 'sent'), out.find((x) => x.kind === 'followup'), out.find((x) => x.kind === 'owner')]) {
      const t = await thread(id, e.threadId);
      assert.equal(t.status, 200, `${id} ${e.kind}`);
      assert.ok(t.json.messages.some((m) => m.subject === e.subject && m.text && m.text !== NOT_STORED), `${id}: the ${e.kind} email is in its thread with its text`);
    }
    seen[id] = { sent: out.length, cold: cold.length, threads: list.length };
  }
  // Each client's own prospects only.
  const hl = new Set((await allPages(H, 500)).out.map((e) => e.to));
  const ll = (await allPages(L, 500)).out.filter((e) => e.kind === 'first').map((e) => e.to);
  assert.deepEqual(ll.filter((x) => hl.has(x)), []);
  console.log('SEEN', JSON.stringify(seen));
});

test('employees may read them; unknown client or thread → 404; a bad before → 400', async () => {
  await withDemo();
  for (const p of [`/api/mc/hub/${H}/emails`, `/api/mc/hub/${H}/threads`, `/api/mc/hub/${H}/threads/abc`]) assert.equal(employeeMayAccess('GET', p), true, p);
  assert.equal(employeeMayAccess('POST', `/api/mc/hub/${H}/emails`), false);
  assert.equal((await emails(S, '?limit=5', EMPLOYEE)).status, 200);
  const t = (await threads(S, EMPLOYEE)).json.threads;
  assert.equal((await thread(S, t[0].threadId, EMPLOYEE)).status, 200);
  assert.equal((await emails('nobody-here')).status, 404);
  assert.equal((await threads('nobody-here')).status, 404);
  assert.equal((await emails('Bad Id')).status, 400);
  assert.equal((await thread(S, threadIdOf('stranger@nowhere.example'))).status, 404, 'a prospect this client never wrote to');
  assert.equal((await thread(S, t[0].threadId.slice(0, -2))).status, 404, 'a broken id');
  assert.equal((await thread(S, '..%2Fx')).status, 404);
  assert.equal((await thread(H, t[0].threadId)).status, 404, 'another client’s prospect');
  assert.equal((await emails(S, '?before=yesterday')).status, 400);
});

test('a real client: sends recorded before texts were kept, ties at the page edge, a failed send', async () => {
  __reset();
  const id = 'acme';
  await kv.hset(K.client(id), { name: 'Acme Plumbing', contactName: 'Pat Doe', contactEmail: 'pat@acme.example', state: 'sending', plan: 'trial' });
  await kv.hset(K.profile(id), { senderName: 'Pat Doe' });
  await kv.sadd(K.inboxes(id), 'pat@acmehq.example');
  const at = '2026-12-01T15:00:00.000Z';
  // Five first emails in the same second (two inboxes, one tick), sent before texts were kept.
  for (let i = 0; i < 5; i++) {
    await saveLead(id, { email: `p${i}@firm${i}.example`, name: `P ${i}`, company: `Firm ${i}`, status: 'in_sequence', sent_at: at, original_subject: `Firm ${i} and Acme`, account_used: 'pat@acmehq.example' });
  }
  await saveLead(id, { email: 'late@firm9.example', name: 'Late One', company: 'Firm 9', status: 'in_sequence', sent_at: '2026-12-02T15:00:00.000Z', original_subject: 'Firm 9 and Acme', account_used: 'pat@acmehq.example', d3_sent_at: '2026-12-05T15:00:00.000Z', d3_subject: 'Re: Firm 9 and Acme', last_error: 'timeout', last_error_at: '2026-12-09T15:00:00.000Z', last_touch_at: '2026-12-05T15:00:00.000Z' });
  await saveLead(id, { email: 'never@firm8.example', status: 'unsent' });
  const p1 = (await emails(id, '?limit=3')).json;
  assert.equal(p1.total, 8, '5 + 2 sent + 1 failed');
  assert.deepEqual(p1.sent.map((e) => [e.kind, e.status]), [['followup', 'failed'], ['followup', 'sent'], ['first', 'sent']]);
  assert.equal(p1.next, '2026-12-02T15:00:00.000Z');
  const p2 = (await emails(id, `?limit=3&before=${encodeURIComponent(p1.next)}`)).json;
  assert.equal(p2.sent.length, 5, 'a page never splits emails of the same second: all five come together');
  assert.equal(p2.next, null);
  const t = (await thread(id, p2.sent[0].threadId)).json;
  assert.deepEqual(t.messages.map((m) => [m.by, m.text]), [['system', NOT_STORED]], 'what exists: the subject, and a note instead of the text');
  assert.equal(t.messages[0].from, 'Pat Doe <pat@acmehq.example>');
  assert.deepEqual((await threads(id)).json, { threads: [] }, 'nobody wrote back');
  assert.equal((await thread(id, threadIdOf('never@firm8.example'))).status, 404, 'never emailed');
});

test('the Test run loads itself once when the hub opens, and never comes back after Remove', { timeout: 120_000 }, async () => {
  __reset();
  installJourney({ seed: 7 });
  clock.set(et('2026-12-09', '10:00'));
  resetAutoloadMemo();
  const board = async () => (await call('api/mc/hub/route', 'GET', { path: '/api/mc/hub' })).json;
  const ids = (b) => b.stages.flatMap((s) => s.clients).map((r) => r.id).filter((x) => x.startsWith('demo-')).sort();
  // Outside production nothing happens by itself (tests, dev).
  assert.deepEqual(ids(await board()), []);
  process.env.DEMO_AUTOLOAD_ANYWHERE = '1';
  try {
    // Switched off in the settings: nothing.
    await kv.hset('system:config', { DEMO_AUTOLOAD: 'false' });
    assert.deepEqual(ids(await board()), []);
    assert.equal(await kv.get(DEMO_AUTOLOADED), null);
    await kv.hdel('system:config', 'DEMO_AUTOLOAD');
    // First open: it loads, and the mark says when.
    assert.deepEqual(ids(await board()), [H, L, S]);
    assert.equal(await kv.get(DEMO_AUTOLOADED), clock.iso());
    const loadedAt = await kv.hget(K.client(H), 'demoLoadedAt');
    // Second open (a new server too): not again.
    clock.set(et('2026-12-09', '11:00'));
    resetAutoloadMemo();
    assert.deepEqual(ids(await board()), [H, L, S]);
    assert.equal(await kv.hget(K.client(H), 'demoLoadedAt'), loadedAt, 'not loaded a second time');
    // The owner presses Remove: it stays removed.
    assert.equal((await call('api/mc/demo/route', 'POST', { path: '/api/mc/demo', body: { action: 'remove' } })).status, 200);
    resetAutoloadMemo();
    assert.deepEqual(ids(await board()), []);
    assert.deepEqual(ids(await board()), []);
    assert.ok(await kv.get(DEMO_AUTOLOADED), 'the mark stays');
  } finally {
    delete process.env.DEMO_AUTOLOAD_ANYWHERE;
    resetAutoloadMemo();
  }
});
