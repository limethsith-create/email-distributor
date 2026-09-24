import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { verifyHubToken, __setJwks, isAllowedOrigin, corsHeaders } from '@/lib/auth/supabase';
import { systemsFor, todosFor, stateLabelFor, hubBoard, hubClient, STAGES } from '@/lib/systems/hubview';
import { createClient } from '@/lib/db/client';
import { __reset, kv } from '@vercel/kv';

const SUPA = 'https://zjbxnkpktbghhudjbxhk.supabase.co';
const b64u = (buf) => Buffer.from(buf).toString('base64url');

// ── a throwaway ES256 key pair, published as the "JWKS" ──
async function makeSigner() {
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = await webcrypto.subtle.exportKey('jwk', kp.publicKey);
  __setJwks([{ ...pub, kid: 'test-kid', alg: 'ES256', use: 'sig' }]);
  return async (claims, { kid = 'test-kid', alg = 'ES256' } = {}) => {
    const header = b64u(JSON.stringify({ alg, typ: 'JWT', kid }));
    const payload = b64u(JSON.stringify(claims));
    const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(`${header}.${payload}`));
    return `${header}.${payload}.${b64u(sig)}`;
  };
}
const claims = (over = {}) => ({ iss: `${SUPA}/auth/v1`, aud: 'authenticated', sub: 'u1', email: 'limethsith@gmail.com', exp: Math.floor(Date.now() / 1000) + 3600, ...over });

test('hub tokens: a valid admin token passes; everything else fails closed', async () => {
  const sign = await makeSigner();
  assert.deepEqual(await verifyHubToken(await sign(claims())), { ok: true, email: 'limethsith@gmail.com', sub: 'u1' });
  assert.equal((await verifyHubToken(await sign(claims({ email: 'someone@else.com' })))).error, 'not an admin');
  assert.equal((await verifyHubToken(await sign(claims({ exp: Math.floor(Date.now() / 1000) - 5 })))).error, 'token expired');
  assert.equal((await verifyHubToken(await sign(claims({ iss: 'https://evil.example/auth/v1' })))).error, 'wrong issuer');
  assert.equal((await verifyHubToken(await sign(claims({ aud: 'anon' })))).error, 'wrong audience');
  const good = await sign(claims());
  const tampered = good.replace(/\.[^.]+$/, '.' + b64u(Buffer.alloc(64, 1)));
  assert.equal((await verifyHubToken(tampered)).error, 'bad signature');
  // A token that claims HS256 with no shared secret configured is rejected.
  delete process.env.SUPABASE_JWT_SECRET;
  const hs = `${b64u(JSON.stringify({ alg: 'HS256' }))}.${b64u(JSON.stringify(claims()))}.${b64u('x')}`;
  assert.equal((await verifyHubToken(hs)).error, 'bad signature');
  assert.equal((await verifyHubToken('nonsense')).error, 'malformed token');
  assert.equal((await verifyHubToken('')).error, 'malformed token');
});

test('CORS: only the hub origins are allowed', () => {
  assert.ok(isAllowedOrigin('https://aviance.store'));
  assert.ok(isAllowedOrigin('https://aviance-hub.vercel.app/'));
  assert.ok(!isAllowedOrigin('https://evil.example'));
  assert.ok(!isAllowedOrigin(''));
  assert.equal(corsHeaders('https://aviance.store')['Access-Control-Allow-Origin'], 'https://aviance.store');
});

