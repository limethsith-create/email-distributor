// Outreach archive (systems/archive.js, /api/mc/archive): the owner's own
// outreach history saved as one JSON object (in ≤ 400 KB pieces), then — only
// after the saved copy reads back whole — cleared: contacted leads out (and
// suppressed for good), history keys gone, uncontacted leads kept.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, __dump, kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { getTodayKey } from '@/lib/metrics';
import { buildOutreachArchive, saveArchive, readArchive, listArchives, clearOutreach, chunkText, CHUNK_BYTES, HISTORY_KEYS } from '@/lib/systems/archive';
import { GET as listRoute, POST } from '@/app/api/mc/archive/route';
import { GET as oneRoute } from '@/app/api/mc/archive/[id]/route';
import { employeeMayAccess } from '@/middleware';

const TODAY = getTodayKey(new Date());
const post = (body, headers = {}) => POST(new Request('http://x/api/mc/archive', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));

async function seed() {
  await kv.hset('leads', {
    'ann@acme.test': { email: 'ann@acme.test', company: 'Acme', status: 'sent-d0', sent_at: '2026-09-10T14:00:00.000Z', account_used: 'me@aviance.test', original_subject: 'Quick one', original_message_id: '<m1@aviance.test>', appPassword: 'hunter2', token: 'tok-secret' },
    'bo@bolt.test': { email: 'bo@bolt.test', company_name: 'Bolt', status: 'replied', sent_at: '2026-09-11T15:00:00.000Z', account_used: 'me@aviance.test', replied_at: '2026-09-12T10:00:00.000Z', reply_kind: 'human', reply_text: 'Tell me more', reply_subject: 'Re: Quick one' },
    'cy@cog.test': { email: 'cy@cog.test', company: 'Cog', status: 'bounced', sent_at: '2026-09-11T16:00:00.000Z', account_used: 'me@aviance.test', bounced_at: '2026-09-11T16:05:00.000Z', bounce_reason: '550 no such user' },
    'dee@dune.test': { email: 'dee@dune.test', company: 'Dune', status: 'pending' },
  });
  await kv.lpush('sent_log',
    { to: 'ann@acme.test', from: 'me@aviance.test', subject: 'Quick one', touch: 'd0', source: 'auto-send-scheduled', status: 'sent', timestamp: '2026-09-10T14:00:00.000Z' },
    { to: 'gone@old.test', from: 'me@aviance.test', subject: 'Old one', touch: 'd0', source: 'auto-send-scheduled', status: 'sent', company: 'Old Co', timestamp: '2026-09-09T14:00:00.000Z' });
  await kv.hset('email_opens', { 'ann@acme.test': { email: 'ann@acme.test', firstAt: '2026-09-10T15:00:00.000Z', firstHumanAt: '2026-09-10T15:00:00.000Z', count: 2, humanCount: 2 } });
  await kv.hset('email_opens_first', { 'ann@acme.test': '2026-09-10T15:00:00.000Z' });
  await kv.hset('email_opens_first_human', { 'ann@acme.test': '2026-09-10T15:00:00.000Z' });
  await kv.hset('email_open_counts', { 'ann@acme.test': 2 });
  await kv.lpush('open_events', { email: 'ann@acme.test', at: '2026-09-10T15:00:00.000Z', human: true });
  await kv.hset('replies_v3', { 'bo@bolt.test:<r1>': { from: 'bo@bolt.test', leadEmail: 'bo@bolt.test', company: 'Bolt', subject: 'Re: Quick one', text: 'Tell me more', date: '2026-09-12T10:00:00.000Z' } });
  await kv.hset('bounces', { 'cy@cog.test': { email: 'cy@cog.test', reason: '550 no such user', account: 'me@aviance.test', bouncedAt: '2026-09-11T16:05:00.000Z' } });
  await kv.lpush('reply_events', { kind: 'ooo', at: '2026-09-12T11:00:00.000Z' });
  await kv.hset('conversations', { 'bo@bolt.test': { email: 'bo@bolt.test', intent: 'interested' } });
  await kv.hset('msgid_index', { 'm1@aviance.test': 'ann@acme.test' });
  await kv.hset('stats', { totalSent: 3 });
  await kv.hset('daily_sends', { [`me@aviance.test:${TODAY}`]: 4, [`me@aviance.test:${TODAY}:d0`]: 4, 'me@aviance.test:2026-09-10': 1 });
  await kv.sadd('company_sent', 'acme', 'bolt');
  await kv.sadd('suppression', 'optout@x.test');
  await kv.hset(K.countersTotal('aviance'), { sent: 3 });
  await kv.hset(K.countersDay('aviance', '2026-09-10'), { sent: 1 });
}

beforeEach(async () => { __reset(); await seed(); });

