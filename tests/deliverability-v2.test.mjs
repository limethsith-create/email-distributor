// Deliverability v2 — warm-up network, placement testing, blacklists, bounce
// limits, the hub's deliverability view. Fake KV; SMTP / IMAP / fetch / DNS
// are stubbed (no network).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { __reset, kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { createClient, getClient } from '@/lib/db/client';
import { saveInbox, patchInbox } from '@/lib/db/inboxes';
import { initCounters } from '@/lib/db/counters';
import { setOverride, HARD_WARMUP_CAP, DEFAULTS } from '@/lib/config';
import { PROVIDERS, HELPER_PROVIDERS, providerForAddress, familyOf, providerLabel } from '@/lib/smtp-providers';
import {
  getPool, planPairs, pairKey, inboxQuota, saveHelper, runWarmupSend, runWarmupRead, makeMarker, verifyMarker,
  isWarmupMessage, resolveFolders, poolStatus, readPoolSummary, statsFor, MARKER_HEADER,
} from '@/lib/systems/warmup';
import { renderWarmup, encodeWarmMeta, decodeWarmMeta, composeReply } from '@/lib/templates/warmup';
import {
  parseMailTester, parseDkimValidator, pickTool, passes, dueInboxes, runPlacement, spamTestGate, placementHistory,
  latestSpamTests, TOOLS, sampleCompany,
} from '@/lib/systems/placement';
import { readinessGate } from '@/lib/systems/readiness';
import { growthFor } from '@/lib/systems/growth';
import { classifyAnswer, zoneSpec, summarize, statusOf, checkDomainBlacklists, planQueries } from '@/lib/systems/blacklists';
import { runBlacklistCheck } from '@/lib/systems/authguard';
import { io } from '@/lib/systems/intake-io';
import { runEmergency, bouncePauseDue } from '@/lib/systems/emergency';
import { computeCap, runRamp } from '@/lib/systems/ramp';
import { setDeps, resetDeps } from '@/lib/systems/stagec-common';
import { deliverabilityView } from '@/lib/systems/deliverability';
import { JOBS } from '@/lib/joblist/stage-b';

process.env.ENC_KEY = crypto.randomBytes(32).toString('base64');
delete process.env.OWNER_INBOX;
delete process.env.MAILTESTER_USERNAME;

const NOW = new Date('2026-10-06T15:00:00Z'); // Tuesday 11:00 ET
const DAY = '2026-10-06';
const alertLog = async () => (await kv.lrange('system:alerts:log', 0, -1));
const alertKeys = async () => (await alertLog()).map((a) => a.key);
const seqRng = (vals) => { let i = 0; return () => vals[i++ % vals.length]; };

beforeEach(() => { resetDeps(); });

// ── 1. Provider presets ──────────────────────────────────────────────────────

test('provider presets: free helpers that work in 2026, unsupported ones marked, folders per provider', async () => {
  for (const p of ['google', 'yahoo', 'aol', 'icloud', 'gmx', 'gmxnet', 'webde', 'yandex']) assert.ok(HELPER_PROVIDERS.includes(p), `${p} is a helper provider`);
  for (const p of ['outlook', 'zoho', 'mailcom']) {
    assert.ok(!HELPER_PROVIDERS.includes(p), `${p} is not a free helper`);
    assert.match(PROVIDERS[p].helperNote, /Not/);
  }
  assert.match(PROVIDERS.outlook.helperNote, /OAuth2/);
  // Hosts, ports, TLS mode and folder names.
  assert.deepEqual(PROVIDERS.icloud.smtp, { host: 'smtp.mail.me.com', port: 587, secure: false });
  assert.equal(PROVIDERS.icloud.imap.host, 'imap.mail.me.com');
  assert.equal(PROVIDERS.yahoo.spamFolder, 'Bulk');
  assert.equal(PROVIDERS.gmxnet.spamFolder, 'Spamverdacht');
  assert.equal(PROVIDERS.yandex.smtp.port, 465);
  for (const [id, p] of Object.entries(PROVIDERS)) {
    assert.ok(p.smtp.host && p.imap.host && p.spamFolder, `${id} has hosts + spam folder`);
    assert.equal(p.smtp.secure, p.smtp.port === 465, `${id}: 465 = TLS, 587 = STARTTLS`);
    if (p.helper) assert.ok(p.setup.length >= 2, `${id} lists its one-time setup steps`);
  }
  // Address → preset, filter family, label.
  assert.equal(providerForAddress('sam@yahoo.com'), 'yahoo');
  assert.equal(providerForAddress('sam@gmx.net'), 'gmxnet');
  assert.equal(providerForAddress('sam@example.org'), null);
  assert.equal(familyOf('aol'), familyOf('yahoo'));
  assert.equal(familyOf('webde'), familyOf('gmx'));
  assert.equal(providerLabel('google', 'x@gmail.com'), 'gmail');
  assert.equal(providerLabel('google', 'x@acme-team.com'), 'google-workspace');

  // saveHelper picks the preset from the address and iCloud's IMAP login name.
  __reset();
  const icloud = await saveHelper({ email: 'Pat.Lee@icloud.com', password: 'abcd efgh ijkl mnop' });
  assert.equal(icloud.provider, 'icloud');
  assert.equal(icloud.imapUser, 'pat.lee');
  assert.equal(icloud.smtpPort, 587);
  const yahoo = await saveHelper({ email: 'h@yahoo.com', password: 'x', provider: 'yahoo' });
  assert.equal(yahoo.imapHost, 'imap.mail.yahoo.com');
});

