// Buy once, the rest sets itself up (docs/AUTO-BUY.md): the owner's
// CheapInboxes key (check, card, ONE webhook, encrypted, never shown), the
// shopping list (best free domain, CheapInboxes prices, alternatives,
// personas), finding the purchase (exact domain, alternative, unmatched, one
// domain one trial, link / unlink / pick), the sync (forwarding once, logins →
// encrypted inbox records in the existing shape, all in → the existing setup
// check → warming, idempotent re-runs), problems → one alert each, the
// webhook (signed or not it only wakes a rate-limited sync; its body is never
// used), the manual path without a key, and the guard: no code path can reach
// an endpoint that orders, pays or cancels.
//
// CheapInboxes is a fake behind io.fetchJson that records every call; DNS,
// SMTP and IMAP are stubs. Nothing leaves the machine.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { __reset, kv } from '@vercel/kv';
import { io } from '@/lib/systems/intake-io';
import { K } from '@/lib/db/keys';
import { DEFAULTS } from '@/lib/config';
import { createClient, getClient } from '@/lib/db/client';
import { getInboxRecords, toAccount } from '@/lib/db/inboxes';
import { decrypt } from '@/lib/crypto';
import { exportAll } from '@/lib/systems/backup';
import { ALERTS } from '@/lib/templates/owner';
import { fill } from '@/lib/templates/render';
import { rankCandidates } from '@/lib/systems/domains';
import { submitPurchase } from '@/lib/systems/purchase';
import { hubClient, hubBoard } from '@/lib/systems/hubview';
import * as ci from '@/lib/ext/cheapinboxes';
import {
  personas, candidateOrder, pickDomains, matchDomain, domainState, mailboxState, syncAutobuy, readRec, autobuyView, WAKE,
} from '@/lib/systems/autobuy';

process.env.ENC_KEY = crypto.randomBytes(32).toString('base64');
process.env.PUBLIC_BASE_URL = 'https://app.test';
delete process.env.CHEAPINBOXES_API_KEY;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'ci_live_TestKey_0123456789abcdef';
const HOOK_URL = 'https://app.test/api/webhooks/cheapinboxes';
const T0 = new Date('2026-10-05T14:00:00Z'); // a Monday
const at = (h) => new Date(T0.getTime() + h * 3600e3);

// ── a fake CheapInboxes behind io.fetchJson ──────────────────────────────────
let api;
const ALL_CALLS = []; // every call in this file — the last test checks each was allowed
const reply = (status, json) => ({ status, ok: status >= 200 && status < 300, json, text: JSON.stringify(json ?? null) });
const notFound = (what) => reply(404, { error: { code: 'NOT_FOUND', message: `${what} not found` } });
function freshApi() {
  return {
    calls: [], key: KEY, org: { id: 'org_1', name: 'Aviance Outreach' },
    cards: [{ id: 'pm_1', type: 'card', is_default: true, card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2028 } }],
    hooks: new Map(), hookN: 0, taken: new Set(), prices: { com: 9.99, net: 12.5, co: 24 },
    domains: new Map(), mailboxes: new Map(), creds: new Map(), down: false, patchFail: false, ignoreFilter: false, rejectParams: false,
  };
}
const page = (all, q) => { const limit = Number(q.limit) || 25; const offset = Number(q.offset) || 0; return { rows: all.slice(offset, offset + limit), pagination: { total: all.length, limit, offset } }; };
function fakeCi(url, opts = {}) {
  const u = new URL(url);
  const method = String(opts.method || 'GET').toUpperCase();
  const p = u.pathname;
  const call = { method, path: p, query: Object.fromEntries(u.searchParams), body: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers?.authorization };
  api.calls.push(call);
  ALL_CALLS.push(call);
  assert.equal(u.origin, 'https://api.cheapinboxes.com');
  if (api.down) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  if (call.auth !== `Bearer ${api.key}`) return reply(401, { error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } });
  let m;
  if (method === 'GET' && p === '/v1/org') return reply(200, { organization: api.org, role: 'owner' });
  if (method === 'GET' && p === '/v1/billing/payment-methods') return reply(200, { payment_methods: api.cards });
  if (method === 'GET' && p === '/v1/webhooks') return reply(200, [...api.hooks.values()].map(({ secret, ...h }) => h));
  if (method === 'POST' && p === '/v1/webhooks') {
    const h = { id: `wh_${++api.hookN}`, url: call.body.url, events: call.body.events, secret: `whsec_${crypto.randomBytes(18).toString('base64')}`, created_at: T0.toISOString() };
    api.hooks.set(h.id, h);
    return reply(201, h);
  }
  if (method === 'DELETE' && (m = p.match(/^\/v1\/webhooks\/([^/]+)$/))) return api.hooks.delete(m[1]) ? reply(200, { success: true }) : notFound('Webhook');
  if (method === 'POST' && p === '/v1/discovery/domains/search') {
    const kw = call.body.keyword;
    const exact = (call.body.tlds || ['com']).map((t) => { const d = `${kw}.${t}`; const free = !api.taken.has(d); return { domain: d, available: free, status: free ? 'available' : 'registered', price: api.prices[t] ?? 9.99, currency: 'USD' }; });
    return reply(200, { exact, suggestions: [{ domain: `${kw}leads.com`, available: true, status: 'available', price: 9.99, currency: 'USD' }] });
  }
  const badParams = () => reply(400, { error: { code: 'VALIDATION_ERROR', message: 'Unknown query parameter' } });
  if (method === 'GET' && p === '/v1/domains') { if (api.rejectParams && Object.keys(call.query).length) return badParams(); const r = page([...api.domains.values()], call.query); return reply(200, { domains: r.rows.map(({ provisioning_error, ...d }) => d), pagination: r.pagination }); }
  if (method === 'GET' && (m = p.match(/^\/v1\/domains\/([^/]+)$/))) { const d = api.domains.get(m[1]); return d ? reply(200, { domain: d }) : notFound('Domain'); }
  if (method === 'PATCH' && (m = p.match(/^\/v1\/domains\/([^/]+)\/forwarding$/))) {
    const d = api.domains.get(m[1]);
    if (!d) return notFound('Domain');
    if (api.patchFail) return reply(400, { error: { code: 'VALIDATION_ERROR', message: 'Domain is not provisioned yet' } });
    Object.assign(d, { forwarding_url: call.body.forwarding_url, forwarding_permanent: call.body.permanent, forwarding_status: 'active' });
    return reply(200, { domain: { id: d.id, forwarding_url: d.forwarding_url, forwarding_status: 'active' } });
  }
  if (method === 'GET' && p === '/v1/mailboxes') {
    if (api.rejectParams && Object.keys(call.query).length) return badParams();
    let all = [...api.mailboxes.values()];
    if (call.query.domain_id && !api.ignoreFilter) all = all.filter((x) => x.domain_id === call.query.domain_id);
    const r = page(all, call.query);
    return reply(200, { mailboxes: r.rows, pagination: r.pagination });
  }
  if (method === 'GET' && (m = p.match(/^\/v1\/mailboxes\/([^/]+)\/credentials$/))) { const c = api.creds.get(m[1]); return c ? reply(200, { credentials: c }) : reply(404, { error: { code: 'NOT_FOUND', message: 'Credentials are not available yet' } }); }
  if (method === 'GET' && (m = p.match(/^\/v1\/mailboxes\/([^/]+)$/))) { const x = api.mailboxes.get(m[1]); return x ? reply(200, { mailbox: x }) : notFound('Mailbox'); }
  throw new Error(`fake CheapInboxes does not know ${method} ${p}`);
}
const callsTo = (method, re) => api.calls.filter((c) => c.method === method && re.test(c.path));

