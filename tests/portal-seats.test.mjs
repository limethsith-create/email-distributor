// People limit per plan: seats map, the client's own invite route, and the middleware gate for it.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { __reset, kv } from '@vercel/kv';
import { createClient } from '@/lib/db/client';
import { seatsForPlan } from '@/lib/portal/invite';
import { clientMayAccess } from '@/middleware';

process.env.ENC_KEY = process.env.ENC_KEY || crypto.randomBytes(32).toString('base64');
process.env.OWNER_INBOX = 'owner@aviance.test:app-pw:Limeth Sith';
process.env.PUBLIC_BASE_URL = 'https://app.test';
let sent = [];
nodemailer.createTransport = () => ({
  async sendMail(m) { sent.push(m); return { messageId: m.messageId, accepted: [m.to], rejected: [], response: '250 OK' }; },
  async verify() { return true; },
  close() {},
});
const LINK = `https://aviance.store/#join=${'B'.repeat(43)}`;

beforeEach(async () => {
  __reset(); sent = [];
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith') });
  await createClient('oak-legal', { name: 'Oak Legal', contactName: 'Olive Oak', contactEmail: 'olive@oaklegal.com', mainDomain: 'oaklegal.com', plan: 'growth', state: 'sending' });
});
async function invite(headers, body) {
  const { POST } = await import('@/app/api/mc/portal/invite/route');
  const res = await POST(new Request('http://x/api/mc/portal/invite', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
}

test('seats per plan: starter 2, growth 4, scale 6, unknown = starter', async () => {
  assert.deepEqual([await seatsForPlan('starter'), await seatsForPlan('Growth'), await seatsForPlan('scale'), await seatsForPlan('trial'), await seatsForPlan(undefined)], [2, 4, 6, 2, 2]);
});

test('a client emails an invite for their own business only, and gets the plan limit back', async () => {
  const r = await invite({ 'x-hub-role': 'client', 'x-hub-client': 'oak-legal' }, { email: 'Sam@OakLegal.com', link: LINK });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { ok: true, sent: true, seats: 4 });
  assert.equal(sent[0].to, 'sam@oaklegal.com');
  // the body cannot pick another client
  const other = await invite({ 'x-hub-role': 'client', 'x-hub-client': 'oak-legal' }, { email: 'a@b.co', link: LINK, clientId: 'someone-else' });
  assert.equal(other.status, 200);
  assert.equal(sent.at(-1).to, 'a@b.co');
});

test('not for staff, the public, or a client with no business; bad input sends nothing', async () => {
  for (const h of [{ 'x-hub-role': 'admin' }, { 'x-hub-role': 'employee' }, {}, { 'x-hub-role': 'client' }]) {
    assert.equal((await invite(h, { email: 'sam@oaklegal.com', link: LINK })).status, 403);
  }
  const c = { 'x-hub-role': 'client', 'x-hub-client': 'oak-legal' };
  assert.equal((await invite(c, { email: 'nope', link: LINK })).status, 400);
  assert.equal((await invite(c, { email: 'sam@oaklegal.com', link: 'https://evil.test/#join=' + 'B'.repeat(43) })).status, 400);
  assert.equal((await invite({ 'x-hub-role': 'client', 'x-hub-client': 'ghost' }, { email: 'sam@oaklegal.com', link: LINK })).status, 404);
  assert.equal(sent.length, 0);
});

test('a client can send only so many invites a day', async () => {
  const c = { 'x-hub-role': 'client', 'x-hub-client': 'oak-legal' };
  let last;
  for (let i = 0; i < 21; i++) last = await invite(c, { email: `p${i}@oaklegal.com`, link: LINK });
  assert.equal(last.status, 429);
  assert.equal(sent.length, 20);
});

test('middleware: a client token may POST exactly the invite route, nothing else', () => {
  const q = new URLSearchParams();
  assert.equal(clientMayAccess('POST', '/api/mc/portal/invite', q, 'oak-legal'), true);
  assert.equal(clientMayAccess('POST', '/api/mc/portal/invite', new URLSearchParams('clientId=other'), 'oak-legal'), false);
  assert.equal(clientMayAccess('POST', '/api/mc/portal/numbers', q, 'oak-legal'), false);
  assert.equal(clientMayAccess('POST', '/api/mc/clients/oak-legal', q, 'oak-legal'), false);
  assert.equal(clientMayAccess('POST', '/api/mc/portal/invite/x', q, 'oak-legal'), false);
  assert.equal(clientMayAccess('GET', '/api/mc/portal/numbers', q, 'oak-legal'), true);
});