test('hub sign-on: a form post with a valid token sets the admin cookie and redirects', async () => {
  const sign = await makeSigner();
  process.env.ADMIN_SECRET = 'admin-secret-for-tests';
  const { POST } = await import('@/app/api/mc/login/route');
  const form = new URLSearchParams({ hubToken: await sign(claims()), next: '/mc/clients/acme' });
  const res = await POST(new Request('http://x/api/mc/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() }));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/mc/clients/acme');
  assert.match(res.headers.get('set-cookie'), /^av_session=.+HttpOnly/);
  // An outside "next" is never followed.
  const evil = new URLSearchParams({ hubToken: await sign(claims()), next: '//evil.example/x' });
  const r2 = await POST(new Request('http://x/api/mc/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: evil.toString() }));
  assert.equal(r2.headers.get('location'), '/mc');
  // A bad token gets 401 and no cookie.
  const bad = new URLSearchParams({ hubToken: await sign(claims({ email: 'x@y.z' })), next: '/mc' });
  const r3 = await POST(new Request('http://x/api/mc/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: bad.toString() }));
  assert.equal(r3.status, 401);
  assert.equal(r3.headers.get('set-cookie'), null);
});

// ── the systems and to-dos are pure functions of the stored state ──
const now = new Date('2026-10-20T15:00:00Z');
const base = (over = {}) => ({ client: { id: 'acme', name: 'Acme', state: 'sending', contactName: 'Ann' }, trial: {}, profile: {}, domain: {}, checks: {}, shopping: {}, inboxes: [], leads: {}, lf: {}, approval: {}, sequence: {}, counters: {}, bookings: [], hot: [], invoice: null, promises: [], pacelog: [], reports: [], runState: {}, alerts: [], now, day: 12, minMarket: 1000, ...over });

test('systems: a client waiting for the owner to buy', () => {
  const ctx = base({ client: { id: 'acme', name: 'Acme', state: 'awaiting_purchase', intakeStep: '' }, trial: { agreementAcceptedAt: '2026-10-19T10:00:00Z', agreementName: 'Ann Lee' }, profile: { marketEstimate: '1800', marketCheckedAt: '2026-10-19T10:05:00Z' }, shopping: { sentAt: '2026-10-19T10:10:00Z', chosenDomain: 'acme-team.com', total: 16.13, unconfirmed: [] } });
  const s = Object.fromEntries(systemsFor(ctx).map((x) => [x.key, x]));
  assert.equal(Object.keys(s).length, 13);
  assert.equal(s.intake.status, 'ok');
  assert.match(s.intake.line, /Ann Lee/);
  assert.equal(s.market.status, 'ok');
  assert.match(s.market.line, /1,800 matching companies/);
  assert.equal(s.purchase.status, 'waiting');
  assert.match(s.purchase.line, /acme-team\.com/);
  assert.equal(s.setup.status, 'off');
  assert.equal(s.sending.status, 'off');
  assert.equal(stateLabelFor(ctx), 'Waiting for you to buy — 29 h ago');
  const todo = todosFor(ctx);
  assert.equal(todo.length, 1);
  assert.match(todo[0].text, /Buy acme-team\.com and 2 inboxes/);
  assert.equal(todo[0].urgent, true); // more than 12 h
  assert.deepEqual(todo[0].action, { type: 'view', view: 'purchase', clientId: 'acme' });
});

test('systems: a failed setup check names the fix', () => {
  const ctx = base({ client: { id: 'acme', name: 'Acme', state: 'setup_check' }, domain: { name: 'acme-team.com', setupPhase: 'failed', setupFailedAt: '2026-10-20T14:00:00Z' }, checks: { spf: { status: 'fail', detail: 'add TXT v=spf1 include:_spf.google.com ~all' }, dkim: { status: 'pass' }, mx: { status: 'pending' } }, shopping: { boughtAt: '2026-10-20T13:00:00Z' }, inboxes: [{ email: 'a@acme-team.com' }, { email: 'b@acme-team.com' }] });
  const s = Object.fromEntries(systemsFor(ctx).map((x) => [x.key, x]));
  assert.equal(s.setup.status, 'blocked');
  assert.match(s.setup.line, /Failed: spf/);
  assert.equal(s.purchase.status, 'ok');
  const todo = todosFor(ctx);
  assert.equal(todo.length, 1);
  assert.match(todo[0].text, /Fix the SPF check/);
  assert.match(todo[0].detail, /v=spf1/);
});

test('systems: warming up with a copy change request and an untested booking link', () => {
  const ctx = base({
    client: { id: 'acme', name: 'Acme', state: 'warming' }, day: -6,
    trial: { agreementAcceptedAt: '2026-10-10T00:00:00Z', day1Date: '2026-10-26' },
    domain: { setupPhase: 'passed', setupPassedAt: '2026-10-11T00:00:00Z' },
    inboxes: [{ email: 'a@x.com', warmupStartedAt: '2026-10-11T00:00:00Z', inboxRate7d: 0.93 }, { email: 'b@x.com', warmupStartedAt: '2026-10-11T00:00:00Z', inboxRate7d: '88' }],
    leads: { unsent: 380, in_sequence: 0 }, lf: { status: 'done' },
    approval: { sentAt: '2026-10-19T00:00:00Z', round: 1, sections: { emails: { status: 'change' } }, changes: [{ section: 'emails', text: 'Please drop the price line', at: '2026-10-19T12:00:00Z', round: 1 }] },
    sequence: { variantA: '{}' },
    profile: { bookingRequestSentAt: '2026-10-18T00:00:00Z', bookingTested: '' },
  });
  const s = Object.fromEntries(systemsFor(ctx).map((x) => [x.key, x]));
  assert.equal(s.warmup.status, 'working');
  assert.match(s.warmup.line, /Day 10 of 14 · inbox rate 88%/);
  assert.equal(s.list.status, 'ok');
  assert.equal(s.copy.status, 'waiting');
  assert.match(s.copy.line, /Change requested/);
  assert.equal(s.canary.status, 'working');
  assert.match(stateLabelFor(ctx), /Warming up — Day -6 \(Day 1 on 2026-10-26\)/);
  const todo = todosFor(ctx);
  assert.equal(todo[0].text, "Answer the client's copy change request");
  assert.equal(todo[0].action.type, 'mc');
  assert.ok(todo.some((t) => /booking test/.test(t.text)));
});

test('systems: sending with a legal hold, a dispute, an unpaid invoice and an urgent alert', () => {
  const ctx = base({
    client: { id: 'acme', name: 'Acme', state: 'converted', plan: 'starter', legalHoldAt: '2026-10-19T00:00:00Z', legalHoldReply: 'my lawyer will hear about this', planStartedAt: '2026-10-18T00:00:00Z' },
    trial: { unansweredHot: 2, decisionSentAt: '2026-10-17T00:00:00Z', decision: 'plan' },
    counters: { sent: 400, sentD0: 200, bounces: 4, replies: 12, positive: 5, booked: 3, held: 2, qualified: 2, noshows: 1 },
    bookings: [{ id: 'b1', leadEmail: 'x@y.com', status: 'disputed', disputeReason: 'wrong title', disputedAt: '2026-10-19T10:00:00Z' }],
    invoice: { number: 'INV-1', issuedAt: '2026-10-18T00:00:00Z', amount: 2497 },
    reports: [{ name: 'friday:2026-10-10', renderedAt: 'x' }, { name: 'friday:2026-10-17', renderedAt: 'x' }, { name: 'day29', renderedAt: 'x' }],
    alerts: [{ id: 'al1', at: '2026-10-20T14:00:00Z', urgent: true, title: 'LEGAL reply: acme — sending paused' }],
  });
  const s = Object.fromEntries(systemsFor(ctx).map((x) => [x.key, x]));
  assert.equal(s.sending.status, 'blocked');
  assert.match(s.sending.line, /Legal hold/);
  assert.match(s.sending.detail[0], /400 sent · 200 first touches · bounces 4 \(1%\)/);
  assert.equal(s.replies.status, 'waiting');
  assert.match(s.replies.line, /2 hot leads unanswered/);
  assert.equal(s.calls.status, 'waiting');
  assert.match(s.calls.line, /1 dispute for you to decide/);
  assert.match(s.reports.line, /2 Friday updates · Day 29 report sent · decision page sent 2026-10-17 · decision: plan · invoice unpaid/);
  assert.match(s.closing.line, /plan starter · unpaid/);
  const todo = todosFor(ctx);
  const texts = todo.map((t) => t.text);
  assert.ok(texts.some((t) => /clear the hold/.test(t)));
  assert.ok(texts.some((t) => /Decide the dispute/.test(t)));
  assert.ok(texts.some((t) => /invoice paid/.test(t)));
  assert.ok(texts.some((t) => /LEGAL reply/.test(t)));
  assert.equal(todo[0].urgent, true);
  const firstCalm = todo.findIndex((t) => !t.urgent);
  assert.ok(!todo.slice(firstCalm).some((t) => t.urgent), 'urgent first');
  const legal = todo.find((t) => /clear the hold/.test(t.text));
  assert.deepEqual(legal.action.body, { action: 'clearLegalHold' });
});

test('systems: counters never render as 0 when missing', () => {
  const ctx = base({ counters: {} });
  const s = Object.fromEntries(systemsFor(ctx).map((x) => [x.key, x]));
  assert.match(s.sending.line, /— sent · — first touches · bounces —/);
});

test('hub board: stages, others and machine to-dos', async () => {
  __reset();
  process.env.ENC_KEY = '';
  await createClient('aviance', { name: 'Aviance', plan: 'own', state: 'sending' });
  await createClient('acme', { name: 'Acme', state: 'awaiting_purchase', contactEmail: 'ann@acme.com' });
  await createClient('beta', { name: 'Beta', state: 'sending' });
  await createClient('gone', { name: 'Gone', state: 'declined', declineReason: 'employees' });
  await kv.hset('client:acme:shopping', { sentAt: '2026-10-19T10:10:00Z', chosenDomain: 'acme-team.com', total: 16 });
  const board = await hubBoard();
  assert.equal(board.machine.ok, true);
  assert.deepEqual(board.stages.map((s) => s.key), STAGES.map((s) => s.key));
  const stage = (k) => board.stages.find((s) => s.key === k).clients.map((c) => c.id);
  assert.deepEqual(stage('setup'), ['acme']);
  assert.deepEqual(stage('live'), ['beta']);
  assert.deepEqual(stage('ended'), ['gone']);
  assert.deepEqual(board.machine.others.map((c) => c.id), ['aviance']);
  const acme = board.stages.find((s) => s.key === 'setup').clients[0];
  assert.equal(acme.systems.length, 13);
  assert.equal(acme.stateLabel.startsWith('Waiting for you to buy'), true);
  assert.ok(board.todos.some((t) => t.id === 'buy:acme' && t.clientName === 'Acme'));
  assert.ok(board.todos.some((t) => t.id === 'machine-setup' && /ENC_KEY/.test(t.text)));
  assert.ok(board.todos.some((t) => t.id === 'machine-migrate'));
  assert.ok(!('_ctx' in acme));
  const detail = await hubClient('acme');
  assert.equal(detail.row.id, 'acme');
  assert.equal(detail.shopping.chosenDomain, 'acme-team.com');
  assert.equal(detail.holds.legalHoldAt, null);
  assert.equal(await hubClient('nobody'), null);
});