/** The owner buys in CheapInboxes (the fake's own state — the machine never does this). */
function ownerBuys(name, { status = 'provisioning', created = T0.toISOString(), autoRenew = true } = {}) {
  const id = `d_${name.replace(/\W/g, '')}`;
  api.domains.set(id, { id, domain: name, status, setup_state: null, provisioning_error: null, source_provider: 'cheapinboxes', dns_mode: 'nameservers', infra_provider: 'google', auto_renew: autoRenew, forwarding_url: null, created_at: created });
  return id;
}
function mailbox(domainId, address, { first = 'Jordan', last = 'Test', status = 'provisioning' } = {}) {
  const id = `mb_${address.replace(/\W/g, '')}`;
  api.mailboxes.set(id, { id, domain_id: domainId, full_email: address, first_name: first, last_name: last, status, source_provider: 'google', daily_limit: 50, created_at: T0.toISOString() });
  return id;
}
function activate(id, { creds = true } = {}) {
  const x = api.mailboxes.get(id);
  x.status = 'active';
  if (creds) api.creds.set(id, { email: x.full_email, password: 'Login-Pass#1', app_password: 'abcd efgh ijkl mnop', imap_host: 'imap.gmail.com', imap_port: 993, smtp_host: 'smtp.gmail.com', smtp_port: 587 });
}

// ── the rest of the world ────────────────────────────────────────────────────
let alerts = [];
let emails = [];
const DNS_FAIL = () => Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
function stubWorld() {
  io.fetchJson = async (url, opts) => fakeCi(url, opts);
  io.alertOwner = async (key, o = {}) => { alerts.push({ key, ...o }); return { sent: true }; };
  io.notifyClient = async (clientId, key, vars) => { emails.push({ clientId, key, vars }); return { sent: true }; };
  // The existing setup check: DNS as CheapInboxes sets it, logins that work, the loopback arriving.
  io.dns = {
    resolveTxt: async (n) => {
      const d = n.replace(/^(google\._domainkey|_dmarc)\./, '');
      if (n.startsWith('google._domainkey.')) return [['v=DKIM1; k=rsa; p=MIIB']];
      if (n.startsWith('_dmarc.')) return [[`v=DMARC1; p=none; rua=mailto:dmarc@${d}`]];
      if (n.includes('.')) return [['v=spf1 include:_spf.google.com ~all']];
      throw DNS_FAIL();
    },
    resolveMx: async () => [{ exchange: 'smtp.google.com', priority: 1 }],
    resolve4: async (n) => { if (/^\d+\.\d+\.\d+\.\d+\./.test(n)) throw DNS_FAIL(); return ['203.0.113.5']; },
  };
  io.fetchExt = async (url) => ({ status: 200, ok: true, url: 'https://acme.com/', text: async () => '', _url: url });
  io.smtpVerify = async () => ({ success: true });
  io.imapLogin = async () => ({ ok: true, spamFolderExists: true });
  io.sendEmail = async (acct, msg) => { emails.push({ key: 'loopback', from: acct.email, to: msg.to, subject: msg.subject, port: acct.smtp?.port }); return { success: true }; };
  io.imapFindMessage = async (acct, token) => ({ found: true, folder: 'INBOX', headers: `Subject: Setup check ${token}\r\nAuthentication-Results: mx.google.com; dkim=pass; spf=pass` });
  io.now = () => T0;
}

beforeEach(async () => {
  __reset();
  api = freshApi();
  alerts = [];
  emails = [];
  globalThis.__after = [];
  delete process.env.CHEAPINBOXES_API_KEY;
  stubWorld();
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith') });
});

const cap = (s) => s[0].toUpperCase() + s.slice(1);
async function waitingClient(id = 'acme', main = 'acme.com', profile = { senderName: 'Jordan Test', senderPrefix: 'jordan' }) {
  await createClient(id, { state: 'awaiting_purchase', name: `${cap(id)} Co`, contactName: 'Ann Lee', contactEmail: `ann@${main}`, mainDomain: main });
  await kv.hset(K.profile(id), profile);
}
/** The key saved and the first look done (what the account already had is baselined), as the route does in after(). */
async function connectKey() {
  await ci.saveKey({ apiKey: KEY });
  return syncAutobuy({ force: true, reason: 'key_saved' });
}
const sync = (h = 0) => syncAutobuy({ force: true, now: at(h) });
const secretsOf = () => [KEY, ...[...api.hooks.values()].map((h) => h.secret)];
const leaks = (answers) => { const text = JSON.stringify(answers); return secretsOf().filter((s) => text.includes(s)); };

async function settings(body) {
  const { POST, GET } = await import('@/app/api/mc/cheapinboxes/route');
  const res = body ? await POST(new Request('https://app.test/api/mc/cheapinboxes', { method: 'POST', body: JSON.stringify(body) })) : await GET();
  return { status: res.status, body: await res.json() };
}
async function action(id, body) {
  const { POST } = await import('@/app/api/mc/clients/[id]/autobuy/route');
  const res = await POST(new Request(`https://app.test/api/mc/clients/${id}/autobuy`, { method: 'POST', body: JSON.stringify(body) }), { params: { id } });
  return { status: res.status, body: await res.json() };
}
async function webhook(raw, headers = {}) {
  const { POST } = await import('@/app/api/webhooks/cheapinboxes/route');
  const res = await POST(new Request('https://app.test/api/webhooks/cheapinboxes', { method: 'POST', body: raw, headers: { 'content-type': 'application/json', ...headers } }));
  return { status: res.status, body: await res.json() };
}
const hmacHex = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest('hex');
const hmacB64 = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest('base64');
const storedSecret = async () => decrypt(await kv.hget(K.cheapinboxes(), 'webhookSecretEnc'));

// ── 1. the owner's key ───────────────────────────────────────────────────────