test('archive shape: totals, days (oldest first), sent / replies / bounces rows, contacted leads only, no secrets', async () => {
  const a = await buildOutreachArchive({ now: new Date('2026-09-28T12:00:00Z') });
  assert.match(a.id, /^arc-20260928-120000-[a-z0-9]{6}$/);
  assert.equal(a.createdAt, '2026-09-28T12:00:00.000Z');
  assert.deepEqual(Object.keys(a), ['id', 'createdAt', 'totals', 'days', 'sent', 'replies', 'bounces', 'leads']);
  assert.deepEqual(a.totals, { sent: 4, opened: 1, replies: 1, bounces: 1, days: 3, firstDay: '2026-09-09', lastDay: '2026-09-11' });
  assert.deepEqual(a.days.map((d) => d.date), ['2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12']);
  assert.deepEqual(a.days[1], { date: '2026-09-10', sent: 1, opened: 1, replies: 0, bounces: 0 });
  assert.deepEqual(a.sent[0], { at: '2026-09-09T14:00:00.000Z', to: 'gone@old.test', company: 'Old Co', subject: 'Old one', touch: 'd0', from: 'me@aviance.test' });
  assert.deepEqual(a.replies[0], { at: '2026-09-12T10:00:00.000Z', from: 'bo@bolt.test', company: 'Bolt', subject: 'Re: Quick one', text: 'Tell me more' });
  assert.deepEqual(a.bounces[0], { at: '2026-09-11T16:05:00.000Z', email: 'cy@cog.test', reason: '550 no such user', account: 'me@aviance.test' });
  assert.deepEqual(a.leads.map((l) => l.email).sort(), ['ann@acme.test', 'bo@bolt.test', 'cy@cog.test']);
  assert.equal(a.leads.find((l) => l.email === 'bo@bolt.test').company, 'Bolt', 'company_name is kept as company');
  const text = JSON.stringify(a);
  assert.doesNotMatch(text, /hunter2|tok-secret|appPassword|original_message_id/, 'no passwords, tokens or message ids');
});

test('chunking: a big archive is stored in pieces of at most 400 KB and reads back identical', async () => {
  const a = await buildOutreachArchive();
  const big = Array.from({ length: 9000 }, (_, i) => ({ at: `2026-08-${String(1 + (i % 28)).padStart(2, '0')}T10:00:00.000Z`, to: `p${i}@firm${i}.test`, company: `Firm “${i}” — Ünïcode 🚀`, subject: `Hello "${i}" \\ quote`, touch: 'd0', from: 'me@aviance.test' }));
  const archive = { ...a, sent: big, totals: { ...a.totals, sent: big.length } };
  const entry = await saveArchive(archive);
  assert.ok(entry.chunks >= 3, `${entry.chunks} chunks for ${entry.bytes} bytes`);
  assert.equal(entry.bytes, Buffer.byteLength(JSON.stringify(archive)));
  for (let i = 0; i < entry.chunks; i++) {
    const v = (await __dump()).get(K.archiveChunk(entry.id, i));
    assert.ok(Buffer.byteLength(JSON.stringify(v)) <= CHUNK_BYTES, `chunk ${i} ≤ 400 KB`);
  }
  assert.deepEqual(await readArchive(entry.id), archive);
  assert.deepEqual((await listArchives()).map((e) => e.id), [entry.id]);
  assert.deepEqual(Object.keys((await listArchives())[0]), ['id', 'createdAt', 'totals', 'bytes', 'chunks']);
  // chunkText never splits an emoji in two
  const pieces = chunkText('🚀'.repeat(50), 60);
  assert.equal(pieces.join(''), '🚀'.repeat(50));
  for (const p of pieces) assert.doesNotMatch(p, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
  assert.equal(await readArchive('arc-20260101-000000-abcd'), null);
});

test('routes: save a snapshot (nothing cleared), list it, fetch it whole or one section', async () => {
  const res = await post({ action: 'save' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.totals.sent, 4);
  assert.equal(Object.keys(await kv.hgetall('leads')).length, 4, 'nothing cleared');
  const list = await (await listRoute(new Request('http://x/api/mc/archive'))).json();
  assert.equal(list.archives[0].id, body.id);
  const one = await oneRoute(new Request(`http://x/api/mc/archive/${body.id}`), { params: { id: body.id } });
  assert.equal(one.status, 200);
  const full = await one.json();
  assert.equal(full.sent.length, 4);
  const sec = await (await oneRoute(new Request(`http://x/api/mc/archive/${body.id}?section=replies`), { params: { id: body.id } })).json();
  assert.deepEqual(Object.keys(sec), ['id', 'createdAt', 'totals', 'replies']);
  assert.equal((await oneRoute(new Request('http://x/api/mc/archive/nope'), { params: { id: 'nope' } })).status, 404);
  assert.equal((await post({ action: 'nope' })).status, 400);
});

test('clear refuses without confirm "CLEAR" (400) and changes nothing', async () => {
  for (const body of [{ action: 'clear' }, { action: 'clear', confirm: 'clear' }, { action: 'clear', confirm: true }]) {
    const res = await post(body);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /CLEAR/);
  }
  assert.equal(Object.keys(await kv.hgetall('leads')).length, 4);
  assert.equal((await kv.lrange('sent_log', 0, -1)).length, 2);
  assert.deepEqual(await listArchives(), [], 'no archive saved');
});

test('clear: archives first, then suppresses every contacted address, removes contacted leads, deletes the history keys; uncontacted leads, company_sent and suppression stay', async () => {
  const res = await post({ action: 'clear', confirm: 'CLEAR' });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.ok, true);
  assert.match(out.archiveId, /^arc-/);
  assert.equal(out.cleared.leads, 3);
  assert.equal(out.cleared.suppressed, 4);
  // the archive exists and holds everything that was cleared
  const saved = await readArchive(out.archiveId);
  assert.equal(saved.leads.length, 3);
  assert.equal(saved.sent.length, 4);
  assert.equal(saved.replies[0].text, 'Tell me more');
  const entry = (await listArchives())[0];
  assert.equal(entry.id, out.archiveId);
  assert.ok(entry.clearedAt);
  // uncontacted lead kept; contacted ones gone
  assert.deepEqual(Object.keys(await kv.hgetall('leads')), ['dee@dune.test']);
  // suppressed for good, with the reason
  for (const e of ['ann@acme.test', 'bo@bolt.test', 'cy@cog.test', 'gone@old.test', 'optout@x.test']) assert.equal(await kv.sismember('suppression', e), 1, e);
  assert.equal(await kv.sismember('suppression', 'dee@dune.test'), 0);
  assert.equal(await kv.hget(K.archiveSuppressed(), 'ann@acme.test'), `archived_outreach:${out.archiveId}`);
  // history keys gone, company_sent kept
  for (const k of ['sent_log', 'replies_v3', 'bounces', 'email_opens', 'email_opens_first', 'email_opens_first_human', 'email_open_counts', 'open_events', 'reply_events', 'conversations', 'msgid_index', 'stats']) {
    assert.equal(await kv.exists(k), 0, `${k} deleted`);
    assert.ok(out.cleared.keys.includes(k), `${k} reported`);
  }
  assert.deepEqual(HISTORY_KEYS.filter((k) => !out.cleared.keys.includes(k)), []);
  assert.deepEqual((await kv.smembers('company_sent')).sort(), ['acme', 'bolt']);
  // today's send counts survive (the daily cap stays honest); older days are gone
  assert.deepEqual(await kv.hgetall('daily_sends'), { [`me@aviance.test:${TODAY}`]: 4, [`me@aviance.test:${TODAY}:d0`]: 4 });
  // the aviance client's own counters are reset
  assert.equal(await kv.exists(K.countersTotal('aviance')), 0);
  assert.equal(await kv.exists(K.countersDay('aviance', '2026-09-10')), 0);
  assert.ok(out.cleared.keys.includes(K.countersTotal('aviance')));
  // the send lock is released
  assert.equal(await kv.get('auto_send_lock'), null);
});

