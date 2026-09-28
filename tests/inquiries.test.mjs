import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, kv } from '@vercel/kv';
import { saveInquiry, listInquiries, setInquiryStatus, addInquiryNote, inquiryToTrial, normaliseInquiry } from '@/lib/systems/inquiries';
import { hubBoard } from '@/lib/systems/hubview';
import { pushIo, savePushSub } from '@/lib/push';
import { io } from '@/lib/systems/intake-io';
import { getClient, setState, createClient } from '@/lib/db/client';
import { approveApplication } from '@/lib/systems/gatekeeper';
import { runDayJobs } from '@/lib/systems/trialmanager';

// Exactly what aviance.online's "Book a call" form sends.
const site = (over = {}) => ({
  name: 'Bob Stone', email: 'Bob@StoneRoofing.com', company: 'Stone Roofing', website: 'stoneroofing.com',
  sells: 'Commercial roofing for property managers in Texas', plan: 'growth',
  slotStart: '2026-10-01T14:00:00.000Z', slotEnd: '2026-10-01T14:15:00.000Z', theirTz: 'America/Chicago',
  whenTheirs: 'Thursday, October 1, 2026 at 9:00 AM CDT', whenHost: 'Thursday, October 1, 2026 at 7:30 PM', ...over,
});
let pushed = [];
let emails = [];

beforeEach(async () => {
  __reset();
  pushed = [];
  emails = [];
  process.env.VAPID_PUBLIC_KEY = 'BPUB'; process.env.VAPID_PRIVATE_KEY = 'priv';
  pushIo.send = async (s, payload) => { pushed.push(JSON.parse(payload)); return { statusCode: 201 }; };
  await savePushSub({ endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'p', auth: 'a' } }, 'iPhone');
  io.notifyClient = async (clientId, key) => { emails.push(key); return { sent: true }; };
  io.alertOwner = async () => ({ sent: true });
  io.fetchExt = async () => ({ ok: true, status: 200, url: 'https://stoneroofing.com/', text: async () => '<title>Stone Roofing</title>' });
});

test('an inquiry from the website (no website given) lands in the hub and pops up on the phone', async () => {
  const r = await saveInquiry(site({ website: '' }));
  assert.equal(r.ok, true);
  const { inquiries, counts } = await listInquiries();
  assert.equal(inquiries.length, 1);
  assert.equal(inquiries[0].email, 'bob@stoneroofing.com');
  assert.equal(inquiries[0].plan, 'growth');
  assert.equal(inquiries[0].status, 'new');
  assert.equal(counts.new, 1);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].title, 'Urgent: New plan inquiry: Stone Roofing — call Thursday, October 1, 2026 at 7:30 PM (your time)');
  assert.equal(pushed[0].url, `/#inquiry/${r.id}`);
  assert.match(pushed[0].body, /Bob Stone <bob@stoneroofing\.com> from Stone Roofing asked about Growth/);
  // Double-click on the form: merged, no second alert.
  assert.equal((await saveInquiry(site({ website: '' }))).duplicate, true);
  assert.equal(pushed.length, 1);
  // The board shows it as an urgent to-do.
  const board = await hubBoard();
  const todo = board.todos.find((t) => t.id === `inquiry:${r.id}`);
  assert.equal(todo.urgent, true);
  assert.deepEqual(todo.action, { type: 'view', view: 'inquiry', inquiryId: r.id });
  assert.equal(board.inquiries.counts.new, 1);
});