test('saveKey: checks the key, reads the card, registers ONE webhook; re-save replaces it; the key and the secret are never shown or backed up', async () => {
  const answers = [];
  const bad = await settings({ action: 'saveKey', apiKey: 'sk_live_nope' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /starts with ci_live_/);
  assert.equal(api.calls.length, 0, 'a key that does not look like one is never sent anywhere');

  const saved = await settings({ action: 'saveKey', apiKey: KEY });
  answers.push(saved.body);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.status, 'connected');
  assert.equal(saved.body.account, 'Aviance Outreach');
  assert.equal(saved.body.hasPaymentMethod, true);
  assert.equal(saved.body.webhook, 'registered');
  assert.equal(saved.body.problem, null);
  assert.deepEqual(saved.body.unmatched, []);
  assert.deepEqual(api.calls.map((c) => `${c.method} ${c.path}`), ['GET /v1/org', 'GET /v1/billing/payment-methods', 'GET /v1/webhooks', 'POST /v1/webhooks']);
  const made = api.calls.find((c) => c.method === 'POST');
  assert.deepEqual(made.body, { url: HOOK_URL, events: ['domain.provisioned', 'domain.dns_configured', 'mailbox.active', 'mailbox.credentials_ready', 'order.completed', 'order.failed', 'billing.invoice_failed'] });
  assert.equal(globalThis.__after.length, 1, 'the first look at the account runs after the answer');
  const acct = await kv.hgetall(K.cheapinboxes());
  assert.equal(decrypt(acct.apiKeyEnc), KEY, 'the key is stored encrypted');
  assert.equal(decrypt(acct.webhookSecretEnc), [...api.hooks.values()][0].secret, 'the webhook secret too');
  assert.ok(!JSON.stringify(acct).includes(KEY));

  // Re-saving replaces the webhook: still exactly one.
  const firstHook = acct.webhookId;
  answers.push((await settings({ action: 'saveKey', apiKey: KEY })).body);
  assert.equal(api.hooks.size, 1);
  assert.ok(callsTo('DELETE', /\/v1\/webhooks\/wh_1$/).length === 1);
  assert.notEqual(await kv.hget(K.cheapinboxes(), 'webhookId'), firstHook);

  // Test: the webhook still listed → nothing made; deleted in their dashboard → made again.
  api.calls = [];
  const t1 = await settings({ action: 'test' });
  answers.push(t1.body);
  assert.equal(t1.body.ok, true);
  assert.equal(t1.body.webhookRenewed, false);
  assert.equal(callsTo('POST', /webhooks/).length, 0);
  api.hooks.clear();
  const t2 = await settings({ action: 'test' });
  answers.push(t2.body);
  assert.equal(t2.body.webhookRenewed, true);
  assert.equal(api.hooks.size, 1);

  // No card on the account → the one problem to show.
  api.cards = [];
  const t3 = await settings({ action: 'test' });
  answers.push(t3.body);
  assert.equal(t3.body.hasPaymentMethod, false);
  assert.match(t3.body.problem, /No card on your CheapInboxes account/);

  // A key CheapInboxes refuses is not saved; the old one stays.
  const refused = await settings({ action: 'saveKey', apiKey: 'ci_live_WrongKey_999999999' });
  answers.push(refused.body);
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /refused the API key/);
  assert.equal(decrypt(await kv.hget(K.cheapinboxes(), 'apiKeyEnc')), KEY);

  // The key stops working later: broken, one alert, the plain-words problem.
  api.key = 'ci_live_rotated_000000000000';
  const t4 = await settings({ action: 'test' });
  assert.equal(t4.status, 400);
  const st = (await settings()).body;
  answers.push(st);
  assert.equal(st.status, 'broken');
  assert.match(st.problem, /The key was refused by CheapInboxes/);
  assert.equal(alerts.filter((a) => a.key === 'autobuy_problem').length, 1);
  await settings({ action: 'test' });
  assert.equal(alerts.filter((a) => a.key === 'autobuy_problem').length, 1, 'told once');
  api.key = KEY;
  assert.equal((await settings({ action: 'test' })).body.status, 'connected', 'a working key clears it');

  // Nothing secret in any answer, the backup or the settings view.
  answers.push((await settings()).body);
  assert.deepEqual(leaks(answers), []);
  const backup = JSON.stringify(await exportAll());
  assert.deepEqual(secretsOf().filter((s) => backup.includes(s)), []);
  assert.ok(!backup.includes('apiKeyEnc') && !backup.includes('webhookSecretEnc'));

  // Forget: our webhook goes too.
  const gone = await settings({ action: 'forget' });
  assert.equal(gone.body.status, 'not_set_up');
  assert.equal(gone.body.webhookRemoved, true);
  assert.equal(api.hooks.size, 0);
  assert.equal(gone.body.problem, null);

  // The env key wins; the saved one cannot be changed then.
  process.env.CHEAPINBOXES_API_KEY = KEY;
  assert.equal((await settings()).body.keyFrom, 'env');
  assert.equal((await settings({ action: 'saveKey', apiKey: KEY })).status, 409);
  delete process.env.CHEAPINBOXES_API_KEY;
});

// ── 2. the shopping list ─────────────────────────────────────────────────────

test('shopping list: the best free domain from the candidate builder, CheapInboxes prices, up to 3 alternatives, personas, the order page', async () => {
  await connectKey();
  await waitingClient();
  const tlds = ['com', 'net', 'co'];
  const order = candidateOrder(rankCandidates('acme.com', DEFAULTS.DOMAINS, tlds), {}, tlds);
  api.taken.add(order[0]); // the top name is gone already
  api.calls = [];
  const r = await sync(0.1);
  assert.equal(r.ok, true);
  const { buy } = await readRec('acme');
  const free = order.slice(1);
  assert.equal(buy.domain, free[0]);
  assert.equal(buy.price, 9.99);
  assert.deepEqual(buy.alternatives, free.slice(1, 4).map((domain) => ({ domain, price: 9.99 })));
  assert.equal(buy.provider, 'google');
  assert.equal(buy.orderUrl, 'https://app.cheapinboxes.com/add');
  assert.deepEqual(buy.mailboxes, [
    { firstName: 'Jordan', lastName: 'Test', prefix: 'jordan', email: `jordan@${buy.domain}` },
    { firstName: 'Jordan', lastName: 'Test', prefix: 'jordan.test', email: `jordan.test@${buy.domain}` },
  ]);
  const searches = callsTo('POST', /discovery\/domains\/search$/);
  assert.ok(searches.length >= 1 && searches.length <= DEFAULTS.CHEAPINBOXES.maxSearches);
  assert.ok(searches.every((c) => c.body.keyword && !c.body.keyword.includes('.') && JSON.stringify(c.body.tlds) === JSON.stringify(tlds)));
  assert.ok(!buy.alternatives.some((a) => a.domain.endsWith('leads.com')), 'suggestions outside our own candidates are never offered');

  // The hub: ready_to_buy, the to-do and the red dot.
  const detail = await hubClient('acme');
  assert.equal(detail.autobuy.status, 'ready_to_buy');
  assert.deepEqual(detail.autobuy.buy, buy);
  assert.equal(detail.autobuy.steps[0].key, 'bought');
  assert.equal(detail.autobuy.steps[0].done, false);
  assert.equal(detail.autobuy.label, `Buy ${buy.domain} and 2 inboxes on CheapInboxes`);
  assert.equal(detail.row.simple.label, 'Buy their domain and 2 inboxes on CheapInboxes');
  assert.equal(detail.row.simple.needsYou, true);
  const todo = detail.row.todo.find((t) => t.id === 'buy:acme');
  assert.equal(todo.text, `Buy ${buy.domain} and 2 inboxes on CheapInboxes`);
  assert.deepEqual(todo.action, { type: 'view', view: 'detail', clientId: 'acme', section: 'autobuy' });

  // "Buy this alternative instead".
  const alt = buy.alternatives[1].domain;
  const picked = await action('acme', { action: 'pick', domain: alt });
  assert.equal(picked.status, 200);
  assert.equal(picked.body.ok, true);
  assert.equal(picked.body.autobuy.buy.domain, alt);
  assert.ok(picked.body.autobuy.buy.alternatives.some((a) => a.domain === buy.domain), 'the old one stays listed');
  assert.equal(picked.body.autobuy.buy.mailboxes[0].email, `jordan@${alt}`);
  const wrong = await action('acme', { action: 'pick', domain: 'somethingelse.com' });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.ok, false);
  assert.equal(wrong.body.autobuy.buy.domain, alt, 'every answer carries autobuy');

  // A list is not remade on every look (only after refreshHours).
  api.calls = [];
  await sync(1);
  assert.equal(callsTo('POST', /discovery/).length, 0);
  await sync(DEFAULTS.CHEAPINBOXES.refreshHours + 1);
  assert.ok(callsTo('POST', /discovery/).length >= 1);
  assert.equal((await readRec('acme')).buy.domain, alt, 'the owner\'s pick stays first');
});

