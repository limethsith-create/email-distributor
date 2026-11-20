// Client accounts (portal): a client's token reaches only GET /api/mc/portal/*, for their own client;
// employees and admins are unchanged; the owner's portal invite email.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto, { webcrypto } from 'node:crypto';
import nodemailer from 'nodemailer';
import { verifyHubToken, __setJwks, __resetProfileCache } from '@/lib/auth/supabase';
import { __reset, kv } from '@vercel/kv';
import { createClient } from '@/lib/db/client';
import { renderTemplate } from '@/lib/templates/client';

process.env.ENC_KEY = process.env.ENC_KEY || crypto.randomBytes(32).toString('base64');
process.env.OWNER_INBOX = 'owner@aviance.test:app-pw:Limeth Sith';
process.env.PUBLIC_BASE_URL = 'https://app.test';
let sent = [];
nodemailer.createTransport = () => ({
  async sendMail(m) { sent.push(m); return { messageId: m.messageId, accepted: [m.to], rejected: [], response: '250 OK' }; },
  async verify() { return true; },
  close() {},
});

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
const PROFILES = {
  'cli-1': { id: 'cli-1', name: 'Dana Stone', email: 'dana@stone.test', role: 'client', approved: true, client_id: 'stone-roofing' },
  'cli-2': { id: 'cli-2', name: 'Not Yet', email: 'wait@stone.test', role: 'client', approved: false, client_id: 'stone-roofing' },
  'cli-3': { id: 'cli-3', name: 'No Id', email: 'noid@stone.test', role: 'client', approved: true, client_id: null },
  'emp-1': { id: 'emp-1', name: 'Nimal Perera', email: 'nimal@aviance.store', role: 'employee', approved: true, client_id: null },
};
function stubSupabase() {
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.origin !== SUPA || u.pathname !== '/rest/v1/profiles') throw new Error(`unexpected fetch ${url}`);
    const id = (u.searchParams.get('id') || '').replace(/^eq\./, '');
    return Response.json(PROFILES[id] ? [PROFILES[id]] : []);
  };
}
const HOST = 'https://email-distributor.vercel.app';
const req = (p, { method = 'GET', token, extra = {} } = {}) => {
  const url = `${HOST}${p}`;
  const headers = new Headers({ origin: 'https://aviance.store', ...extra });
  if (token) headers.set('authorization', `Bearer ${token}`);
  return { url, method, nextUrl: new URL(url), headers, cookies: { get: () => undefined } };
};
const through = (res) => res.headers.get('x-middleware-next') === '1';

test('verifyHubToken: an approved client profile is role client with its clientId; others fail closed', async () => {
  const sign = await makeSigner();
  stubSupabase(); __resetProfileCache();
  assert.deepEqual(await verifyHubToken(await sign(claims({ sub: 'cli-1', email: 'dana@stone.test' }))), { ok: true, email: 'dana@stone.test', sub: 'cli-1', role: 'client', clientId: 'stone-roofing', name: 'Dana Stone' });
  assert.equal((await verifyHubToken(await sign(claims({ sub: 'cli-2', email: 'wait@stone.test' })))).ok, false, 'not approved');
  assert.equal((await verifyHubToken(await sign(claims({ sub: 'cli-3', email: 'noid@stone.test' })))).ok, false, 'no client id');
  const emp = await verifyHubToken(await sign(claims({ sub: 'emp-1', email: 'nimal@aviance.store' })));
  assert.equal(emp.role, 'employee');
  assert.equal(emp.clientId, undefined);
  assert.equal((await verifyHubToken(await sign(claims()))).role, 'admin');
});

test('middleware: a client reaches only GET /api/mc/portal/*, for their own client', async () => {
  const sign = await makeSigner();
  stubSupabase(); __resetProfileCache();
  const { middleware } = await import('@/middleware');
  const cli = await sign(claims({ sub: 'cli-1', email: 'dana@stone.test' }));

  // Allowed: identity passed on, spoofed headers replaced.
  let res = await middleware(req('/api/mc/portal/numbers', { token: cli, extra: { 'x-hub-role': 'admin', 'x-hub-client': 'other-client', 'x-hub-user': 'limethsith@gmail.com' } }));
  assert.ok(through(res));
  assert.equal(res.headers.get('x-middleware-request-x-hub-role'), 'client');
  assert.equal(res.headers.get('x-middleware-request-x-hub-client'), 'stone-roofing');
  assert.equal(res.headers.get('x-middleware-request-x-hub-user'), 'dana@stone.test');
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://aviance.store');
  assert.ok(through(await middleware(req('/api/mc/portal/numbers?clientId=stone-roofing', { token: cli }))), 'their own id is fine');

  // Everything else is "Not allowed".
  const refused = [
    ['GET', '/api/mc/hub'], ['GET', '/api/mc/hub/stone-roofing'], ['GET', '/api/mc/clients/stone-roofing'], ['GET', '/api/mc/portal'], ['GET', '/api/mc/portal/'],
    ['GET', '/api/mc/portalx/numbers'], ['GET', '/api/mc/keys'], ['GET', '/api/mc/ava/facts'], ['GET', '/api/mc/team'], ['GET', '/api/mc/alerts'],
    ['POST', '/api/mc/portal/numbers'], ['POST', '/api/mc/clients/stone-roofing'], ['POST', '/api/mc/presence'], ['POST', '/api/mc/team'], ['POST', '/api/mc/ava/chat'],
    ['PUT', '/api/mc/portal/numbers'], ['DELETE', '/api/mc/portal/numbers'], ['PATCH', '/api/mc/portal/numbers'],
    ['GET', '/api/mc/portal/numbers?clientId=other-client'], ['GET', '/api/mc/portal/numbers?clientId=stone-roofing&clientId=other-client'],
    ['GET', '/api/mc/portal/../hub'], ['GET', '/api/mc/portal/%2e%2e/hub'],
  ];
  for (const [method, p] of refused) {
    res = await middleware(req(p, { token: cli, method }));
    assert.equal(res.status, 403, `${method} ${p}`);
    assert.deepEqual(await res.json(), { error: 'Not allowed' }, `${method} ${p}`);
    assert.ok(!through(res), `${method} ${p}`);
  }
  // Not approved / no client id: 401 as for any unknown user.
  res = await middleware(req('/api/mc/portal/numbers', { token: await sign(claims({ sub: 'cli-2', email: 'wait@stone.test' })) }));
  assert.equal(res.status, 401);
});