test('validation, status, notes, and turning an inquiry into a trial', async () => {
  assert.deepEqual(Object.keys(normaliseInquiry({ name: '', email: 'x', company: '', sells: '' }).errors).sort(), ['company', 'email', 'name', 'sells']);
  const { id } = await saveInquiry(site({ plan: 'nonsense', website: '' }));
  assert.equal((await listInquiries()).inquiries[0].plan, null);
  // (a request with no website stays a plain inquiry; give it one before turning it into a trial)
  const rec = (await listInquiries()).inquiries[0];
  await kv.hset('inquiries', { [id]: { ...rec, website: 'stoneroofing.com' } });
  await addInquiryNote(id, 'Left a voicemail');
  const q = await setInquiryStatus(id, 'contacted', 'Call on Thursday');
  assert.equal(q.status, 'contacted');
  assert.deepEqual(q.notes.map((n) => n.text), ['Left a voicemail', 'Call on Thursday']);
  await assert.rejects(() => setInquiryStatus(id, 'maybe'), /status must be one of/);
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith') });
  const t = await inquiryToTrial(id);
  assert.equal(t.ok, true);
  assert.equal(t.outcome, 'onboarding');
  assert.deepEqual(emails, ['accepted_call']);
  assert.equal((await inquiryToTrial(id)).already, true);
});

test('POST /api/inquiry: honeypot, bad data', async () => {
  const { POST } = await import('@/app/api/inquiry/route');
  const ok = await POST(new Request('http://x/api/inquiry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(site({ email: 'z@zeta.com' })) }));
  assert.equal((await ok.json()).ok, true);
  const hp = await POST(new Request('http://x/api/inquiry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(site({ company_url2: 'spam' })) }));
  assert.equal((await hp.json()).ok, true);
  assert.equal((await listInquiries()).inquiries.length, 1, 'the honeypot saved nothing');
  const bad = await POST(new Request('http://x/api/inquiry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }) }));
  assert.equal(bad.status, 400);
});

test('a paid request with a website becomes a paid application: researched, held for the owner, "Say yes" emails them the paid onboarding call — no trial cap, no one-trial rule, no Day 30', async () => {
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith'), MAX_ACTIVE_TRIALS: '0' });
  // an earlier (declined-for-good) trial on the same domain would block a trial, not a paying client
  await createClient('stoneroofing-old', { name: 'Stone Roofing', contactEmail: 'old@stoneroofing.com', mainDomain: 'stoneroofing.com', plan: 'trial', state: 'applied' });
  await setState('stoneroofing-old', 'onboarding', 'test');
  const r = await saveInquiry(site());
  assert.equal(r.ok, true);
  assert.ok(r.clientId, 'a client was made');
  const c = await getClient(r.clientId);
  assert.equal(c.plan, 'growth'); assert.equal(c.state, 'applied'); assert.equal(c.source, 'inquiry');
  const app = await kv.hgetall(`client:${r.clientId}:application`);
  assert.equal(app.review, 'pending');
  assert.match(app.answers, /Plan they asked for.*Growth/);
  assert.deepEqual(emails, [], 'nothing goes to them before the yes');
  assert.equal((await listInquiries()).inquiries[0].clientId, r.clientId);
  // the board: one to-do (the application), not a second "call them back" one
  const board = await hubBoard();
  assert.equal(board.todos.filter((t) => t.id === `inquiry:${r.id}`).length, 0);
  // Say yes → the paid onboarding email, straight to onboarding (the trial cap is 0)
  const out = await approveApplication(r.clientId);
  assert.equal(out.outcome, 'onboarding');
  assert.deepEqual(emails, ['accepted_call_paid']);
  assert.equal((await getClient(r.clientId)).state, 'onboarding');
  // sending on Day 31: no trial report, no Day 30 decision
  await kv.hset(`client:${r.clientId}`, { state: 'sending' });
  await kv.hset(`client:${r.clientId}:trial`, { day1Date: '2026-01-01', firstSendAt: '2026-01-01T15:00:00Z', day1NoticeAt: '2026-01-01T16:00:00Z' });
  const dj = await runDayJobs(r.clientId, { now: new Date('2026-03-01T15:00:00Z') });
  assert.equal(dj.day, 60, 'Day 60 of sending');
  assert.equal(dj.report, undefined); assert.equal(dj.day30, undefined); assert.equal(dj.disposition, undefined);
  assert.equal((await getClient(r.clientId)).state, 'sending');
});