test('personas and the pure helpers', () => {
  assert.deepEqual(personas({ senderName: 'Mary Ann Smith' }, 'x.com').map((p) => [p.firstName, p.lastName, p.prefix]), [['Mary', 'Ann Smith', 'mary'], ['Mary', 'Ann Smith', 'mary.smith']]);
  assert.deepEqual(personas({ senderName: 'Jordan Test', senderPrefix: 'jordan.test' }, 'x.com').map((p) => p.prefix), ['jordan.test', 'jtest']);
  assert.deepEqual(personas({ senderName: 'Jordan' }, 'x.com', 3).map((p) => p.prefix), ['jordan', 'jordan.team', 'jordan.hq']);
  assert.deepEqual(personas({}, 'x.com'), [], 'no name, no prefix: nothing invented');
  assert.equal(new Set(personas({ senderName: 'Ann Lee', senderPrefix: 'ann' }, 'x.com', 6).map((p) => p.prefix)).size, 6);
  assert.deepEqual(candidateOrder([{ domain: 'getacme.com' }, { domain: 'acme.xyz' }], { chosenDomain: 'acmehq.com', offers: JSON.stringify([{ domain: 'tryacme.net' }]) }, ['com', 'net'], 'useacme.com'), ['useacme.com', 'acmehq.com', 'tryacme.net', 'getacme.com']);
  assert.deepEqual(pickDomains(['a.com', 'b.com', 'c.com'], { 'a.com': { available: false }, 'b.com': { available: true, price: 5 }, 'c.com': { available: true, price: 6 } }, 1), [{ domain: 'b.com', price: 5 }]);
  const w = [{ id: 'acme', set: new Set(['getacme.com']) }, { id: 'beta', set: new Set(['getacme.com', 'getbeta.com']) }];
  assert.equal(matchDomain('getacme.com', w), null, 'on two trials\' lists: the owner decides');
  assert.equal(matchDomain('getbeta.com', w), 'beta');
  assert.equal(matchDomain('getbeta.com', w, { blocked: ['beta'] }), null, 'never back to a trial that unlinked it');
  assert.equal(domainState({ status: 'active' }), 'live');
  assert.equal(domainState({ status: 'dns_configured' }), 'live');
  assert.equal(domainState({ status: 'provisioning' }), 'provisioning');
  assert.equal(domainState({ status: 'provisioning', provisioning_error: 'x' }), 'failed');
  assert.equal(mailboxState({ status: 'active' }), 'active');
  assert.equal(mailboxState({ status: 'error' }), 'failed');
  assert.equal(mailboxState({ status: 'pending' }), 'provisioning');
  for (const k of ['purchase_found', 'inboxes_ready', 'autobuy_problem', 'purchase_unmatched']) assert.ok(ALERTS[k], k);
  assert.equal(fill('t', ALERTS.purchase_found.title, { domain: 'acmeoutreach.com', company: 'Acme' }), 'We found acmeoutreach.com — connecting it to Acme');
  assert.equal(fill('t', ALERTS.inboxes_ready.title, { domain: 'acmeoutreach.com', count: 2 }), 'acmeoutreach.com and 2 inboxes are ready — warm-up has started');
  assert.equal(fill('t', ALERTS.purchase_unmatched.title, { domain: 'x.com' }), 'You bought x.com — which trial is it for? Pick in Settings');
  assert.equal(autobuyView({ client: { id: 'a', state: 'onboarding' } }), null, 'not at the buying step: no autobuy');
});

// ── 3. finding the purchase ──────────────────────────────────────────────────

test('matching: exact domain, an alternative, unmatched, one domain one trial, link / unlink', async () => {
  ownerBuys('oldcampaign.com', { status: 'active', created: '2026-01-01T00:00:00Z' }); // in the account before the key
  await connectKey();
  await waitingClient('acme', 'acme.com');
  await waitingClient('beta', 'betaplumbing.com');
  await waitingClient('gamma', 'gammalaw.com');
  await sync(0.1);
  const acme = (await readRec('acme')).buy;
  const beta = (await readRec('beta')).buy;
  assert.ok(acme && beta);
  assert.deepEqual((await settings()).body.unmatched, [], 'what the account had before is not a new purchase');

  // He buys acme's first alternative, beta's own domain and something on no list.
  const alt = acme.alternatives[0].domain;
  ownerBuys(alt, { created: at(1).toISOString() });
  ownerBuys(beta.domain, { created: at(1).toISOString() });
  ownerBuys('randomname.com', { created: at(1).toISOString() });
  const r = await sync(1.1);
  assert.deepEqual(r.found.map((f) => `${f.clientId}:${f.domain}`).sort(), [`acme:${alt}`, `beta:${beta.domain}`]);
  assert.equal(r.unmatched, 1);
  assert.equal((await readRec('acme')).domain, alt);
  assert.equal((await readRec('beta')).domain, beta.domain);
  assert.equal((await readRec('gamma')).domain, undefined);
  assert.equal((await getClient('acme')).autobuyOpen, '1');
  assert.ok(await kv.hget(K.shopping('acme'), 'boughtAt'), 'the purchase reminders stop');
  const found = alerts.filter((a) => a.key === 'purchase_found');
  assert.equal(found.length, 2);
  assert.equal(fill('t', ALERTS.purchase_found.title, found.find((a) => a.clientId === 'acme').vars), `We found ${alt} — connecting it to Acme Co`);
  const status = (await settings()).body;
  assert.deepEqual(status.unmatched.map((u) => u.domain), ['randomname.com']);
  assert.equal(status.unmatched[0].mailboxes, 0);
  assert.equal(status.unmatched[0].boughtAt, at(1).toISOString());
  assert.equal(alerts.filter((a) => a.key === 'purchase_unmatched').length, 1);
  assert.equal(alerts.find((a) => a.key === 'purchase_unmatched').url, '/#settings/inboxes');
  const board = await hubBoard({ now: at(1.2) });
  const todo = board.todos.find((t) => t.id === 'unmatched:randomname.com');
  assert.equal(todo.text, 'You bought randomname.com — which trial is it for? Pick in Settings');
  assert.deepEqual(todo.action, { type: 'view', view: 'settings', section: 'inboxes', domain: 'randomname.com' });

  await sync(2);
  assert.equal(alerts.filter((a) => a.key === 'purchase_unmatched').length, 1, 'asked once');
  assert.equal(alerts.filter((a) => a.key === 'purchase_found').length, 2, 'told once');

  // The owner links it to gamma.
  const linked = await action('gamma', { action: 'link', domain: 'RandomName.com' });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.ok, true);
  assert.equal(linked.body.autobuy.status, 'provisioning');
  assert.equal(linked.body.autobuy.domain, 'randomname.com');
  assert.equal(linked.body.autobuy.linkedBy, 'owner');
  assert.equal(linked.body.autobuy.steps[0].done, true);
  assert.deepEqual((await settings()).body.unmatched, []);
  // One domain, one trial.
  const twice = await action('acme', { action: 'link', domain: 'randomname.com' });
  assert.equal(twice.status, 409);
  assert.match(twice.body.error, /already linked/);
  assert.equal(twice.body.autobuy.domain, alt);
  await createClient('delta', { state: 'awaiting_purchase', name: 'Delta', mainDomain: 'delta.com' });
  const taken = await action('delta', { action: 'link', domain: 'randomname.com' });
  assert.equal(taken.status, 409);
  assert.match(taken.body.error, /already linked to gamma/);
  const missing = await action('delta', { action: 'link', domain: 'notbought.com' });
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /not in your CheapInboxes account/);
  assert.equal((await action('gamma', { action: 'link', domain: 'randomname.com' })).status, 200, 'linking again is a no-op');

  // Unlink a wrong automatic link: back to unmatched, and never matched to acme again by itself.
  const un = await action('acme', { action: 'unlink' });
  assert.equal(un.status, 200);
  assert.equal(un.body.autobuy.status, 'ready_to_buy');
  assert.equal(await kv.hget(K.shopping('acme'), 'boughtAt'), null, 'the reminders are back on');
  await sync(3);
  assert.equal((await readRec('acme')).domain, undefined);
  assert.deepEqual((await settings()).body.unmatched.map((u) => u.domain), [alt]);
  assert.equal(alerts.filter((a) => a.key === 'purchase_unmatched').length, 1, 'no "which trial" alert for what he just unlinked');
  assert.equal((await action('acme', { action: 'unlink' })).status, 409);
  // He changes his mind: an explicit link wins over the unlink.
  assert.equal((await action('acme', { action: 'link', domain: alt })).body.autobuy.domain, alt);

  const bad = await action('acme', { action: 'nope' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.ok, false);
  assert.ok('autobuy' in bad.body);
});

