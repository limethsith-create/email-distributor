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
import { loadDemo } from './helpers/demo-fixture.mjs';
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
  await loadDemo({ now: new Date(clock.iso()) });
}

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

