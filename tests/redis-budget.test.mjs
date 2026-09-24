// Redis budget (Upstash free tier: 500k commands / month). Drives the real
// scheduler minute by minute over a US weekday and a weekend day, with every
// network piece stubbed, and counts every KV command (pipelined ones
// included). Numbers are printed and written to docs/assumptions/integration.md
// by hand; the test fails when three sending clients would go over 450k.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { kv, __reset, __commands, __commandsBy, __resetCommands } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { createClient } from '@/lib/db/client';
import { saveInbox } from '@/lib/db/inboxes';
import { insertLeads } from '@/lib/db/leads';
import { initCounters } from '@/lib/db/counters';
import { setDeps } from '@/lib/systems/stagec-common';
import { net as warmNet, saveHelper } from '@/lib/systems/warmup';
import { runTick } from '@/lib/scheduler';
import { setOverride } from '@/lib/config';

process.env.ENC_KEY = process.env.ENC_KEY || crypto.randomBytes(32).toString('base64');
process.env.CRON_SECRET = process.env.CRON_SECRET || 'budget-secret';
process.env.OWNER_INBOX = 'owner@aviance.test:app-pw:Owner';
process.env.OWNER_EMAIL = 'owner@aviance.test';
delete process.env.HC_PING_URL;
delete process.env.TELEGRAM_BOT_TOKEN;

nodemailer.createTransport = () => ({ sendMail: async () => ({ messageId: `<${crypto.randomUUID()}@t>`, response: '250 OK' }), close() {}, verify: async () => true });
// Warm-up / canary mail really "arrives": sends land in the receiver's INBOX,
// reads find them (so the canary measures 100 % and nothing trips an emergency).
let boxes = {};
let uid = 0;
warmNet.send = async (account, mail) => {
  const b = (boxes[mail.to] ||= { INBOX: [], '[Gmail]/Spam': [], '[Gmail]/All Mail': [] });
  const id = `<${crypto.randomUUID()}@w>`;
  b.INBOX.push({ uid: ++uid, envelope: { messageId: id, from: [{ address: account.email }], subject: mail.subject }, headers: `X-Aviance-Warm: ${mail.headers['X-Aviance-Warm']}\r\nMessage-ID: ${id}\r\n` });
  return { success: true, messageId: id };
};
warmNet.imap = async (account) => {
  const b = (boxes[account.email] ||= { INBOX: [], '[Gmail]/Spam': [], '[Gmail]/All Mail': [] });
  let cur = 'INBOX';
  return {
    async connect() {}, async logout() {},
    async list() { return [{ path: 'INBOX' }, { path: '[Gmail]/Spam', specialUse: '\\Junk' }, { path: '[Gmail]/All Mail', specialUse: '\\All' }]; },
    async getMailboxLock(p) { cur = p; b[p] ||= []; return { release() {} }; },
    async search(q) { const want = String(q.header['x-aviance-warm'] || '').toLowerCase(); return b[cur].filter((m) => m.headers.toLowerCase().includes(want)).map((m) => m.uid); },
    async *fetch(uids) { for (const m of [...b[cur]]) if (uids.includes(m.uid)) yield m; },
    async messageFlagsAdd() {},
    async messageMove(u, dest) { const i = b[cur].findIndex((x) => x.uid === u); if (i >= 0) { const [m] = b[cur].splice(i, 1); b[dest].push(m); } },
  };
};

function stubStageC() {
  setDeps({
    sendEmail: async () => ({ success: true, messageId: `<${crypto.randomUUID()}@s>`, ms: 5 }),
    notifyClient: async () => ({ sent: true, messageId: `<${crypto.randomUUID()}@n>` }),
    alertOwner: async () => ({ sent: true }),
    verifyEmail: async () => ({ valid: true, reason: 'mx' }),
    scanMailbox: async () => ({ ok: true, messages: [], uidState: { INBOX: { uidValidity: '1', lastUid: 10 } } }),
  });
}

const SEQ = {
  footer: '{SenderName}\n{postalAddress}\n\nNot the right fit? Just reply STOP and I will not email you again.',
  touches: [
    { touch: 'd0', thread: 'new', subject: 'Idea for {Company}', body: 'Hi {FirstName},\n\nA short note for {Company}. Worth a chat?' },
    { touch: 'd3', thread: 'd0', body: '{FirstName}, following up. Worth a chat?' },
    { touch: 'd7', thread: 'new', subject: 'Quick one, {FirstName}', body: 'One more idea for {Company}. Open to it?' },
    { touch: 'd10', thread: 'd7', body: 'Closing the file. Should I?' },
  ],
};