// ── 4. connecting it ─────────────────────────────────────────────────────────

test('sync: forwarding once, logins → encrypted inbox records in the existing shape, all in → the setup check → warming; re-runs change nothing', async () => {
  await connectKey();
  await waitingClient();
  await sync(0.1);
  const { buy } = await readRec('acme');
  const did = ownerBuys(buy.domain, { created: at(1).toISOString() });
  const [m1, m2] = buy.mailboxes.map((p) => mailbox(did, p.email));
  api.mailboxes.set('mb_other', { id: 'mb_other', domain_id: 'd_other', full_email: 'x@other.com', status: 'active' }); // someone else's inbox

  // Bought, still provisioning: linked, nothing touched yet.
  api.calls = [];
  await sync(1.1);
  let ab = (await hubClient('acme')).autobuy;
  assert.equal(ab.status, 'provisioning');
  assert.equal(ab.label, `Setting up ${buy.domain} — about 48 hours`);
  assert.deepEqual(ab.mailboxes, buy.mailboxes.map((p) => ({ email: p.email, status: 'provisioning' })));
  assert.equal(callsTo('PATCH', /forwarding/).length, 0);
  assert.equal(callsTo('GET', /credentials/).length, 0);
  const row = (await hubClient('acme')).row;
  assert.equal(row.simple.label, 'Setting up their inboxes (about 2 days)');
  assert.equal(row.simple.needsYou, false);
  assert.ok(!row.todo.some((t) => t.id === 'buy:acme'));

  // The domain is live: forwarding to the client's website, permanent — once.
  api.domains.get(did).status = 'active';
  await sync(2);
  const patches = callsTo('PATCH', /\/v1\/domains\/[^/]+\/forwarding$/);
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].body, { forwarding_url: 'https://acme.com', permanent: true });
  await sync(3);
  assert.equal(callsTo('PATCH', /forwarding/).length, 1, 'set once');
  ab = (await hubClient('acme')).autobuy;
  assert.equal(ab.steps.find((s) => s.key === 'domain').done, true);

  // Mailbox 1 active: its login becomes the client's inbox record.
  activate(m1);
  await sync(4);
  const [rec1] = await getInboxRecords('acme');
  assert.equal(rec1.email, buy.mailboxes[0].email);
  assert.equal(decrypt(rec1.passwordEnc), 'abcdefghijklmnop', 'the app password, what SMTP/IMAP log in with');
  assert.equal(decrypt(rec1.loginPasswordEnc), 'Login-Pass#1');
  assert.equal(rec1.smtpHost, 'smtp.gmail.com');
  assert.equal(Number(rec1.smtpPort), 587);
  assert.equal(rec1.imapHost, 'imap.gmail.com');
  assert.equal(Number(rec1.imapPort), 993);
  assert.equal(rec1.displayName, 'Jordan Test');
  assert.equal(rec1.provider, 'google');
  assert.equal(rec1.enabled, '0');
  assert.equal(rec1.source, 'cheapinboxes');
  assert.ok(!JSON.stringify(rec1).includes('Login-Pass#1') && !JSON.stringify(rec1).includes('abcd efgh'));
  const acct = toAccount(rec1);
  assert.deepEqual(acct.smtp, { host: 'smtp.gmail.com', port: 587, secure: false });
  assert.deepEqual(acct.imap, { host: 'imap.gmail.com', port: 993 });
  assert.equal(acct.appPassword, 'abcdefghijklmnop');
  assert.equal((await getClient('acme')).state, 'awaiting_purchase', 'one of two is not enough');
  assert.deepEqual((await hubClient('acme')).autobuy.mailboxes.map((m) => m.status), ['connected', 'provisioning']);
  assert.equal(callsTo('GET', /mb_other/).length, 0, 'someone else\'s inbox is never read');

  // Mailbox 2 active: all in → the existing setup check → loopback sent.
  activate(m2);
  await sync(5);
  assert.equal((await getClient('acme')).state, 'setup_check');
  const dom = await kv.hgetall(K.domain('acme'));
  assert.equal(dom.name, buy.domain);
  assert.equal(dom.registrar, 'cheapinboxes');
  assert.equal(dom.purchasedAt, at(1).toISOString());
  assert.equal(Number(dom.price), 9.99);
  assert.equal(dom.forwardsTo, 'acme.com');
  assert.ok(emails.some((e) => e.key === 'loopback' && e.port === 587));
  ab = (await hubClient('acme')).autobuy;
  assert.equal(ab.status, 'connecting');
  assert.equal(ab.steps.find((s) => s.key === 'connected').done, true);
  assert.equal(ab.canUnlink, false);
  assert.equal((await action('acme', { action: 'unlink' })).status, 409, 'connected: no unlink');

  // Next look: the loopback arrived → all checks pass → warming, warm-up on, inboxes_ready once.
  await sync(5.2);
  assert.equal((await getClient('acme')).state, 'warming');
  const checks = await kv.hgetall(K.domain('acme'));
  assert.equal(JSON.parse(checks['check:autorenew']).status, 'pass');
  assert.equal(checks.setupPhase, 'passed');
  assert.ok((await getInboxRecords('acme')).every((r) => r.enabled === '1' && r.warmupStartedAt));
  const ready = alerts.filter((a) => a.key === 'inboxes_ready');
  assert.equal(ready.length, 1);
  assert.equal(fill('t', ALERTS.inboxes_ready.title, ready[0].vars), `${buy.domain} and 2 inboxes are ready — warm-up has started`);
  assert.equal((await getClient('acme')).autobuyOpen, '0');
  ab = (await hubClient('acme')).autobuy;
  assert.equal(ab.status, 'done');
  assert.ok(ab.steps.every((s) => s.done));
  assert.equal(ab.label, `${buy.domain} and 2 inboxes are ready — warm-up has started`);

  // Idempotent: more looks change nothing, call nothing that writes, alert nothing.
  const inboxesBefore = JSON.stringify(await getInboxRecords('acme'));
  api.calls = [];
  await sync(6);
  await sync(7);
  assert.equal(callsTo('PATCH', /./).length + callsTo('GET', /credentials/).length + callsTo('POST', /webhooks/).length, 0);
  assert.equal(alerts.filter((a) => ['inboxes_ready', 'purchase_found', 'autobuy_problem'].includes(a.key)).length, 2);
  assert.equal(JSON.stringify(await getInboxRecords('acme')), inboxesBefore);

  // Passwords never reach the hub.
  const detail = JSON.stringify(await hubClient('acme'));
  assert.ok(!detail.includes('passwordEnc') && !detail.includes('loginPasswordEnc') && !detail.includes('abcdefghijklmnop'));
  const backup = JSON.stringify(await exportAll());
  assert.ok(!backup.includes('loginPasswordEnc') && !backup.includes('passwordEnc'));
});