test('clear: nothing is deleted when the archive cannot be saved, or while a send holds the lock', async () => {
  const realSet = kv.set;
  kv.set = async (k, v, o) => { if (String(k).startsWith('archive:outreach:')) throw new Error('redis down'); return realSet(k, v, o); };
  try {
    await assert.rejects(clearOutreach({ confirm: 'CLEAR' }), /could not save the archive/);
  } finally { kv.set = realSet; }
  assert.equal(Object.keys(await kv.hgetall('leads')).length, 4);
  assert.equal((await kv.lrange('sent_log', 0, -1)).length, 2);
  assert.equal(await kv.sismember('suppression', 'ann@acme.test'), 0);
  assert.equal(await kv.get('auto_send_lock'), null, 'lock released after a failure');
  assert.deepEqual([...(await __dump()).keys()].filter((k) => k.startsWith('archive:outreach:')), []);

  await kv.set('auto_send_lock', 'someone', { nx: true, ex: 120 });
  const res = await post({ action: 'clear', confirm: 'CLEAR' });
  assert.equal(res.status, 409);
  assert.equal(Object.keys(await kv.hgetall('leads')).length, 4);
  assert.equal(await kv.get('auto_send_lock'), 'someone', 'their lock is untouched');
});

test('employees are denied the archive (middleware and route)', async () => {
  assert.equal(employeeMayAccess('GET', '/api/mc/archive'), false);
  assert.equal(employeeMayAccess('GET', '/api/mc/archive/arc-20260928-120000-abcd'), false);
  assert.equal(employeeMayAccess('POST', '/api/mc/archive'), false);
  assert.equal(employeeMayAccess('GET', '/api/mc/outreach'), true);
  const res = await post({ action: 'clear', confirm: 'CLEAR' }, { 'x-hub-role': 'employee' });
  assert.equal(res.status, 403);
  assert.equal((await listRoute(new Request('http://x/api/mc/archive', { headers: { 'x-hub-role': 'employee' } }))).status, 403);
  assert.equal(Object.keys(await kv.hgetall('leads')).length, 4);
});