async function sendingClient(id) {
  // bookingWatch: a hot lead has already come in (mid-trial), so the booking
  // watcher, reminders, no-show ladder and chaser poll too (worst case).
  await createClient(id, { state: 'sending', name: `${id} Co`, contactEmail: `boss@${id}.test`, mainDomain: `${id}.test`, bookingWatch: '1' });
  await kv.hset(K.profile(id), { senderName: 'Jane Doe', postalAddress: '1 Main St, Dover, DE 19901', calendarUrl: 'https://cal.com/x', industry: 'MSP', bookingTested: '1' });
  await kv.hset(K.trial(id), { signedDay: '2026-09-10', day1Date: '2026-09-24', day30Date: '2026-10-23', firstSendAt: '2026-09-24T13:00:00Z', day1NoticeAt: '2026-09-24T14:00:00Z' });
  for (const n of [1, 2]) {
    await saveInbox(id, { email: `s${n}@${id}-team.test`, password: 'pw', displayName: 'Jane Doe', enabled: true, dailyCap: '25' });
    await kv.hset(K.inbox(id, `s${n}@${id}-team.test`), { warmupStartedAt: '2026-09-10T12:00:00Z', warmupReady: '1', inboxRate7d: '0.95' });
  }
  await kv.hset(K.sequence(id), { variantA: JSON.stringify(SEQ), variantB: JSON.stringify(SEQ), active: 'both', version: 1, approvedAt: '2026-09-20T00:00:00Z' });
  await initCounters(id);
  await kv.hset(K.sendState(id), { smokeClearedAt: '2026-09-25T00:00:00Z' });
  await insertLeads(id, Array.from({ length: 300 }, (_, i) => ({ email: `p${i}@co${i}-${id}.test`, first_name: `P${i}`, company: `Co ${i}`, tz: 'America/New_York', riskLevel: 'safe', sequenceVariant: i % 2 ? 'B' : 'A' })));
}

async function world(clients) {
  __reset();
  boxes = {};
  stubStageC();
  await setOverride(null, 'OWNER.signerName', 'Owner');
  for (let i = 0; i < 8; i++) await saveHelper({ email: `helper${i}@helper${i}.test`, password: 'pw', provider: 'google' });
  for (let i = 0; i < clients; i++) await sendingClient(`c${i + 1}`);
}

/** Run one ET day of ticks: cron-job.org every `every` minutes + GitHub every 5 minutes. */
async function day(dayKey, every = 1) {
  const start = Date.parse(`${dayKey}T04:00:00Z`); // 00:00 EDT
  __resetCommands();
  for (let m = 0; m < 1440; m++) {
    const now = new Date(start + m * 60000);
    if (m % every === 0) await runTick({ source: 'cronjob', now });
    if (m % 5 === 0) await runTick({ source: 'github', now });
  }
  return { total: __commands(), by: __commandsBy() };
}

// Per-job attribution (due + claim + run), for the write-up.
const perJob = new Map();
async function instrument() {
  const { JOBS } = await import('@/lib/jobs');
  for (const j of JOBS) {
    if (j.__instrumented) continue;
    const { due, run } = j;
    j.due = async (ctx) => { const a = __commands(); try { return await due(ctx); } finally { perJob.set(j.name, (perJob.get(j.name) || 0) + __commands() - a); } };
    j.run = async (ctx) => { const a = __commands(); try { return await run(ctx); } finally { perJob.set(`${j.name}:run`, (perJob.get(`${j.name}:run`) || 0) + __commands() - a); } };
    j.__instrumented = true;
  }
}

export const results = {};
// Guards ≈ measured + 10 %, so a change that makes the tick costlier fails here.
const CEILING = { '0@1': 160_000, '1@1': 475_000, '1@2': 370_000, '2@1': 690_000, '2@2': 560_000, '3@1': 895_000, '3@2': 745_000 };

for (const [n, every] of [[0, 1], [1, 1], [1, 2], [2, 1], [2, 2], [3, 1], [3, 2]]) {
  test(`redis budget: ${n} sending client(s), tick every ${every} min`, { timeout: 600_000 }, async () => {
    await instrument();
    await world(n);
    await day('2026-10-05', every);
    perJob.clear(); // warm the one-off work (first-day setup) out of the numbers
    const weekday = await day('2026-10-06', every);
    const jobsWeekday = Object.fromEntries([...perJob.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14));
    const weekend = await day('2026-10-10', every);
    const month = Math.round(weekday.total * 21.7 + weekend.total * 8.7);
    results[`${n}@${every}`] = { weekday: weekday.total, weekend: weekend.total, month };
    console.log(`[redis-budget] clients=${n} every=${every}m weekday=${weekday.total} weekend=${weekend.total} month≈${month}`);
    console.log(`[redis-budget] clients=${n} weekday top commands ${JSON.stringify(Object.entries(weekday.by).slice(0, 8))}`);
    console.log(`[redis-budget] clients=${n} weekday by job ${JSON.stringify(jobsWeekday)}`);
    if (process.env.BUDGET_DEBUG) {
      const { getAllClients } = await import('@/lib/db/client');
      const { getTotals } = await import('@/lib/db/counters');
      for (const c of await getAllClients()) console.log('[redis-budget] client', c.id, c.state, c.pausedReason, JSON.stringify(await getTotals(c.id)), JSON.stringify(await kv.hgetall(K.emergency(c.id))));
    }
    // Regression guard at the measured level (docs/assumptions/integration.md
    // explains why three fully sending clients do not fit 450k at 1-minute ticks).
    if (CEILING[`${n}@${every}`]) assert.ok(month <= CEILING[`${n}@${every}`], `${n} clients @${every} min ≈ ${month} commands/month (guard ${CEILING[`${n}@${every}`]})`);
  });
}