test('an API that ignores or refuses the listing parameters: the plain listing is read and filtered here', async () => {
  await connectKey();
  await waitingClient();
  await sync(0.1);
  const { buy } = await readRec('acme');
  const did = ownerBuys(buy.domain, { status: 'active' });
  for (const p of buy.mailboxes) activate(mailbox(did, p.email));
  activate(mailbox('d_someoneelse', 'boss@someoneelse.com'));
  api.ignoreFilter = true;
  api.rejectParams = true;
  api.calls = [];
  const r = await sync(1);
  assert.equal(r.ok, true);
  assert.deepEqual(r.found.map((f) => f.domain), [buy.domain]);
  assert.deepEqual((await getInboxRecords('acme')).map((x) => x.email).sort(), buy.mailboxes.map((p) => p.email).sort());
  assert.ok(callsTo('GET', /^\/v1\/mailboxes$/).some((c) => !Object.keys(c.query).length), 'the plain listing was read');
  assert.equal(callsTo('GET', /mb_bosssomeoneelsecom/).length, 0, 'another domain\'s inbox is never touched');
});

test('the job runs only while a trial waits to buy or is being set up; the hub check carries `autobuy` only with a key', async () => {
  const { JOBS } = await import('@/lib/jobs');
  const job = JOBS.find((j) => j.name === 'autobuy');
  assert.equal(job.scope, 'global');
  const now = new Date('2026-10-05T15:07:00Z');
  assert.equal(await job.due({ now, clients: [{ id: 'x', state: 'sending' }, { id: 'aviance', state: 'awaiting_purchase' }] }), null);
  assert.equal(await job.due({ now, clients: [{ id: 'x', state: 'awaiting_purchase' }] }), '2026-10-05T11:00');
  assert.equal(await job.due({ now, clients: [{ id: 'x', state: 'setup_check', autobuyOpen: '1' }] }), '2026-10-05T11:00');
  await waitingClient();
  assert.equal((await job.run({ now: T0, deadline: Date.now() + 20000 })).skipped, 'not_set_up');
  assert.equal(api.calls.length, 0);

  const { POST } = await import('@/app/api/mc/onboard-calls/check/route');
  io.scanMailbox = async () => ({ ok: true, messages: [], uidState: {} });
  const without = await (await POST()).json();
  assert.ok(!('autobuy' in without));
  await ci.saveKey({ apiKey: KEY });
  await kv.del(K.onboardCheck());
  const withKey = await (await POST()).json();
  assert.equal(withKey.autobuy.ok, true);
  assert.equal(withKey.autobuy.skipped, undefined);
  const again = await (await POST()).json();
  assert.equal(again.autobuy.skipped, 'too soon', 'throttled to CHEAPINBOXES.checkEveryMinutes');
  const ran = await job.run({ now: new Date(T0.getTime() + 10 * 60e3), deadline: Date.now() + 20000 });
  assert.equal(ran.ok, true);
});

// ── 5. problems ──────────────────────────────────────────────────────────────

test('problems: the order failed, stuck past stuckHours, a login missing → one autobuy_problem each; fixed → cleared', async () => {
  await connectKey();
  await waitingClient('acme', 'acme.com');
  await waitingClient('beta', 'betaplumbing.com');
  await waitingClient('gamma', 'gammalaw.com');
  await sync(0.1);
  const a = (await readRec('acme')).buy;
  const b = (await readRec('beta')).buy;
  const g = (await readRec('gamma')).buy;
  const da = ownerBuys(a.domain, { created: at(1).toISOString() });
  ownerBuys(b.domain, { created: at(1).toISOString() });
  const dg = ownerBuys(g.domain, { status: 'active', created: at(1).toISOString() });
  const [g1, g2] = g.mailboxes.map((p) => mailbox(dg, p.email));
  await sync(1.1);

  // acme: the order failed.
  Object.assign(api.domains.get(da), { status: 'error', provisioning_error: 'The registry rejected the domain' });
  // gamma: both inboxes active, one without a login yet.
  activate(g1);
  activate(g2, { creds: false });
  await sync(2);
  const ab = (await hubClient('acme')).autobuy;
  assert.equal(ab.status, 'failed');
  assert.equal(ab.problem, `The CheapInboxes order for ${a.domain} failed`);
  const failed = alerts.filter((x) => x.key === 'autobuy_problem' && x.clientId === 'acme');
  assert.equal(failed.length, 1);
  assert.match(failed[0].body, /The registry rejected the domain/);
  assert.match(failed[0].body, /What to do: Open CheapInboxes → Orders/);
  assert.equal(fill('t', ALERTS.autobuy_problem.title, failed[0].vars), `Inbox setup: The CheapInboxes order for ${a.domain} failed`);
  assert.equal((await hubClient('acme')).row.simple.needsYou, true);
  assert.equal(alerts.filter((x) => x.key === 'autobuy_problem' && x.clientId === 'gamma').length, 0, 'a login a moment late is not a problem yet');

  // Three hours later: gamma's login is still missing; beta is not stuck yet.
  await sync(4);
  const creds = alerts.filter((x) => x.key === 'autobuy_problem' && x.clientId === 'gamma');
  assert.equal(creds.length, 1);
  assert.equal(creds[0].vars.what, `No login came back for ${g.mailboxes[1].email}`);
  assert.equal(alerts.filter((x) => x.key === 'autobuy_problem' && x.clientId === 'beta').length, 0);

  // 73 hours after the purchase: beta is stuck.
  await sync(74);
  const stuck = alerts.filter((x) => x.key === 'autobuy_problem' && x.clientId === 'beta');
  assert.equal(stuck.length, 1);
  assert.match(stuck[0].vars.what, new RegExp(`${b.domain.replace('.', '\\.')} is still not ready 73 hours after you bought it`));
  await sync(75);
  await sync(76);
  assert.equal(alerts.filter((x) => x.key === 'autobuy_problem').length, 3, 'each once');

  // gamma's login turns up: connected, the problem clears, setup starts.
  api.creds.set(g2, { email: g.mailboxes[1].email, password: 'pw-2', app_password: 'qrst uvwx yzab cdef', imap_host: 'imap.gmail.com', imap_port: 993, smtp_host: 'smtp.gmail.com', smtp_port: 587 });
  await sync(77);
  const gv = (await hubClient('gamma')).autobuy;
  assert.equal(gv.problem, null);
  assert.ok(['connecting', 'done'].includes(gv.status));
  assert.equal((await getInboxRecords('gamma')).length, 2);
});

