// Client dashboard access by email (POST /api/mc/clients/{id} shareDashboard /
// unshareDashboard; GET /api/mc/hub/{id} → dashboardAccess).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { __reset, kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { createClient } from '@/lib/db/client';
import { dashboardView } from '@/lib/systems/clientdash';
import { hubClient } from '@/lib/systems/hubview';
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

beforeEach(async () => {
  __reset();
  sent = [];
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith') });
  await createClient('oak-legal', { name: 'Oak Legal', contactName: 'Olive Oak', contactEmail: 'olive@oaklegal.com', mainDomain: 'oaklegal.com', plan: 'growth', state: 'sending' });
});

const tokenOf = (url) => /\/c\/([^/]+)\/dashboard$/.exec(url)[1];
async function act(body) {
  const { POST } = await import('@/app/api/mc/clients/[id]/route');
  const res = await POST(new Request('http://x/api/mc/clients/oak-legal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: { id: 'oak-legal' } });
  return { status: res.status, body: await res.json() };
}

test('shareDashboard: emails the dashboard link (dashboard_access) and remembers who got it; the hub shows dashboardAccess', async () => {
  const r = await act({ action: 'shareDashboard', email: ' Sam@OakLegal.com ' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.match(r.body.url, /\/c\/[A-Za-z0-9_-]{20,}\/dashboard$/);
  assert.deepEqual(r.body.sharedWith.map((x) => x.email), ['sam@oaklegal.com']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'sam@oaklegal.com');
  assert.equal(sent[0].subject, 'Your Aviance dashboard');
  assert.ok(sent[0].text.startsWith('Hi there,'), 'not the contact → no first name');
  assert.ok(sent[0].text.includes(r.body.url));
  assert.ok(sent[0].text.endsWith('Limeth Sith'));
  assert.equal((await dashboardView(tokenOf(r.body.url))).ok, true);

  // the contact gets their first name; the list keeps one row per address
  const r2 = await act({ action: 'shareDashboard', email: 'olive@oaklegal.com' });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.url, r.body.url, 'the same link');
  assert.ok(sent[1].text.startsWith('Hi Olive,'));
  assert.deepEqual(r2.body.sharedWith.map((x) => x.email), ['sam@oaklegal.com', 'olive@oaklegal.com']);
  assert.ok(r2.body.sharedWith.every((x) => typeof x.at === 'string'));

  const hub = await hubClient('oak-legal');
  assert.deepEqual(hub.dashboardAccess.sharedWith.map((x) => x.email), ['sam@oaklegal.com', 'olive@oaklegal.com']);

  const bad = await act({ action: 'shareDashboard', email: 'not-an-email' });
  assert.equal(bad.status, 400);
  assert.equal(sent.length, 2, 'nothing sent for a bad address');
});

test('unshareDashboard: a fresh link (the old one stops working) and an empty shared list', async () => {
  const r = await act({ action: 'shareDashboard', email: 'sam@oaklegal.com' });
  const u = await act({ action: 'unshareDashboard' });
  assert.equal(u.status, 200);
  assert.equal(u.body.ok, true);
  assert.notEqual(u.body.url, r.body.url);
  assert.equal((await dashboardView(tokenOf(r.body.url))).ok, false, 'old link dead');
  assert.equal((await dashboardView(tokenOf(u.body.url))).ok, true);
  assert.deepEqual((await hubClient('oak-legal')).dashboardAccess, { sharedWith: [] });
  assert.equal(await kv.hget(K.trial('oak-legal'), 'dashboardSharedWith'), '[]');
});

test('dashboard_access template: short, plain, signed by the owner, with the link', () => {
  const m = renderTemplate('dashboard_access', { clientName: 'Oak Legal', firstName: 'Olive', dashboardLink: 'https://app.test/c/tok/dashboard', ownerName: 'Limeth Sith' });
  assert.equal(m.subject, 'Your Aviance dashboard');
  assert.match(m.text, /^Hi Olive,\n\n/);
  assert.match(m.text, /emails sent, replies and booked calls/);
  assert.match(m.text, /https:\/\/app\.test\/c\/tok\/dashboard/);
  assert.match(m.text, /\n\nLimeth Sith$/);
});
