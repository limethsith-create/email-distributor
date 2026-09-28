import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { verifyHubToken, __setJwks, __resetProfileCache } from '@/lib/auth/supabase';
import { recordPresence, peopleView } from '@/lib/systems/presence';
import { K } from '@/lib/db/keys';
import { __reset, kv } from '@vercel/kv';

const SUPA = 'https://zjbxnkpktbghhudjbxhk.supabase.co';
const b64u = (buf) => Buffer.from(buf).toString('base64url');

async function makeSigner() {
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = await webcrypto.subtle.exportKey('jwk', kp.publicKey);
  __setJwks([{ ...pub, kid: 'test-kid', alg: 'ES256', use: 'sig' }]);
  return async (claims) => {
    const header = b64u(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'test-kid' }));
    const payload = b64u(JSON.stringify(claims));
    const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(`${header}.${payload}`));
    return `${header}.${payload}.${b64u(sig)}`;
  };
}
const claims = (over = {}) => ({ iss: `${SUPA}/auth/v1`, aud: 'authenticated', sub: 'owner-1', email: 'limethsith@gmail.com', exp: Math.floor(Date.now() / 1000) + 3600, ...over });

// Supabase REST stand-in: profiles by id, and a record of the calls.
const PROFILES = {
  'emp-1': { id: 'emp-1', name: 'Nimal Perera', email: 'nimal@aviance.store', role: 'employee', approved: true },
  'emp-2': { id: 'emp-2', name: 'Waiting Person', email: 'wait@aviance.store', role: 'employee', approved: false },
  'adm-9': { id: 'adm-9', name: 'Other Admin', email: 'other@aviance.store', role: 'admin', approved: true },
};
const calls = [];
function stubSupabase() {
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.origin !== SUPA || u.pathname !== '/rest/v1/profiles') throw new Error(`unexpected fetch ${url}`);
    calls.push({ url: String(url), headers: init.headers });
    const id = (u.searchParams.get('id') || '').replace(/^eq\./, '');
    return Response.json(PROFILES[id] ? [PROFILES[id]] : []);
  };
}

const HOST = 'https://email-distributor.vercel.app';
const req = (p, { method = 'GET', token, origin = 'https://aviance.store', extra = {} } = {}) => {
  const url = `${HOST}${p}`;
  const headers = new Headers({ origin, ...extra });
  if (token) headers.set('authorization', `Bearer ${token}`);
  return { url, method, nextUrl: new URL(url), headers, cookies: { get: () => undefined } };
};
const through = (res) => res.headers.get('x-middleware-next') === '1';