// ── 6. the webhook ───────────────────────────────────────────────────────────

test('webhook signatures: the common header forms are accepted; anything else is not', () => {
  const secret = 'whsec_c2VjcmV0LWtleS1mb3ItdGVzdHMtMTIzNDU2';
  const body = '{"event":"mailbox.active","data":{"id":"mb_1"}}';
  const ok = (headers) => ci.verifySignature(body, new Headers(headers), secret);
  assert.ok(ok({ 'x-cheapinboxes-signature': hmacHex(secret, body) }), 'hex');
  assert.ok(ok({ 'x-webhook-signature': `sha256=${hmacHex(secret, body)}` }), 'sha256=hex');
  assert.ok(ok({ 'x-signature': hmacB64(secret, body) }), 'base64');
  assert.ok(ok({ 'x-cheapinboxes-signature': `t=1759672800,v1=${hmacHex(secret, `1759672800.${body}`)}` }), 't=…,v1=…');
  assert.ok(ok({ 'x-webhook-signature': hmacHex(secret, `1759672800.${body}`), 'x-webhook-timestamp': '1759672800' }), 'a separate timestamp header');
  const raw = Buffer.from('c2VjcmV0LWtleS1mb3ItdGVzdHMtMTIzNDU2', 'base64');
  assert.ok(ok({ 'webhook-id': 'msg_1', 'webhook-timestamp': '1759672800', 'webhook-signature': `v1,${crypto.createHmac('sha256', raw).update(`msg_1.1759672800.${body}`).digest('base64')}` }), 'v1,base64 with the whsec_ body as the key');
  assert.ok(!ok({}), 'no signature');
  assert.ok(!ok({ 'x-cheapinboxes-signature': hmacHex('whsec_other', body) }), 'wrong secret');
  assert.ok(!ci.verifySignature(`${body} `, new Headers({ 'x-cheapinboxes-signature': hmacHex(secret, body) }), secret), 'body changed');
  assert.ok(!ok({ 'x-other-signature': hmacHex(secret, body) }), 'unknown header');
  assert.ok(!ci.verifySignature(body, new Headers({ 'x-signature': hmacHex(secret, body) }), null), 'no stored secret');
});

test('webhook route: 200 at once; signed or not it only wakes a rate-limited sync; its body is never used or stored', async () => {
  await connectKey();
  await waitingClient();
  await sync(0.1);
  const secret = await storedSecret();
  // The body claims a purchase and hands over a login — none of it may count.
  const body = JSON.stringify({ event: 'mailbox.credentials_ready', data: { domain: 'evil-injected.com', client: 'acme', mailbox: { email: 'boss@evil-injected.com', password: 'hunter2hunter2xx' } } });

  const signed = await webhook(body, { 'x-cheapinboxes-signature': hmacHex(secret, body) });
  assert.equal(signed.status, 200);
  assert.deepEqual(signed.body, { received: true });
  assert.equal(globalThis.__after.length, 1, 'the sync runs after the answer');
  api.calls = [];
  const r = await globalThis.__after[0]();
  assert.equal(r.ok, true);
  assert.ok(callsTo('GET', /^\/v1\/domains$/).length === 1, 'truth comes from the API');
  assert.equal((await readRec('acme')).domain, undefined);
  assert.equal((await getInboxRecords('acme')).length, 0);
  const everything = JSON.stringify(await exportAll());
  assert.ok(!everything.includes('evil-injected') && !everything.includes('hunter2'), 'nothing from the body is stored');

  // Signed deliveries: one sync per WAKE.signedSec.
  assert.equal((await webhook(body, { 'x-cheapinboxes-signature': hmacHex(secret, body) })).status, 200);
  assert.equal(globalThis.__after.length, 1, 'rate-limited');
  assert.ok((await kv.ttl(K.cheapinboxesWake('signed'))) <= WAKE.signedSec);
  await kv.del(K.cheapinboxesWake('signed')); // the window passes

  // A delivery with a bad signature (or none) still only wakes a sync — slower, and it changes nothing by itself.
  const forged = await webhook(body, { 'x-cheapinboxes-signature': hmacHex('whsec_attacker', body) });
  assert.equal(forged.status, 200);
  assert.equal(globalThis.__after.length, 2);
  assert.ok((await kv.ttl(K.cheapinboxesWake('unsigned'))) > WAKE.signedSec);
  for (let i = 0; i < 5; i++) await webhook(body);
  assert.equal(globalThis.__after.length, 2, 'unsigned floods start no more syncs');
  await globalThis.__after[1]();
  assert.equal((await readRec('acme')).domain, undefined);
  assert.equal((await webhook(body, { 'x-cheapinboxes-signature': hmacHex(secret, body) })).status, 200);
  assert.equal(globalThis.__after.length, 3, 'a signed one is not held up by an unsigned flood');

  // A real purchase + a delivery → found by the sync the delivery woke.
  const { buy } = await readRec('acme');
  ownerBuys(buy.domain);
  await kv.del(K.cheapinboxesWake('signed'));
  const b2 = '{"event":"order.completed"}';
  await webhook(b2, { 'x-webhook-signature': `sha256=${hmacHex(secret, b2)}` });
  await globalThis.__after.at(-1)();
  assert.equal((await readRec('acme')).domain, buy.domain);
});

// ── 7. no key: the manual path ───────────────────────────────────────────────