test('middleware: employees and admins are unchanged; x-hub-client is never taken from the caller', async () => {
  const sign = await makeSigner();
  stubSupabase(); __resetProfileCache();
  const { middleware } = await import('@/middleware');
  const emp = await sign(claims({ sub: 'emp-1', email: 'nimal@aviance.store' }));
  const admin = await sign(claims());
  let res = await middleware(req('/api/mc/hub', { token: emp, extra: { 'x-hub-client': 'stone-roofing' } }));
  assert.ok(through(res));
  assert.equal(res.headers.get('x-middleware-request-x-hub-role'), 'employee');
  assert.equal(res.headers.get('x-middleware-request-x-hub-client'), null);
  assert.equal((await middleware(req('/api/mc/clients/acme', { token: emp, method: 'POST' }))).status, 403);
  assert.ok(through(await middleware(req('/api/mc/portal/numbers', { token: emp }))), 'staff may read the portal views');
  for (const [p, method] of [['/api/mc/keys', 'GET'], ['/api/mc/clients/acme', 'POST'], ['/api/mc/portal/numbers', 'GET']]) {
    res = await middleware(req(p, { token: admin, method, extra: { 'x-hub-client': 'stone-roofing' } }));
    assert.ok(through(res), `${method} ${p}`);
    assert.equal(res.headers.get('x-middleware-request-x-hub-role'), 'admin');
    assert.equal(res.headers.get('x-middleware-request-x-hub-client'), null, 'a caller-sent x-hub-client is dropped');
  }
});

// ── the invite email ──
beforeEach(async () => {
  __reset(); sent = [];
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith') });
  await createClient('oak-legal', { name: 'Oak Legal', contactName: 'Olive Oak', contactEmail: 'olive@oaklegal.com', mainDomain: 'oaklegal.com', plan: 'growth', state: 'sending' });
});
const TOKEN = 'A'.repeat(43);
const LINK = `https://aviance.store/#join=${TOKEN}`;
async function act(body, role = 'admin') {
  const { POST } = await import('@/app/api/mc/clients/[id]/route');
  const headers = { 'content-type': 'application/json', ...(role ? { 'x-hub-role': role } : {}) };
  const res = await POST(new Request('http://x/api/mc/clients/oak-legal', { method: 'POST', headers, body: JSON.stringify(body) }), { params: { id: 'oak-legal' } });
  return { status: res.status, body: await res.json() };
}

test('invitePortal: emails the link to the address (owner only) and returns sent', async () => {
  const r = await act({ action: 'invitePortal', email: ' Sam@OakLegal.com ', link: LINK });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { ok: true, sent: true, seats: 4 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'sam@oaklegal.com');
  assert.equal(sent[0].subject, 'Your Aviance portal');
  assert.ok(sent[0].text.startsWith('Hi there,'));
  assert.ok(sent[0].text.includes(LINK));
  assert.ok(sent[0].text.endsWith('Limeth Sith'));
  const r2 = await act({ action: 'invitePortal', email: 'olive@oaklegal.com', link: LINK });
  assert.equal(r2.status, 200);
  assert.ok(sent[1].text.startsWith('Hi Olive,'));
});

test('invitePortal: not for employees or clients; bad address or link sends nothing', async () => {
  for (const role of ['employee', 'client', null]) {
    const r = await act({ action: 'invitePortal', email: 'sam@oaklegal.com', link: LINK }, role);
    assert.equal(r.status, 403, String(role));
  }
  assert.equal((await act({ action: 'invitePortal', email: 'nope', link: LINK })).status, 400);
  for (const link of ['', 'https://evil.example/#join=' + TOKEN, 'https://aviance.store/#join=short', 'https://aviance.store/', 'javascript:alert(1)']) {
    assert.equal((await act({ action: 'invitePortal', email: 'sam@oaklegal.com', link })).status, 400, link);
  }
  assert.equal(sent.length, 0);
});

test('portal_invite template: plain, signed by the owner, with the link', () => {
  const m = renderTemplate('portal_invite', { clientName: 'Oak Legal', firstName: 'Olive', portalLink: LINK, ownerName: 'Limeth Sith' });
  assert.match(m.text, /^Hi Olive,\n\n/);
  assert.ok(m.text.includes(LINK));
  assert.match(m.text, /\n\nLimeth Sith$/);
});