test('employee tokens: approved employees are verified via their own profile row, others fail closed', async () => {
  const sign = await makeSigner();
  stubSupabase();
  __resetProfileCache();
  calls.length = 0;
  const empToken = await sign(claims({ sub: 'emp-1', email: 'nimal@aviance.store' }));
  const v = await verifyHubToken(empToken);
  assert.deepEqual(v, { ok: true, email: 'nimal@aviance.store', sub: 'emp-1', role: 'employee', name: 'Nimal Perera' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/rest\/v1\/profiles\?id=eq\.emp-1&select=id,name,email,role,approved$/);
  assert.equal(calls[0].headers.apikey, 'sb_publishable_WV4FANV2hNsmbzK3DbiLFg_9bjiB8Z1');
  assert.equal(calls[0].headers.Authorization, `Bearer ${empToken}`);
  // Cached: no second lookup within a minute.
  await verifyHubToken(empToken);
  assert.equal(calls.length, 1);

  assert.equal((await verifyHubToken(await sign(claims({ sub: 'emp-2', email: 'wait@aviance.store' })))).ok, false, 'not approved');
  assert.equal((await verifyHubToken(await sign(claims({ sub: 'nobody', email: 'x@y.z' })))).ok, false, 'no profile');
  assert.equal((await verifyHubToken(await sign(claims({ sub: 'adm-9', email: 'other@aviance.store' })))).ok, false, 'profile role admin is not HUB_ADMIN_EMAILS');
  // Owner: no profile lookup at all.
  calls.length = 0;
  const a = await verifyHubToken(await sign(claims()));
  assert.equal(a.ok, true);
  assert.equal(a.role, 'admin');
  assert.equal(calls.length, 0);
  // A Supabase outage fails closed (and is not cached as "no").
  __resetProfileCache();
  globalThis.fetch = async () => new Response('down', { status: 503 });
  assert.equal((await verifyHubToken(empToken)).ok, false);
  stubSupabase();
  assert.equal((await verifyHubToken(empToken)).ok, true);
});

test('middleware: employees read, never write; owner-only screens stay closed; admins unchanged', async () => {
  const sign = await makeSigner();
  stubSupabase();
  __resetProfileCache();
  const { middleware } = await import('@/middleware');
  const emp = await sign(claims({ sub: 'emp-1', email: 'nimal@aviance.store' }));
  const admin = await sign(claims());

  // Allowed GET, with identity passed on (a spoofed header is replaced).
  let res = await middleware(req('/api/mc/hub', { token: emp, extra: { 'x-hub-role': 'admin' } }));
  assert.ok(through(res));
  assert.equal(res.headers.get('x-middleware-request-x-hub-user'), 'nimal@aviance.store');
  assert.equal(res.headers.get('x-middleware-request-x-hub-role'), 'employee');
  assert.equal(res.headers.get('x-hub-role'), 'employee');
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://aviance.store');
  assert.ok(through(await middleware(req('/api/mc/clients/acme', { token: emp }))));
  assert.ok(through(await middleware(req('/api/mc/hub/acme', { token: emp, method: 'HEAD' }))));

  // Writes are refused.
  for (const [p, method] of [['/api/mc/clients/acme', 'POST'], ['/api/mc/alerts', 'POST'], ['/api/mc/hub', 'PUT'], ['/api/mc/queue', 'DELETE']]) {
    res = await middleware(req(p, { token: emp, method }));
    assert.equal(res.status, 403, `${method} ${p}`);
    assert.deepEqual(await res.json(), { error: 'Read-only: ask the owner to do this.' });
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://aviance.store', 'CORS on the refusal too');
  }
  // Owner-only screens are refused even for reading.
  for (const p of ['/api/mc/keys', '/api/mc/config', '/api/mc/google', '/api/mc/cheapinboxes', '/api/mc/people', '/api/mc/test', '/api/mc/push/status', '/api/mc/warmup', '/api/mc/setup']) {
    res = await middleware(req(p, { token: emp }));
    assert.equal(res.status, 403, p);
  }
  // Presence is the one POST.
  res = await middleware(req('/api/mc/presence', { token: emp, method: 'POST' }));
  assert.ok(through(res));

  // Unapproved / unknown users: 401 as before.
  res = await middleware(req('/api/mc/hub', { token: await sign(claims({ sub: 'emp-2', email: 'wait@aviance.store' })) }));
  assert.equal(res.status, 401);
  res = await middleware(req('/api/mc/hub', { token: await sign(claims({ sub: 'ghost', email: 'ghost@x.com' })) }));
  assert.equal(res.status, 401);

  // Admins: everything, as before.
  for (const [p, method] of [['/api/mc/keys', 'GET'], ['/api/mc/clients/acme', 'POST'], ['/api/mc/people', 'GET'], ['/api/mc/presence', 'POST']]) {
    res = await middleware(req(p, { token: admin, method }));
    assert.ok(through(res), `${method} ${p}`);
    assert.equal(res.headers.get('x-middleware-request-x-hub-role'), 'admin');
    assert.equal(res.headers.get('x-middleware-request-x-hub-user'), 'limethsith@gmail.com');
  }
});

test('hub single sign-on stays admin-only (an employee token gets no admin cookie)', async () => {
  const sign = await makeSigner();
  stubSupabase();
  __resetProfileCache();
  __reset();
  process.env.ADMIN_SECRET = 'admin-secret-for-tests';
  const { POST } = await import('@/app/api/mc/login/route');
  const form = new URLSearchParams({ hubToken: await sign(claims({ sub: 'emp-1', email: 'nimal@aviance.store' })), next: '/mc' });
  const res = await POST(new Request('http://x/api/mc/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() }));
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('set-cookie'), null);
});

const EMP = { uid: 'emp-1', email: 'nimal@aviance.store', role: 'employee', name: 'Nimal Perera' };
const at = (s) => new Date(Date.parse('2026-10-01T06:00:00Z') + s * 1000);

test('presence: sign-in, views, heartbeats and sign-out update the person and the log', async () => {
  __reset();
  assert.equal((await recordPresence(EMP, { event: 'signin', name: 'Spoofed' }, at(0))).ok, true);
  assert.deepEqual(await recordPresence(EMP, { event: 'active', view: 'trials' }, at(60)), { ok: true, listed: false });
  assert.equal((await recordPresence(EMP, { event: 'view', view: 'trials' }, at(90))).listed, true);
  assert.equal((await recordPresence(EMP, { event: 'view', view: 'trials' }, at(150))).listed, false, 'same view within 10 min');
  assert.equal((await recordPresence(EMP, { event: 'view', view: 'paying' }, at(200))).listed, true);
  assert.equal((await recordPresence(EMP, { event: 'view', view: 'trials' }, at(260))).listed, true, 'different from the previous listed event');
  assert.equal((await recordPresence(EMP, { event: 'bogus' }, at(261))).ok, false);
  await recordPresence(EMP, { event: 'signout' }, at(300));

  const h = await kv.hgetall(K.hubPerson('emp-1'));
  assert.equal(h.name, 'Nimal Perera', 'the verified name wins over the body');
  assert.equal(h.email, 'nimal@aviance.store');
  assert.equal(h.role, 'employee');
  assert.equal(h.firstSeen, at(0).toISOString());
  assert.equal(h.lastSignIn, at(0).toISOString());
  assert.equal(h.lastSignOut, at(300).toISOString());
  assert.equal(h.lastSeen, at(300).toISOString());
  assert.equal(h.lastView, 'trials');
  assert.equal(Number(h.sessions), 1);
  // Active time: 60 + 30 + 60 + 50 + 60 seconds of gaps, all under 3 minutes.
  assert.equal(Number(h.activeSeconds), 260);

  const log = await kv.lrange(K.hubActivity(), 0, -1);
  assert.deepEqual(log.map((e) => `${e.event}:${e.view || ''}`), ['signout:', 'view:trials', 'view:paying', 'view:trials', 'signin:']);
  assert.ok(log.every((e) => e.uid === 'emp-1' && e.email === 'nimal@aviance.store' && e.role === 'employee'));

  // A long gap (> 3 minutes, e.g. the laptop slept) adds nothing.
  await recordPresence(EMP, { event: 'signin' }, at(400));
  await recordPresence(EMP, { event: 'active' }, at(400 + 600));
  assert.equal(Number((await kv.hgetall(K.hubPerson('emp-1'))).activeSeconds), 260);
  await recordPresence(EMP, { event: 'active' }, at(400 + 660));
  assert.equal(Number((await kv.hgetall(K.hubPerson('emp-1'))).activeSeconds), 320);
  assert.equal(Number((await kv.hgetall(K.hubPerson('emp-1'))).sessions), 2);
});

test('presence: posts over the per-user limit are dropped silently', async () => {
  __reset();
  for (let i = 0; i < 120; i++) await recordPresence(EMP, { event: 'active' }, at(i));
  const r = await recordPresence(EMP, { event: 'signin' }, at(121));
  assert.deepEqual(r, { ok: true, limited: true });
  assert.equal((await kv.lrange(K.hubActivity(), 0, -1)).length, 0);
});

test('/api/mc/presence and /api/mc/people: identity from the token; people is admin-only with an online flag', async () => {
  const sign = await makeSigner();
  stubSupabase();
  __resetProfileCache();
  __reset();
  const emp = await sign(claims({ sub: 'emp-1', email: 'nimal@aviance.store' }));
  const admin = await sign(claims());
  const { POST } = await import('@/app/api/mc/presence/route');
  const { GET } = await import('@/app/api/mc/people/route');
  const post = (token, body) => POST(new Request(`${HOST}/api/mc/presence`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }));

  let res = await post(emp, { event: 'signin', email: 'evil@x.com', uid: 'owner-1' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  res = await post(emp, { event: 'view', view: 'trial:acme' });
  assert.equal(res.status, 200);
  assert.equal((await post(emp, { event: 'nope' })).status, 400);
  assert.equal((await post('garbage', { event: 'signin' })).status, 401);
  assert.equal((await post(admin, { event: 'signin' })).status, 200);
  assert.equal((await post(admin, { event: 'signout' })).status, 200);
  // Someone seen 10 minutes ago is not online.
  await kv.hset(K.hubPerson('old-1'), { uid: 'old-1', email: 'old@aviance.store', name: 'Old', role: 'employee', lastSeen: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
  await kv.sadd(K.hubPeople(), 'old-1');

  // Employees may not read it.
  res = await GET(new Request(`${HOST}/api/mc/people`, { headers: { authorization: `Bearer ${emp}` } }));
  assert.equal(res.status, 403);

  res = await GET(new Request(`${HOST}/api/mc/people`, { headers: { authorization: `Bearer ${admin}` } }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.people.map((p) => [p.uid, p.online]), [['emp-1', true], ['owner-1', false], ['old-1', false]]);
  const e = body.people[0];
  assert.equal(e.email, 'nimal@aviance.store');
  assert.equal(e.name, 'Nimal Perera');
  assert.equal(e.role, 'employee');
  assert.equal(e.lastView, 'trial:acme');
  assert.equal(e.sessions, 1);
  assert.ok('activeSecondsToday' in e && 'activeSecondsTotal' in e);
  assert.equal(body.people[1].role, 'admin');
  assert.equal(body.people[1].email, 'limethsith@gmail.com');
  assert.deepEqual(body.events.map((x) => `${x.email}:${x.event}`), ['limethsith@gmail.com:signout', 'limethsith@gmail.com:signin', 'nimal@aviance.store:view', 'nimal@aviance.store:signin']);

  // peopleView directly: today's active seconds.
  __reset();
  const now = new Date();
  await recordPresence(EMP, { event: 'signin' }, new Date(now.getTime() - 90_000));
  await recordPresence(EMP, { event: 'active' }, new Date(now.getTime() - 30_000));
  const v = await peopleView(now);
  assert.equal(v.people[0].activeSecondsToday, 60);
  assert.equal(v.people[0].activeSecondsTotal, 60);
  assert.equal(v.people[0].online, true);
});

test('team: everyone with their own "working on" line, where they are and the clients they look after; only the owner assigns clients', async () => {
  __reset();
  const sign = await makeSigner();
  stubSupabase();
  __resetProfileCache();
  const { createClient } = await import('@/lib/db/client');
  await createClient('acme', { name: 'Acme Plumbing', contactEmail: 'a@acme.com', mainDomain: 'acme.com', plan: 'trial', state: 'applied' });
  await createClient('birch', { name: 'Birch Legal', contactEmail: 'b@birch.com', mainDomain: 'birch.com', plan: 'growth', state: 'applied' });
  await recordPresence({ uid: 'emp-1', email: 'nimal@aviance.store', role: 'employee', name: 'Nimal Perera' }, { event: 'signin', view: 'paying' });
  await recordPresence({ uid: 'owner-1', email: 'limethsith@gmail.com', role: 'admin', name: 'Limeth' }, { event: 'signin', view: 'trials' });
  const { GET, POST } = await import('@/app/api/mc/team/route');
  const post = (token, body) => POST(new Request('http://x/api/mc/team', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const emp = await sign(claims({ sub: 'emp-1', email: 'nimal@aviance.store' }));
  const own = await sign(claims());
  // a team member sets their own line; cannot assign clients
  assert.equal((await post(emp, { action: 'status', text: '  Fixing the Birch   Legal copy  ' })).status, 200);
  assert.equal((await post(emp, { action: 'assign', clientId: 'birch', uids: ['emp-1'] })).status, 403);
  // the owner assigns
  assert.equal((await post(own, { action: 'assign', clientId: 'birch', uids: ['emp-1', 'bad id!'] })).status, 200);
  assert.equal((await post(own, { action: 'assign', clientId: 'acme', uids: ['emp-1', 'owner-1'] })).status, 200);
  const t = await (await GET()).json();
  const nimal = t.team.find((p) => p.uid === 'emp-1');
  assert.equal(nimal.status.text, 'Fixing the Birch Legal copy');
  assert.equal(nimal.online, true); assert.equal(nimal.lastView, 'paying');
  assert.deepEqual(nimal.clients.map((c) => c.name).sort(), ['Acme Plumbing', 'Birch Legal']);
  assert.deepEqual(t.owners.birch, ['emp-1'], 'a bad id is dropped');
  assert.deepEqual(t.team.find((p) => p.uid === 'owner-1').clients.map((c) => c.id), ['acme']);
  // clearing
  await post(emp, { action: 'status', text: '' });
  await post(own, { action: 'assign', clientId: 'acme', uids: [] });
  const t2 = await (await GET()).json();
  assert.equal(t2.team.find((p) => p.uid === 'emp-1').status, null);
  assert.equal(t2.owners.acme, undefined);
  assert.equal((await post('nonsense', { action: 'status', text: 'x' })).status, 401);
});