test('without a key nothing changes: no calls, the old buy to-do, pasting the logins works as before', async () => {
  await waitingClient();
  await kv.hset(K.shopping('acme'), { sentAt: T0.toISOString(), chosenDomain: 'getacme.com', total: 16 });
  const r = await syncAutobuy({ force: true });
  assert.equal(r.skipped, 'not_set_up');
  const w = await webhook('{}', {});
  assert.equal(w.status, 200);
  for (const fn of globalThis.__after) await fn();
  assert.equal(api.calls.length, 0, 'CheapInboxes is never called');
  const detail = await hubClient('acme', { now: at(1) });
  assert.equal(detail.autobuy.status, 'not_set_up');
  assert.equal(detail.row.simple.label, 'Setting up their emails — your turn to buy the domain');
  assert.equal(detail.row.todo.find((t) => t.id === 'buy:acme').text, 'Buy getacme.com and 2 inboxes, then paste the logins');
  const a = await action('acme', { action: 'recheck' });
  assert.equal(a.status, 409);
  assert.match(a.body.error, /isn't connected/);

  const out = await submitPurchase('acme', { domain: 'getacme.com', autoRenewOff: true, inboxes: [{ email: 'jordan@getacme.com', password: 'abcdefghijklmnop', displayName: 'Jordan Test' }, { email: 'jtest@getacme.com', password: 'bcdefghijklmnopq', displayName: 'Jordan Test' }] }, { now: at(2) });
  assert.equal(out.ok, true);
  assert.equal((await getClient('acme')).state, 'setup_check');
  const recs = await getInboxRecords('acme');
  assert.equal(recs.length, 2);
  assert.ok(recs.every((x) => x.smtpHost === 'smtp.gmail.com' && Number(x.smtpPort) === 465 && !x.loginPasswordEnc && !x.source));
  assert.equal(decrypt(recs.find((x) => x.email === 'jordan@getacme.com').passwordEnc), 'abcdefghijklmnop');
  assert.equal((await kv.hgetall(K.domain('acme'))).autoRenew, 'false');
});

// ── 8. the guard ─────────────────────────────────────────────────────────────

const FORBIDDEN = [
  ['POST', '/orders/checkout'], ['POST', '/orders/quote'], ['GET', '/orders'], ['GET', '/orders/ord_1'], ['PUT', '/orders/ord_1/payment-method'],
  ['POST', '/billing/pay-now'], ['POST', '/billing/cancel'], ['POST', '/billing/cancel/undo'], ['DELETE', '/billing/payment-methods/pm_1'],
  ['POST', '/billing/payment-methods/pm_1/default'], ['POST', '/mailboxes/mb_1/cancel'], ['POST', '/domains/d_1/transfer-out'],
  ['PATCH', '/domains/d_1'], ['POST', '/domains/d_1/mailboxes'], ['PATCH', '/org'], ['POST', '/integrations'], ['POST', '/domains/d_1/dns-records'],
  ['PATCH', '/domains/d_1/dmarc'], ['POST', '/webhooks/wh_1/test'], ['GET', '/domains/../orders/checkout'], ['PATCH', '/domains/../forwarding'],
  ['POST', '/discovery/domains/search/../../../orders/checkout'], ['GET', '/mailboxes/mb_1/totp'], ['PATCH', '/domains/d_1/forwarding/../../../orders/ord_1'],
];

test('the guard: an order, a payment or a cancellation can never be sent — refused before any request', async () => {
  let fetched = 0;
  io.fetchJson = async () => { fetched++; return reply(200, {}); };
  for (const [method, p] of FORBIDDEN) {
    assert.equal(ci.isAllowedCall(method, p), false, `${method} ${p}`);
    await assert.rejects(ci.ciCall(method, p, { key: KEY }), (err) => err.code === 'forbidden', `${method} ${p}`);
  }
  assert.equal(fetched, 0, 'nothing left the machine');
  for (const [method, p] of [['GET', '/org'], ['GET', '/billing/payment-methods'], ['POST', '/webhooks'], ['GET', '/webhooks'], ['DELETE', '/webhooks/wh_1'],
    ['POST', '/discovery/domains/search'], ['GET', '/domains'], ['GET', '/domains/d_1'], ['PATCH', '/domains/d_1/forwarding'], ['GET', '/mailboxes'],
    ['GET', '/mailboxes/mb_1'], ['GET', '/mailboxes/mb_1/credentials']]) assert.equal(ci.isAllowedCall(method, p), true, `${method} ${p}`);
});

test('the guard in the code: only ext/cheapinboxes.js talks to CheapInboxes, and every path it names is allowed', () => {
  const files = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else if (/\.(m?js|jsx)$/.test(e.name)) files.push(f); } };
  walk(path.join(ROOT, 'src'));
  const client = path.join(ROOT, 'src/lib/ext/cheapinboxes.js');
  for (const f of files) {
    if (f === client) continue;
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!/https?:\/\/api\.cheapinboxes\.com/.test(text), `${path.relative(ROOT, f)} must not call CheapInboxes itself`);
    assert.ok(!/\bciCall\s*\(/.test(text), `${path.relative(ROOT, f)} must go through the named functions`);
  }
  const src = fs.readFileSync(client, 'utf8');
  const named = [];
  for (const m of src.matchAll(/ciCall\(\s*'(GET|POST|PATCH|DELETE|PUT)'\s*,\s*[`'"]([^`'"]+)[`'"]/g)) named.push([m[1], m[2]]);
  for (const m of src.matchAll(/getOk\(\s*'([^']+)'/g)) named.push(['GET', m[1]]);
  for (const m of src.matchAll(/listAll\(\s*'([^']+)'/g)) named.push(['GET', m[1]]);
  assert.ok(named.length >= 10, `found ${named.length} calls`);
  for (const [method, p] of named) {
    const concrete = p.replace(/\$\{[^}]+\}/g, 'x_1');
    assert.equal(ci.isAllowedCall(method, concrete), true, `${method} ${p}`);
  }
  assert.ok(!/\/orders|\/billing\/(pay-now|cancel)|\/cancel\b|checkout|\/quote/.test(src.replace(/^\s*(\/\/|\*).*$/gm, '')), 'no order / payment / cancel path appears in the code');
});

test('every call made in this file was an allowed one', () => {
  assert.ok(ALL_CALLS.length > 50, `${ALL_CALLS.length} calls recorded`);
  const bad = ALL_CALLS.filter((c) => !ci.isAllowedCall(c.method, c.path.replace(/^\/v1/, '')));
  assert.deepEqual(bad.map((c) => `${c.method} ${c.path}`), []);
  assert.ok(!ALL_CALLS.some((c) => /orders|pay-now|cancel|checkout|quote/.test(c.path)));
});

test('middleware: the webhook is public, the settings and actions need a sign-in', async () => {
  process.env.ADMIN_SECRET = 'admin-secret-for-tests';
  const { middleware } = await import('@/middleware');
  const req = (p, method = 'POST') => { const url = `https://email-distributor.vercel.app${p}`; return { url, method, nextUrl: new URL(url), headers: new Headers(), cookies: { get: () => undefined } }; };
  const through = (res) => res.headers.get('x-middleware-next') === '1';
  assert.ok(through(await middleware(req('/api/webhooks/cheapinboxes'))));
  for (const p of ['/api/mc/cheapinboxes', '/api/mc/clients/acme/autobuy']) {
    const res = await middleware(req(p));
    assert.ok(!through(res), p);
    assert.equal(res.status, 401, p);
  }
});

test('a CheapInboxes domain passes DMARC with their report address (the machine may not edit it)', async () => {
  const { evalDmarc } = await import('@/lib/systems/setupcheck');
  const rec = [['v=DMARC1; p=none; rua=mailto:reports@cheapinboxes-dmarc.com']];
  assert.equal(evalDmarc(rec, 'acmeoutreach.com').status, 'fail', 'our own domains still need our report address');
  assert.equal(evalDmarc(rec, 'acmeoutreach.com', null, { anyRua: true }).status, 'pass');
  assert.equal(evalDmarc([['v=DMARC1; rua=mailto:x@y.com']], 'acmeoutreach.com', null, { anyRua: true }).status, 'fail', 'a policy is still required');
});