test('/api/mc/warmup refuses a helper whose provider cannot log in with a password; Retry puts a member back', async () => {
  __reset();
  const { POST } = await import('@/app/api/mc/warmup/route');
  const call = (body) => POST(new Request('http://x/api/mc/warmup', { method: 'POST', body: JSON.stringify(body) }));
  const bad = await call({ action: 'addHelper', email: 'h@outlook.com', password: 'pw', provider: 'outlook' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /OAuth2/);
  // addHelper tests the logins first (docs/WARMUP-HUB.md): stubbed, no network.
  const { smtpVerify, imapLogin } = io;
  io.smtpVerify = async () => ({ success: true });
  io.imapLogin = async () => ({ ok: true, spamFolderExists: true });
  const ok = await call({ action: 'addHelper', email: 'h@aol.com', password: 'pw' });
  Object.assign(io, { smtpVerify, imapLogin });
  assert.equal((await ok.json()).provider, 'aol');
  await kv.hset(K.warmupHelper('h@aol.com'), { health: 'auth_failed' });
  await call({ action: 'retryMember', clientId: '_helper', email: 'h@aol.com' });
  assert.equal((await kv.hgetall(K.warmupHelper('h@aol.com'))).health, 'new');
});

// ── 2. Pool membership + pairing ─────────────────────────────────────────────

async function circle({ avianceHealth = null } = {}) {
  __reset();
  await createClient('acme', { state: 'warming', name: 'Acme' });
  await saveInbox('acme', { email: 'ann@acme-trial.com', password: 'pw', provider: 'google', displayName: 'Ann Lee' });
  await patchInbox('acme', 'ann@acme-trial.com', { warmupStartedAt: new Date(NOW.getTime() - 9 * 864e5).toISOString() });
  await createClient('bolt', { state: 'sending', name: 'Bolt' });
  await saveInbox('bolt', { email: 'bo@bolt-team.com', password: 'pw', provider: 'google', displayName: 'Bo Chan', dailyCap: '25' });
  await patchInbox('bolt', 'bo@bolt-team.com', { warmupStartedAt: new Date(NOW.getTime() - 30 * 864e5).toISOString() });
  await createClient('aviance', { state: 'sending', name: 'Aviance' });
  await saveInbox('aviance', { email: 'me@getaviance.site', password: 'pw', provider: 'google', displayName: 'Lim S' });
  if (avianceHealth) await patchInbox('aviance', 'me@getaviance.site', { warmupHealth: avianceHealth });
  await saveInbox('aviance', { email: 'off@getaviance.site', password: 'pw', provider: 'google' });
  await patchInbox('aviance', 'off@getaviance.site', { warmupEnabled: '0' });
  await saveHelper({ email: 'h1@gmail.com', password: 'pw', displayName: 'Hal One' });
  await saveHelper({ email: 'h2@yahoo.com', password: 'pw', displayName: 'Hana Two' });
  await saveHelper({ email: 'h3@aol.com', password: 'pw', displayName: 'Hugo Three' });
  await saveHelper({ email: 'h4@icloud.com', password: 'pw', displayName: 'Hee Four' });
}

test('pool: every trial inbox (warming → converted) + the aviance inboxes with WARMUP.includeAviance + helpers', async () => {
  await circle();
  let pool = await getPool({ now: NOW });
  const by = Object.fromEntries(pool.map((m) => [m.email, m]));
  assert.ok(by['ann@acme-trial.com'] && !by['ann@acme-trial.com'].isAviance);
  assert.ok(by['bo@bolt-team.com']);
  assert.ok(by['me@getaviance.site']?.isAviance, 'the owner’s own inbox joins the circle by default');
  assert.ok(!by['off@getaviance.site'], 'warmupEnabled 0 keeps an inbox out');
  assert.equal(pool.filter((m) => m.isHelper).length, 4);
  assert.equal(by['h3@aol.com'].family, 'yahoo');
  // The pool set is kept in step.
  assert.ok((await kv.smembers(K.warmupPool())).includes('aviance|me@getaviance.site'));
  // Flag off → out (and removed from the pool set).
  await setOverride(null, 'WARMUP.includeAviance', false);
  pool = await getPool({ now: NOW });
  assert.ok(!pool.some((m) => m.isAviance));
  assert.ok(!(await kv.smembers(K.warmupPool())).includes('aviance|me@getaviance.site'));
  // A login failure takes an aviance inbox out until Retry.
  await circle({ avianceHealth: 'auth_failed' });
  assert.ok(!(await getPool({ now: NOW })).some((m) => m.isAviance));
});

test('quota: ramp table while warming; ~1/3 of the cold cap once sending; minus an external network; never over 15', async () => {
  const table = DEFAULTS.WARMUP.quota;
  assert.equal(inboxQuota({ days: 2, table }), 3);
  assert.equal(inboxQuota({ days: 10, table, sending: false, dailyCap: 25, share: 0.33 }), 15);
  assert.equal(inboxQuota({ days: 30, table, sending: true, dailyCap: 25, share: 0.33 }), 9); // ceil(25 × 0.33) beats the 15+ row (8)
  assert.equal(inboxQuota({ days: 30, table, sending: true, dailyCap: 8, share: 0.33 }), 8);  // never under the table
  assert.equal(inboxQuota({ days: 30, table, sending: true, dailyCap: 25, share: 1 }), HARD_WARMUP_CAP);
  assert.equal(inboxQuota({ days: 10, table, external: 10 }), 5);
  assert.equal(inboxQuota({ days: 0, table, sending: true, dailyCap: 25, share: 0.33 }), 0);
  await circle();
  const bo = (await getPool({ now: NOW })).find((m) => m.email === 'bo@bolt-team.com');
  assert.equal(bo.quota, 9);
});

test('pairing: trial inboxes first, then aviance, then helpers; another mail family first', () => {
  const m = (email, provider, clientId, extra = {}) => ({ email, domain: email.split('@')[1], provider, family: familyOf(provider), clientId, quota: 8, isHelper: clientId === '_helper', isAviance: clientId === 'aviance', ...extra });
  const pool = [
    m('h1@gmail.com', 'google', '_helper'),
    m('h2@yahoo.com', 'yahoo', '_helper'),
    m('h3@aol.com', 'aol', '_helper'),
    m('me@getaviance.site', 'google', 'aviance'),
    m('ann@acme-trial.com', 'google', 'acme'),
  ];
  const plan = planPairs(pool, { n: 5, rng: () => 0.5 });
  assert.equal(plan[0].from.email, 'ann@acme-trial.com');
  assert.equal(plan[1].from.email, 'me@getaviance.site');
  assert.ok(plan.slice(2).every((p) => p.from.isHelper));
  // The trial inbox (Google) goes to another family (Yahoo/AOL), never a Gmail helper first.
  assert.notEqual(plan[0].to.family, 'google');
  // Yahoo and AOL are one family: an AOL sender prefers Google over Yahoo.
  const aol = planPairs(pool.filter((x) => x.email !== 'ann@acme-trial.com' && x.email !== 'me@getaviance.site'), { n: 3, rng: () => 0.5, sent: { 'h1@gmail.com': 8, 'h2@yahoo.com': 8 } });
  assert.equal(aol[0].from.email, 'h3@aol.com');
  assert.equal(aol[0].to.email, 'h1@gmail.com');
  const keys = plan.map((p) => pairKey(p.from.email, p.to.email));
  assert.equal(new Set(keys).size, keys.length);
});

test('warm-up send: aviance takes part, trial counters only for trial inboxes, pool summary written', async () => {
  await circle();
  const sent = [];
  const deps = { rng: () => 0.5, send: async (account, mail) => { sent.push({ from: account.email, ...mail }); return { success: true, messageId: `<${sent.length}@x>` }; } };
  await setOverride(null, 'BUILD.warmupPairsPerTick', 8);
  const r = await runWarmupSend({ now: NOW, deadline: Date.now() + 20_000, deps });
  assert.ok(r.sent >= 3);
  assert.ok(sent.some((s) => s.from === 'me@getaviance.site'), 'aviance sends warm-up');
  assert.ok(sent.every((s) => isWarmupMessage(s.headers)));
  // New mails carry their build metadata (for quoting in replies).
  const meta = decodeWarmMeta(verifyMarker(sent[0].headers[MARKER_HEADER]).tag);
  assert.equal(meta.kind, 'original');
  assert.equal(renderWarmup(meta, { toName: 'x', fromName: 'y' }).subject, sent[0].subject);
  // Counters: trial clients yes, aviance no (its stats still flow into warmup:stats).
  assert.ok(!(await kv.hgetall(K.countersTotal('aviance'))));
  assert.equal((await statsFor('me@getaviance.site', DAY)).sent, 1);
  const s = await readPoolSummary();
  assert.equal(s.pool, 7); // 2 trial + 1 aviance + 4 helpers
  assert.equal(s.helpers, 4);
  assert.equal(s.aviance, 1);
  assert.equal(s.todayPairs, r.sent + r.failed);
  assert.equal(s.providers['google-workspace'], 3);
  assert.equal(s.providers.gmail, 1);
  const status = await poolStatus({ now: NOW });
  assert.ok(status.presets.find((p) => p.id === 'outlook' && !p.helper));
  assert.equal(status.aviance.included, true);
});

// ── 3. Warm-up read: preset folders, quoted replies, thread depth ────────────

function fakeImap(boxes, log) {
  return async (account) => {
    const yahoo = /yahoo|aol/.test(account.email);
    const spam = yahoo ? 'Bulk' : '[Gmail]/Spam';
    const archive = yahoo ? 'Archive' : '[Gmail]/All Mail';
    const b = (boxes[account.email] ||= { INBOX: [], [spam]: [], [archive]: [] });
    let cur = null;
    return {
      async connect() { log.push(['connect', account.email, account.imapUser || account.email]); },
      // Yahoo does not flag its folders (no SPECIAL-USE): the preset names are needed.
      async list() { return yahoo ? [{ path: 'INBOX' }, { path: 'Bulk' }, { path: 'Archive' }] : [{ path: 'INBOX' }, { path: '[Gmail]/Spam', specialUse: '\\Junk' }, { path: '[Gmail]/All Mail', specialUse: '\\All' }]; },
      async getMailboxLock(p) { cur = p; b[p] ||= []; return { release() {} }; },
      async search(q) { const want = String(q.header['x-aviance-warm'] || '').toLowerCase(); return b[cur].filter((m) => m.headers.toLowerCase().includes(want)).map((m) => m.uid); },
      async *fetch(uids) { for (const m of [...b[cur]]) if (uids.includes(m.uid)) yield m; },
      async messageFlagsAdd() {},
      async messageMove(uid, dest) { const i = b[cur].findIndex((x) => x.uid === uid); const [m] = b[cur].splice(i, 1); b[dest] ||= []; b[dest].push({ ...m, uid: uid + 1000 }); log.push(['move', account.email, cur, dest]); },
      async logout() {},
    };
  };
}
const warmMsg = (uid, from, marker, subject = 'About the budget review') => ({
  uid, envelope: { messageId: `<m${uid}@x>`, from: [{ address: from }], subject, date: new Date('2026-10-06T13:00:00Z') },
  headers: `X-Aviance-Warm: ${marker}\r\nMessage-ID: <m${uid}@x>\r\n`,
});

test('warm-up read: Yahoo "Bulk" found without special-use flags; replies quote the original; threads end at the max depth', async () => {
  await circle();
  await setOverride(null, 'WARMUP.includeAviance', false);
  const orig = { subjectIndex: 17, bodyIndex: 42, closerIndex: 3 };
  const log = [];
  const boxes = {
    'ann@acme-trial.com': { INBOX: [warmMsg(1, 'h2@yahoo.com', makeMarker('w', encodeWarmMeta(orig))), warmMsg(2, 'h1@gmail.com', makeMarker('w', 'r3d4'))], '[Gmail]/Spam': [], '[Gmail]/All Mail': [] },
    'h2@yahoo.com': { INBOX: [], Bulk: [warmMsg(3, 'ann@acme-trial.com', makeMarker())], Archive: [] },
  };
  const replies = [];
  const deps = { rng: () => 0.1, imap: fakeImap(boxes, log), send: async (account, mail) => { replies.push({ from: account.email, ...mail }); return { success: true }; } };
  await setOverride(null, 'BUILD.warmupReadPerRun', 8);
  await runWarmupRead({ now: NOW, deadline: Date.now() + 20_000, deps });
  // Yahoo's Bulk folder: rescued to INBOX, counted as spam for the sender.
  assert.ok(log.some((l) => l[0] === 'move' && l[1] === 'h2@yahoo.com' && l[2] === 'Bulk' && l[3] === 'INBOX'));
  assert.equal((await statsFor('ann@acme-trial.com', DAY)).spam, 1);
  // Ann replies to the original with the quote; the depth-4 reply gets no answer.
  const fromAnn = replies.filter((r) => r.from === 'ann@acme-trial.com');
  assert.equal(fromAnn.length, 1);
  const quoted = renderWarmup(orig, { toName: 'Ann Lee', fromName: 'Hana Two' }).text;
  assert.match(fromAnn[0].text, /Hana Two <h2@yahoo\.com> wrote:/);
  assert.ok(fromAnn[0].text.includes(`> ${quoted.split('\n')[0]}`));
  assert.equal(fromAnn[0].to, 'h2@yahoo.com');
  assert.equal(decodeWarmMeta(verifyMarker(fromAnn[0].headers[MARKER_HEADER]).tag).depth, 1);
  // composeReply deeper in a thread uses the short follow-up lines.
  assert.ok(composeReply(seqRng([0]), { depth: 3 }).text.length < 40);
});

// ── 4. Placement: tool parsing, schedule, run, gate ──────────────────────────

const MT_GOOD = {
  status: true, title: 'Wow! Perfect, you can send', mark: -0.5, displayedMark: '9.5/10', maxMark: 10,
  signature: { mark: 0, subtests: { spf: { status: 'pass', mark: 0 }, dkim: { status: 'pass', mark: 0 }, dmarc: { status: 'pass', mark: 0 } } },
  spamAssassin: { score: 0.5, mark: -0.5, rules: { HTML_MESSAGE: { code: 'HTML_MESSAGE', score: 0.001, description: 'HTML included in message' }, MISSING_MID: { code: 'MISSING_MID', score: 0.5, description: 'Missing Message-Id: header' } } },
  blacklists: { mark: 0, blacklists: { 'Spamcop': { name: 'SpamCop', statusCode: 0 }, 'Barracuda': { name: 'Barracuda', statusCode: 0 } } },
  body: { mark: 0, subtests: { listUnsubscribe: { mark: 0 } } },
  links: { mark: 0 },
};
const MT_BAD = {
  ...MT_GOOD, mark: -3.1, displayedMark: '6.9/10',
  signature: { mark: -2, subtests: { spf: { status: 'pass', mark: 0 }, dkim: { status: 'fail', mark: -1, statusClass: 'failure' }, dmarc: { status: 'fail', mark: -1 } } },
  blacklists: { mark: -1, blacklists: { 'Spamcop': { name: 'SpamCop', statusCode: 2 } } },
};

test('mail-tester JSON: score from displayedMark, the tool’s reasons, "mail not found" = still waiting', () => {
  const good = parseMailTester(MT_GOOD);
  assert.deepEqual([good.ready, good.score], [true, 9.5]);
  assert.ok(good.detail.includes('SPF pass') && good.detail.includes('DKIM pass'));
  assert.ok(good.detail.some((d) => /MISSING_MID \+0\.5/.test(d)));
  const bad = parseMailTester(MT_BAD);
  assert.equal(bad.score, 6.9);
  assert.ok(bad.detail.includes('DKIM fail'));
  assert.ok(bad.detail.some((d) => /Blacklisted on SpamCop/.test(d)));
  assert.equal(bad.detail.indexOf('DKIM fail') < bad.detail.indexOf('SPF pass'), true, 'problems listed first');
  const waiting = parseMailTester({ status: false, title: 'Mail not found. Please wait a few seconds and try again.', mark: 0 });
  assert.deepEqual([waiting.ready, waiting.waiting], [false, true]);
  assert.equal(parseMailTester({ status: true, title: 'x' }).ready, false, 'no score → never a guessed number');
  assert.equal(passes(good, { minScore: 8 }), true);
  assert.equal(passes(bad, { minScore: 8 }), false);
  // Ids: account form and the free form.
  assert.match(TOOLS['mail-tester'].newId({ username: 'aviance' }), /^aviance-[0-9a-z]{16}$/);
  assert.match(TOOLS['mail-tester'].newId(), /^test-[0-9a-z]{9}$/);
  assert.equal(TOOLS['mail-tester'].address('test-abc'), 'test-abc@srv1.mail-tester.com');
});

const DV = {
  sa: '<pre>SpamAssassin Score: 1.2\nMessage is NOT marked as spam\nPoints breakdown:\n 1.0 FREEMAIL_FORGED_REPLYTO Freemail in Reply-To\n 0.2 HTML_MESSAGE HTML included\n-0.1 DKIM_VALID Message has a valid DKIM</pre>',
  dkim: '<pre>DKIM Information:\nValidating Signature\nresult = pass</pre>',
  spf: '<pre>SPF Information:\nResult code: pass</pre>',
};

test('dkimvalidator pages: SpamAssassin points, DKIM + SPF verdicts, rule reasons; "not received" = waiting', () => {
  const v = parseDkimValidator(DV);
  assert.deepEqual([v.ready, v.spamAssassin, v.dkim, v.spf, v.markedSpam], [true, 1.2, 'pass', 'pass', false]);
  assert.ok(v.detail.some((d) => /FREEMAIL_FORGED_REPLYTO \+1/.test(d)));
  assert.equal(passes(v, { maxSpamAssassin: 2 }), true);
  assert.equal(passes(parseDkimValidator({ ...DV, dkim: 'This message does not contain a DKIM Signature' }), { maxSpamAssassin: 2 }), false);
  assert.equal(passes(parseDkimValidator({ ...DV, sa: DV.sa.replace('1.2', '3.4') }), { maxSpamAssassin: 2 }), false);
  assert.deepEqual(parseDkimValidator({ sa: "I haven't received an email recently to av123" }), { ready: false, waiting: true });
  assert.match(TOOLS.dkimvalidator.newId(), /^av[0-9a-z]{18}$/);
});

test('tool choice: dkimvalidator by default; mail-tester with an account or the owner’s opt-in', () => {
  assert.equal(pickTool({ tool: 'auto' }, {}).tool, 'dkimvalidator');
  assert.deepEqual(pickTool({ tool: 'auto' }, { MAILTESTER_USERNAME: 'aviance' }), { tool: 'mail-tester', username: 'aviance' });
  assert.equal(pickTool({ tool: 'auto', mailTesterFree: true }, {}).tool, 'mail-tester');
  assert.equal(pickTool({ tool: 'dkimvalidator' }, { MAILTESTER_USERNAME: 'x' }).tool, 'dkimvalidator');
});

test('schedule: Day −3 while warming (daily until it passes), Day 1, then weekly; one test per inbox per day', () => {
  const s = { daysBeforeDay1: 3, everyDays: 7, maxAgeDays: 10 };
  const base = { day: '2026-10-06', day1Date: '2026-10-09', inboxes: ['a@x.com', 'b@x.com'], s };
  assert.deepEqual(dueInboxes({ ...base, state: 'warming', td: -4, latest: {} }), []);
  assert.deepEqual(dueInboxes({ ...base, state: 'warming', td: -3, latest: {} }), ['a@x.com', 'b@x.com']);
  const passed = { day: '2026-10-05', pass: true };
  const failed = { day: '2026-10-05', pass: false };
  assert.deepEqual(dueInboxes({ ...base, state: 'warming', td: -2, latest: { 'a@x.com': passed, 'b@x.com': failed } }), ['b@x.com']);
  assert.deepEqual(dueInboxes({ ...base, state: 'warming', td: -2, latest: { 'a@x.com': { day: '2026-10-06', pass: false } } }), ['b@x.com'], 'today already tested');
  // ready on Day 1 (before the first send) and sending: the Day 1 test once.
  const d1 = { ...base, day: '2026-10-09', td: 1 };
  assert.deepEqual(dueInboxes({ ...d1, state: 'ready', latest: { 'a@x.com': passed, 'b@x.com': passed } }), ['a@x.com', 'b@x.com']);
  assert.deepEqual(dueInboxes({ ...d1, state: 'ready', td: 0, latest: {} }), []);
  const onD1 = { day: '2026-10-09', pass: true };
  assert.deepEqual(dueInboxes({ ...d1, day: '2026-10-12', td: 4, state: 'sending', latest: { 'a@x.com': onD1, 'b@x.com': onD1 } }), []);
  assert.deepEqual(dueInboxes({ ...d1, day: '2026-10-16', td: 8, state: 'sending', latest: { 'a@x.com': onD1, 'b@x.com': { day: '2026-10-12', pass: false } } }), ['a@x.com', 'b@x.com']);
  assert.deepEqual(dueInboxes({ ...base, state: 'deciding', td: 31, latest: {} }), []);
});

async function spamClient({ dailyLimit = null } = {}) {
  __reset();
  await createClient('acme', { state: 'warming', name: 'Acme IT' });
  await kv.hset(K.trial('acme'), { signedDay: '2026-09-25', day1Date: '2026-10-09' }); // NOW = Day −3
  await kv.hset(K.profile('acme'), { senderName: 'Jane Doe', postalAddress: '1 Main St, Dover, DE 19901', cities: 'Dover, DE' });
  await kv.hset(K.sequence('acme'), { variantA: JSON.stringify({ footer: '{SenderName}\n{postalAddress}\n\nNot the right fit? Just reply STOP and I will not email you again.', touches: [{ touch: 'd0', thread: 'new', subject: 'Idea for {Company}', body: 'Hi {FirstName},\n\nA short note for {Company}. Worth a chat?' }] }) });
  for (const e of ['jane@acme-team.com', 'j.doe@acme-team.com']) await saveInbox('acme', { email: e, password: 'pw', displayName: 'Jane Doe' });
  if (dailyLimit) await setOverride(null, 'PLACEMENT.dailyLimit', dailyLimit);
  return getClient('acme');
}

test('spam test run: the client’s own Day 0 copy to the tool, result fetched after a wait, stored newest-first, low score alerts with reasons', async () => {
  let client = await spamClient();
  const mails = [];
  const verdicts = {};
  const deps = {
    send: async (account, mail) => { mails.push({ from: account.email, ...mail }); return { success: true }; },
    fetchText: async (url) => {
      const [, page, id] = /cgi-bin\/(sa|dkim|spf)\.pl\?email=(\w+)/.exec(url);
      if (!verdicts[id]) return `I haven't received an email recently to ${id}`;
      return verdicts[id][page];
    },
  };
  let r = await runPlacement({ client, now: NOW, deps });
  assert.equal(r.phase, 'waiting');
  assert.equal(mails.length, 2);
  assert.match(mails[0].to, /^av[0-9a-z]{18}@dkimvalidator\.com$/);
  assert.equal(mails[0].subject, 'Idea for Northfield Partners', 'the real copy, for a made-up company (no real prospect goes to the tool)');
  assert.match(mails[0].text, /reply STOP/);
  assert.equal(mails[0].noTrack, true);
  assert.equal(Number(await kv.get(K.placementQuota('dkimvalidator', DAY))), 2);
  // Too early to check.
  assert.equal((await runPlacement({ client, now: new Date(NOW.getTime() + 60e3), deps })).phase, 'waiting');
  // The tool has the first mail only.
  const ids = mails.map((m) => m.to.split('@')[0]);
  verdicts[ids[0]] = DV;
  const t1 = new Date(NOW.getTime() + 5 * 60e3);
  r = await runPlacement({ client, now: t1, deps });
  assert.deepEqual([r.phase, r.recorded, r.pending], ['checking', 1, 1]);
  // Second one arrives with a bad score.
  verdicts[ids[1]] = { ...DV, sa: DV.sa.replace('1.2', '4.1') };
  r = await runPlacement({ client, now: new Date(t1.getTime() + 5 * 60e3), deps });
  assert.equal(r.phase, 'done');
  assert.equal((await getClient('acme')).placementDay, DAY);
  const hist = await placementHistory('acme');
  assert.equal(hist.length, 2);
  const latest = latestSpamTests(hist);
  assert.equal(latest[mails[0].from].pass, true);
  assert.equal(latest[mails[1].from].pass, false);
  assert.equal(latest[mails[1].from].spamAssassin, 4.1);
  assert.equal((await kv.hgetall(K.inbox('acme', mails[1].from))).spamPass, '0');
  const alert = (await alertLog()).find((a) => a.key === 'spam_score_low');
  assert.ok(alert);
  // Settled for today: not due again until tomorrow.
  client = await getClient('acme');
  const job = JOBS.find((j) => j.name === 'placement');
  assert.equal(await job.due({ client, now: new Date(NOW.getTime() + 3600e3) }), null);
  assert.ok(await job.due({ client: { ...client, placementDay: '' }, now: new Date(NOW.getTime() + 3600e3) }));
  assert.equal(await job.due({ client: { ...client, id: 'aviance' }, now: NOW }), null);
});

test('spam test run: the tool’s daily allowance is respected (all clients together); an unreachable tool alerts after 3 tries', async () => {
  const client = await spamClient({ dailyLimit: { 'mail-tester': 3, dkimvalidator: 1 } });
  const mails = [];
  let fetches = 0;
  const deps = {
    send: async (account, mail) => { mails.push(mail); return { success: true }; },
    fetchText: async () => { fetches++; throw new Error('getaddrinfo ENOTFOUND dkimvalidator.com'); },
  };
  const r = await runPlacement({ client, now: NOW, deps });
  assert.equal(mails.length, 1, 'one test left today');
  assert.equal(r.phase, 'waiting');
  const run = await kv.hgetall(K.placementRun('acme', DAY));
  assert.equal(JSON.parse(run.quotaWait).length, 1, 'the other inbox waits for tomorrow');
  for (let i = 1; i <= 3; i++) await runPlacement({ client, now: new Date(NOW.getTime() + i * 5 * 60e3), deps });
  assert.equal(fetches, 3);
  assert.ok((await alertKeys()).includes('placement_test_failed'));
  const [entry] = await placementHistory('acme');
  assert.equal(entry.pass, false);
  assert.equal(entry.score, null, 'no score is ever invented');
  assert.match(entry.error, /ENOTFOUND/);
});

test('Day 1 gate: seed placement AND a passing spam test on every inbox (fresh); PLACEMENT.gate off skips it', async () => {
  __reset();
  await createClient('beta', { state: 'warming', name: 'Beta' });
  await saveInbox('beta', { email: 'a@beta-team.com', password: 'x' });
  await saveInbox('beta', { email: 'b@beta-team.com', password: 'x' });
  const push = (e) => kv.lpush(K.placement('beta'), JSON.stringify(e));
  let g = await spamTestGate('beta', NOW);
  assert.equal(g.ok, false);
  await push({ day: '2026-10-05', tool: 'mail-tester', inbox: 'a@beta-team.com', score: 9, pass: true });
  await push({ day: '2026-10-05', tool: 'mail-tester', inbox: 'b@beta-team.com', score: 7.5, pass: false });
  g = await spamTestGate('beta', NOW);
  assert.equal(g.ok, false);
  assert.deepEqual(g.inboxes.map((i) => i.pass), [true, false]);
  await push({ day: '2026-10-06', tool: 'mail-tester', inbox: 'b@beta-team.com', score: 8.6, pass: true });
  assert.equal((await spamTestGate('beta', NOW)).ok, true);
  // A seed entry never counts as a spam test; an old pass goes stale.
  assert.equal((await spamTestGate('beta', new Date('2026-10-20T15:00:00Z'))).ok, false);
  // readinessGate carries it as its own check.
  const rg = await readinessGate('beta', NOW);
  assert.equal(rg.checks.spamTest.ok, true);
  await kv.del(K.placement('beta'));
  assert.equal((await readinessGate('beta', NOW)).checks.spamTest.ok, false);
  await setOverride(null, 'PLACEMENT.gate', false);
  assert.equal((await readinessGate('beta', NOW)).checks.spamTest.ok, true);
});

test('growth: spam-test scores join the placement series (one entry per tool per day, the lowest inbox)', async () => {
  __reset();
  await createClient('acme', { state: 'sending', name: 'Acme' });
  const today = DAY;
  await kv.hset(K.canary('acme', today), { phase: 'done', doneAt: NOW.toISOString(), result: JSON.stringify({ overall: 0.9, min: 0.8 }) });
  for (const [inbox, score] of [['a@x.com', 9.5], ['b@x.com', 8.1]]) await kv.lpush(K.placement('acme'), JSON.stringify({ at: NOW.toISOString(), day: today, tool: 'mail-tester', inbox, score, pass: true }));
  await kv.lpush(K.placement('acme'), JSON.stringify({ at: NOW.toISOString(), day: today, tool: 'mail-tester', inbox: 'c@x.com', score: null, pass: false, error: 'x' }));
  const g = await growthFor('acme', { days: 7, now: NOW });
  const seed = g.placement.find((p) => p.tool === 'seed');
  const mt = g.placement.find((p) => p.tool === 'mail-tester');
  assert.equal(seed.score, null);
  assert.equal(mt.score, 8.1);
  assert.deepEqual(mt.perInbox, { 'a@x.com': 9.5, 'b@x.com': 8.1 });
});

// ── 5. Blacklists ────────────────────────────────────────────────────────────

test('DNSBL answers: listed only on a documented listing code; timeouts, refusals and odd answers are unknown', () => {
  const ip = zoneSpec({ zone: 'bl.spamcop.net', listedFrom: 2, listedTo: 99, errors: [1] });
  assert.equal(classifyAnswer(ip, { ok: true, value: ['127.0.0.2'] }), 'listed');
  assert.equal(classifyAnswer(ip, { ok: false, code: 'ENOTFOUND' }), 'clean');
  assert.equal(classifyAnswer(ip, { ok: false, code: 'ENODATA' }), 'clean');
  for (const code of ['ETIMEOUT', 'ESERVFAIL', 'EREFUSED', 'ERROR']) assert.equal(classifyAnswer(ip, { ok: false, code }), 'unknown', code);
  assert.equal(classifyAnswer(ip, { ok: true, value: ['127.0.0.1'] }), 'unknown', 'refused (public resolver)');
  assert.equal(classifyAnswer(ip, { ok: true, value: ['127.255.255.254'] }), 'unknown', 'Spamhaus-style error');
  assert.equal(classifyAnswer(ip, { ok: true, value: ['203.0.113.9'] }), 'unknown', 'hijacked / wildcard answer');
  const uribl = zoneSpec({ zone: 'multi.uribl.com', type: 'domain', listedBits: 2, warnBits: 12, errors: [1], test: 'test.uribl.com' });
  assert.equal(classifyAnswer(uribl, { ok: true, value: ['127.0.0.2'] }), 'listed');
  assert.equal(classifyAnswer(uribl, { ok: true, value: ['127.0.0.4'] }), 'warn', 'grey is a warning');
  assert.equal(classifyAnswer(uribl, { ok: true, value: ['127.0.0.14'] }), 'listed');
  assert.equal(classifyAnswer(uribl, { ok: true, value: ['127.0.0.1'] }), 'unknown');
  const mailspike = zoneSpec({ zone: 'bl.mailspike.net', listedFrom: 2, listedTo: 2, warnFrom: 10, warnTo: 12 });
  assert.equal(classifyAnswer(mailspike, { ok: true, value: ['127.0.0.11'] }), 'warn');
  // A zone whose test entry is not listed (or whose control is) gives no verdict.
  const zones = [ip];
  const rows = (verdicts) => verdicts.map(([source, verdict]) => ({ zone: ip, source, verdict, target: source === 'A record' ? '203.0.113.5' : 'x' }));
  assert.deepEqual(summarize(rows([['A record', 'listed'], ['test', 'clean'], ['control', 'clean']]), { zones }).unknown, ['bl.spamcop.net']);
  assert.deepEqual(summarize(rows([['A record', 'listed'], ['test', 'listed'], ['control', 'listed']]), { zones }).unknown, ['bl.spamcop.net']);
  const hit = summarize(rows([['A record', 'listed'], ['test', 'listed'], ['control', 'clean']]), { zones });
  assert.deepEqual([hit.listed.length, hit.warnings.length], [0, 1], 'an IP-list hit is a warning by default');
  assert.equal(summarize(rows([['A record', 'listed'], ['test', 'listed'], ['control', 'clean']]), { zones, ipAction: 'block' }).listed.length, 1);
  // Queries: domain lists ask the domain, IP lists the reversed IPs, plus both controls.
  const q = planQueries('acme-team.com', { aIps: ['203.0.113.5'], mxIps: [] }, [ip, uribl]);
  assert.ok(q.some((x) => x.name === '5.113.0.203.bl.spamcop.net'));
  assert.ok(q.some((x) => x.name === '2.0.0.127.bl.spamcop.net' && x.source === 'test'));
  assert.ok(q.some((x) => x.name === 'acme-team.com.multi.uribl.com'));
  assert.ok(q.some((x) => x.name === 'test.uribl.com.multi.uribl.com'));
  // The default set: no Spamhaus (commercial), no SORBS (closed 2024), no Barracuda (registered resolvers).
  const all = [...DEFAULTS.BLACKLISTS.domainZones, ...DEFAULTS.BLACKLISTS.ipZones].map((z) => z.zone).join(' ');
  assert.doesNotMatch(all, /spamhaus|sorbs|barracuda|manitu/);
});

function dnsWorld({ listed = {}, timeouts = false } = {}) {
  const notFound = () => Object.assign(new Error('nf'), { code: 'ENOTFOUND' });
  io.dns = {
    resolveTxt: async () => { throw notFound(); },
    resolveMx: async () => [{ exchange: 'smtp.google.com', priority: 1 }],
    resolve4: async (n) => {
      if (n === 'acme-team.com') return ['203.0.113.5'];
      if (n === 'smtp.google.com') return ['142.250.1.27'];
      if (timeouts) throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
      if (/^2\.0\.0\.127\./.test(n)) return ['127.0.0.2'];                   // IP-list test entries
      if (n === 'test.uribl.com.multi.uribl.com') return ['127.0.0.14'];
      if (n === 'test.surbl.org.multi.surbl.org') return ['127.0.0.254'];
      if (n === 'test.dbl.nordspam.com') return ['127.0.0.2'];
      if (listed[n]) return listed[n];
      throw notFound();
    },
  };
}

test('blacklist check: clean, a domain listing blocks, an A/MX IP listing only warns, all timeouts = unknown (never listed)', async () => {
  __reset();
  dnsWorld();
  let r = await checkDomainBlacklists('acme-team.com', { now: NOW });
  assert.equal(r.status, 'clean');
  assert.equal(r.clean, 10);
  assert.deepEqual(r.listed, []);
  dnsWorld({ listed: { 'acme-team.com.multi.surbl.org': ['127.0.0.64'], '5.113.0.203.bl.spamcop.net': ['127.0.0.2'] } });
  r = await checkDomainBlacklists('acme-team.com', { now: NOW });
  assert.equal(r.status, 'listed');
  assert.deepEqual(r.listed, ['acme-team.com on SURBL']);
  assert.deepEqual(r.warnings, ['203.0.113.5 (A record) on SpamCop']);
  dnsWorld({ timeouts: true });
  r = await checkDomainBlacklists('acme-team.com', { now: NOW });
  assert.equal(r.status, 'unknown');
  assert.equal(r.listed.length, 0);
  assert.equal(r.unknown.length, 10);

  // Auth Guard stores the v2 shape; unknown and warnings never pause, a listing does.
  await createClient('acme', { state: 'sending', name: 'Acme' });
  await kv.hset(K.domain('acme'), { name: 'acme-team.com' });
  let out = await runBlacklistCheck({ clientId: 'acme', now: NOW });
  let dom = await kv.hgetall(K.domain('acme'));
  assert.equal(dom.blacklist, 'unknown');
  assert.deepEqual(Object.keys(JSON.parse(dom.blacklists)).sort(), ['checkedAt', 'clean', 'listed', 'lists', 'unknown', 'warnings']);
  assert.equal((await getClient('acme')).sendHold, undefined);
  dnsWorld({ listed: { '5.113.0.203.bl.spamcop.net': ['127.0.0.2'] } });
  out = await runBlacklistCheck({ clientId: 'acme', now: NOW });
  dom = await kv.hgetall(K.domain('acme'));
  assert.equal(dom.blacklist, 'clean');
  assert.equal(out.warnings.length, 1);
  assert.ok((await alertKeys()).includes('blacklist_warning'));
  assert.ok(!(await alertKeys()).includes('blacklisted'));
  dnsWorld({ listed: { 'acme-team.com.multi.uribl.com': ['127.0.0.2'] } });
  out = await runBlacklistCheck({ clientId: 'acme', now: NOW });
  assert.deepEqual(out.listed, ['acme-team.com on URIBL']);
  assert.equal((await kv.hgetall(K.domain('acme'))).blacklist, 'listed');
  assert.ok((await alertKeys()).includes('blacklisted'));
});

// ── 6. Bounce limits ─────────────────────────────────────────────────────────

async function sendingClient() {
  __reset();
  const alerts = [];
  const notified = [];
  setDeps({
    alertOwner: async (key, opts) => { alerts.push({ key, ...opts }); return { sent: true }; },
    notifyClient: async (id, key) => { notified.push(key); return { sent: true }; },
    verifyEmail: async () => ({ valid: true }),
  });
  await createClient('acme', { state: 'sending', name: 'Acme' });
  await kv.hset(K.trial('acme'), { day1Date: '2026-09-28' });
  await saveInbox('acme', { email: 'jane@acme-team.com', password: 'pw', enabled: true, dailyCap: '24' });
  await saveInbox('acme', { email: 'j.doe@acme-team.com', password: 'pw', enabled: true, dailyCap: '24' });
  await initCounters('acme');
  return { alerts, notified };
}

test('bounce limits: pure lines — pause from 1.5 %, stop above 2 %, only over ≥ 50 sends', () => {
  assert.equal(bouncePauseDue({ sent: 60, bounces: 0 }), null);
  assert.ok(bouncePauseDue({ sent: 200, bounces: 3 }), 'exactly 1.5 % pauses');
  assert.ok(bouncePauseDue({ sent: 60, bounces: 1 }));
  assert.equal(bouncePauseDue({ sent: 60, bounces: 2 }), null, '3.3 % is the stop trigger’s job');
  assert.equal(bouncePauseDue({ sent: 40, bounces: 1 }), null, 'too few sends to judge');
  assert.deepEqual(computeCap({ sendingDay: 9, caps: DEFAULTS.RAMP.caps, bounceHalved: true }).reasons, ['bounce_pause']);
  assert.equal(computeCap({ sendingDay: 9, caps: DEFAULTS.RAMP.caps, bounceHalved: true }).cap, 12);
});

test('bounce 1.5–2 %: caps halved + alert, sending continues; 3 green business days lift it; over 2 % the emergency stop takes over', async () => {
  const { alerts } = await sendingClient();
  await kv.hset(K.countersDay('acme', DAY), { sent: 60, bounces: 1 });
  const r = await runEmergency('acme', { now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.bounce.paused, true);
  let c = await getClient('acme');
  assert.equal(c.state, 'sending');
  assert.equal(c.bounceHalved, '1');
  assert.equal((await kv.hgetall(K.inbox('acme', 'jane@acme-team.com'))).dailyCap, '12');
  assert.equal(alerts.filter((a) => a.key === 'bounce_pause').length, 1);
  assert.match(alerts[0].body, /1\.7%/);
  // Same day again: nothing more.
  await runEmergency('acme', { now: new Date(NOW.getTime() + 15 * 60e3) });
  assert.equal(alerts.filter((a) => a.key === 'bounce_pause').length, 1);
  assert.equal((await kv.hgetall(K.inbox('acme', 'jane@acme-team.com'))).dailyCap, '12', 'halved once');
  // The Ramp Planner keeps halving tomorrow.
  const ramp = await runRamp({ client: await getClient('acme'), now: new Date('2026-10-07T04:10:00Z') });
  assert.ok(ramp.inboxes.every((i) => i.reasons.includes('bounce_pause')));
  // Green days Wed 7, Thu 8, Fri 9 (checked the morning after).
  for (const d of ['2026-10-07', '2026-10-08', '2026-10-09']) await kv.hset(K.countersDay('acme', d), { sent: 30, bounces: 0 });
  await runEmergency('acme', { now: new Date('2026-10-08T16:00:00Z') });
  await runEmergency('acme', { now: new Date('2026-10-09T16:00:00Z') });
  assert.equal((await getClient('acme')).bounceHalved, '1');
  const lift = await runEmergency('acme', { now: new Date('2026-10-10T16:00:00Z') });
  assert.equal(lift.bounce.lifted, true);
  assert.equal((await getClient('acme')).bounceHalved, '0');
  assert.ok(alerts.some((a) => a.key === 'bounce_pause_lifted'));

  // Over 2 %: the existing stop path (pause state + emergency alert), bounce pause cleared.
  const s = await sendingClient();
  await kv.hset(K.client('acme'), { bounceHalved: '1', bounceGreenDay: DAY });
  await kv.hset(K.countersDay('acme', DAY), { sent: 60, bounces: 2 });
  const stop = await runEmergency('acme', { now: NOW });
  assert.equal(stop.started.code, 'bounce');
  c = await getClient('acme');
  assert.equal(c.state, 'paused');
  assert.equal(c.bounceHalved, '0');
  assert.ok(s.alerts.some((a) => a.key === 'emergency'));
});

// ── 7. The hub's deliverability view ────────────────────────────────────────

test('deliverabilityView: warm-up pool, newest 10 placement tests, blacklists, bounce — from stored values only', async () => {
  await circle();
  const deps = { rng: () => 0.5, send: async () => ({ success: true, messageId: '<x@x>' }) };
  // A fixed weekday 11:00 ET: warm-up only sends 07:00–22:00, so the real clock would fail this at night.
  await runWarmupSend({ now: NOW, deadline: Date.now() + 20_000, deps });
  for (let i = 0; i < 12; i++) await kv.lpush(K.placement('acme'), JSON.stringify({ at: `2026-10-${String(i + 1).padStart(2, '0')}T12:00:00Z`, day: `2026-10-${String(i + 1).padStart(2, '0')}`, tool: i % 2 ? 'seed' : 'mail-tester', inbox: i % 2 ? null : 'ann@acme-trial.com', score: i % 2 ? null : 9, inboxRate: i % 2 ? 0.9 : null, pass: true, detail: ['SPF pass'], reportUrl: null }));
  await kv.hset(K.domain('acme'), { blacklist: 'clean', blacklists: JSON.stringify({ checkedAt: NOW.toISOString(), listed: [], warnings: [], clean: 9, unknown: ['multi.uribl.com'], lists: ['a', 'b'] }) });
  await kv.hset(K.client('acme'), { bounceRate7d: '0.0120', bounceSent7d: 250 });
  await setOverride(null, 'EXTERNAL_WARMUP.name', 'AutoMailer (free)');
  await setOverride(null, 'EXTERNAL_WARMUP.perDay', 5);
  const v = await deliverabilityView('acme', { now: NOW });
  assert.deepEqual(Object.keys(v).sort(), ['blacklists', 'bounce', 'gates', 'placement', 'warmup']);
  assert.deepEqual(v.gates, { seedPlacement: 0.85, mailTesterMin: 8, spamAssassinMax: 2, spamTestRequired: true }, 'the Day 1 limits come from config');
  assert.equal(v.warmup.pool, 7);
  assert.equal(v.warmup.helpers, 4);
  assert.ok(v.warmup.todayPairs > 0);
  assert.equal(v.warmup.providers.gmail, 1);
  assert.deepEqual(v.warmup.external, { name: 'AutoMailer (free)', status: 'connected', perDay: 5 });
  assert.equal(v.placement.length, 10);
  assert.equal(v.placement[0].at, '2026-10-12T12:00:00Z', 'newest first');
  for (const p of v.placement) for (const k of ['at', 'tool', 'score', 'inboxRate', 'detail', 'reportUrl']) assert.ok(k in p, k);
  assert.deepEqual([v.blacklists.clean, v.blacklists.listed, v.blacklists.status], [9, [], 'clean']);
  assert.deepEqual(v.bounce, { rate7d: 0.012, sent7d: 250, at: null, pauseAt: 0.015, stopAt: 0.02, halved: false });
  // Nothing stored yet → nulls, not zeros.
  __reset();
  await createClient('new', { state: 'warming', name: 'New' });
  const empty = await deliverabilityView('new');
  assert.equal(empty.warmup.pool, null);
  assert.deepEqual(empty.placement, []);
  assert.equal(empty.blacklists, null);
  assert.equal(empty.bounce.rate7d, null);
  assert.equal(empty.warmup.external, null);
});

test('the Ramp Planner stores the 7-day bounce rate once a day (null when nothing was sent)', async () => {
  await sendingClient();
  for (const [d, sent, bounces] of [['2026-10-05', 100, 1], ['2026-10-02', 100, 2]]) await kv.hset(K.countersDay('acme', d), { sent, bounces });
  await runRamp({ client: await getClient('acme'), now: new Date('2026-10-06T04:10:00Z') });
  const c = await getClient('acme');
  assert.equal(c.bounceRate7d, '0.0150');
  assert.equal(Number(c.bounceSent7d), 200);
});

test('external warm-up network: declared by the owner, trial quotas shrink so the 15/day ceiling holds', async () => {
  await circle();
  await setOverride(null, 'EXTERNAL_WARMUP.name', 'AutoMailer (free)');
  await setOverride(null, 'EXTERNAL_WARMUP.perDay', 10);
  const pool = await getPool({ now: NOW });
  assert.equal(pool.find((m) => m.email === 'ann@acme-trial.com').quota, 5); // day 10: 15 − 10
  assert.equal(pool.find((m) => m.email === 'h1@gmail.com').quota, 8, 'helpers are not on the external network');
});

test('sample company for the spam test is made up (never a real prospect)', () => {
  const s = sampleCompany({ cities: 'Dover, DE; Newark, DE' });
  assert.deepEqual([s.first_name, s.company, s.city], ['Jordan', 'Northfield Partners', 'Dover']);
});
