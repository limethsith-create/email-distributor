// The whole journey of ONE applicant, in order, through the real route
// handlers — the website form, the hub (board + trial after every step), the
// owner's Yes, the onboarding inbox and the reply bot, the booking page, the
// Calendar with Google Meet, the onboarding page and agreement, the market
// count, the CheapInboxes purchase (the owner buys; the machine connects),
// the setup check, warm-up with the owner's helpers, the Lead Finder, copy and
// approval, and Day 1 → Day 30 → converted → paid. The world is
// tests/journey-world.mjs: a simulated clock and a fake outside world; nothing
// leaves the machine.
//
// Up to warm-up there is NO heartbeat (the tick is not running yet): only the
// routes, their after() work and the hub's check carry the journey. From the
// helpers on, the tick runs every 15 minutes, as cron-job.org will, and every
// later step happens between ticks.
//
// JOURNEY_REPORT=dir writes a readable report (journey.md + journey.json: every
// step with the owner's simple label + next, the big to-do, every email and
// every alert). JOURNEY_SNAPSHOTS=1 rewrites tests/fixtures/journey/NN-step.json
// (the hub's answers after each step, for the hub's screens); a normal run
// checks every field those files have is still in the answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kv, __reset } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { getClient } from '@/lib/db/client';
import { getLeads } from '@/lib/db/leads';
import {
  sim, world, clock, et, colombo, installJourney, call, deliver, sentSince, firstLine, linkIn,
  APPLICANT, OWNER, GOOGLE, CI_KEY,
  ownerBuysInCheapInboxes, cheapInboxesDomainReady, cheapInboxesMailboxesReady, cheapInboxesWebhook,
} from './journey-world.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'journey');
const WRITE_SNAPSHOTS = process.env.JOURNEY_SNAPSHOTS === '1';

// ── the hub, as the owner sees it ────────────────────────────────────────────

const steps = [];          // the report
let mailMark = 0;          // sim.sent index at the last snapshot
const seenAlerts = new Set();
let clientId = null;

async function newAlerts() {
  const log = ((await kv.lrange(K.alertLog(), 0, -1)) || []).slice().reverse();
  const fresh = log.filter((a) => !seenAlerts.has(a.id));
  for (const a of fresh) seenAlerts.add(a.id);
  return fresh.map((a) => ({ at: a.at, key: a.key, title: a.title, urgent: a.urgent, clientId: a.clientId }));
}
const allAlerts = async () => ((await kv.lrange(K.alertLog(), 0, -1)) || []).slice().reverse();

/** The hub opening the Trials screen / the trial: its check first, then the board and the trial. */
async function hubLooks({ check = true } = {}) {
  const out = {};
  if (check) out.check = (await call('api/mc/onboard-calls/check/route', 'POST', { path: '/api/mc/onboard-calls/check' })).json;
  out.board = (await call('api/mc/hub/route', 'GET', { path: '/api/mc/hub' })).json;
  if (clientId) out.detail = (await call('api/mc/hub/[id]/route', 'GET', { path: `/api/mc/hub/${clientId}`, params: { id: clientId } })).json;
  return out;
}
const rowOf = (board, id = clientId) => board.stages.flatMap((s) => s.clients).find((r) => r.id === id) || null;

/** Every key path of a JSON value (arrays: the union of their items' paths, marked []). */
function paths(v, prefix = '', out = new Set()) {
  if (Array.isArray(v)) { for (const x of v) paths(x, `${prefix}[]`, out); return out; }
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { const p = prefix ? `${prefix}.${k}` : k; out.add(p); paths(x, p, out); }
  return out;
}

/** Volatile values → stable placeholders (the shapes stay real). */
function scrub(v) {
  const map = new Map();
  const tag = (kind, raw) => { const k = `${kind}:${raw}`; if (!map.has(k)) map.set(k, `${kind}_${[...map.keys()].filter((x) => x.startsWith(`${kind}:`)).length + 1}`); return map.get(k); };
  const text = JSON.stringify(v)
    .replace(/\/c\/[A-Za-z0-9_-]{20,}\//g, (m) => `/c/${tag('TOKEN', m)}/`)
    .replace(/t=v2\.[A-Za-z0-9._-]+/g, (m) => `t=${tag('PIXEL', m)}`)
    .replace(/<[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@[^>]+>/gi, (m) => `<${tag('MSGID', m)}>`);
  return JSON.parse(text);
}
/** The saved answer: arrays that only grow (the event log) kept to their newest 40 — shapes intact. */
const trimmed = (snap) => { const s = structuredClone(snap); if (s.detail?.events) s.detail.events = s.detail.events.slice(0, 40); return s; };

// docs/HUB-API.md: the fields the hub reads, checked on every answer.
const ROW_KEYS = ['id', 'name', 'state', 'stateLabel', 'plan', 'trialDay', 'day1Date', 'day30Date', 'contactName', 'contactEmail', 'website', 'health', 'healthReasons', 'five', 'inboxRate', 'openAlerts', 'urgentAlerts', 'todo', 'systems', 'nextUp', 'simple', 'fitScore'];
const SIMPLE_KEYS = ['step', 'label', 'next', 'needsYou', 'since', 'person', 'company', 'dayOf30', 'needsReply'];
const DETAIL_KEYS = ['row', 'profile', 'trial', 'domain', 'shopping', 'inboxes', 'leadsByStatus', 'leadfinder', 'sequence', 'counters', 'repliesByKind', 'replies', 'bookings', 'pacelog', 'reports', 'invoice', 'promises', 'upcoming', 'events', 'jobs', 'holds', 'links', 'application', 'onboardCall', 'autobuy', 'warmup', 'conversation', 'deliverability', 'leadQuality'];
const ONBOARDCALL_KEYS = ['status', 'label', 'sentAt', 'openedAt', 'lastReplyAt', 'bookedFor', 'bookedAt', 'bookedBy', 'heldAt', 'dueBy', 'overdue', 'remindersSent', 'nextReminderAt', 'stopped', 'bookingUrl', 'fromInbox', 'noShowAt', 'stoppedAt', 'lastOwnerReplyAt', 'needsReply', 'callMinutes', 'requestedFor', 'requestedAt', 'proposedFor', 'meetingId', 'steps', 'thread'];
const CONVERSATION_KEYS = ['thread', 'needsReply', 'lastInAt', 'lastOutAt', 'bot', 'canReply', 'fromInbox'];
const AUTOBUY_KEYS = ['status', 'buy', 'label', 'domain', 'steps', 'mailboxes', 'problem', 'linkedBy', 'canUnlink'];
const WARMUP_KEYS = ['status', 'label', 'day', 'of', 'readyBy', 'inboxRate', 'inboxes', 'problem', 'helpersNeeded'];
const MACHINE_KEYS = ['ok', 'baseUrl', 'heartbeat', 'activeTrials', 'maxActiveTrials', 'extensions', 'openAlerts', 'usage', 'setup', 'queue', 'others'];
const SECRETS = [CI_KEY, GOOGLE.clientSecret, GOOGLE.refresh, 'abcd efgh ijkl mnop', 'abcdefghijklmnop', 'wxyz abcd efgh ijkl', 'wxyzabcdefghijkl', 'Login-dana#9', 'app-pw-owner', 'journey-cron', 'journey-leadfinder'];

function contractCheck(nn, look) {
  const missing = (obj, keys, where) => keys.filter((k) => !(k in obj)).map((k) => `${where}.${k}`);
  const gaps = [...missing(look.board, ['machine', 'stages', 'todos', 'alerts'], 'board'), ...missing(look.board.machine, MACHINE_KEYS, 'board.machine')];
  const row = clientId ? rowOf(look.board) : null;
  if (row) gaps.push(...missing(row, ROW_KEYS, 'row'), ...missing(row.simple, SIMPLE_KEYS, 'row.simple'));
  const d = look.detail;
  if (d) {
    gaps.push(...missing(d, DETAIL_KEYS, 'detail'));
    if (d.onboardCall) gaps.push(...missing(d.onboardCall, ONBOARDCALL_KEYS, 'detail.onboardCall'));
    if (d.conversation) gaps.push(...missing(d.conversation, CONVERSATION_KEYS, 'detail.conversation'));
    if (d.autobuy) gaps.push(...missing(d.autobuy, AUTOBUY_KEYS, 'detail.autobuy'));
    if (d.warmup) gaps.push(...missing(d.warmup, WARMUP_KEYS, 'detail.warmup'));
  }
  assert.deepEqual(gaps, [], `${nn}: fields docs/HUB-API.md promises are missing`);
  // No secret in any hub answer.
  const text = JSON.stringify(look);
  assert.deepEqual(SECRETS.filter((s) => text.includes(s)), [], `${nn}: a secret is in a hub answer`);
  assert.ok(!/passwordEnc|loginPasswordEnc|apiKeyEnc|webhookSecretEnc|refreshToken/i.test(text), `${nn}: an encrypted field name is in a hub answer`);
}

/** After a step: the hub's view, saved for the hub's screens, and a page of the report. */
async function snap(nn, name, what, { check = true, extra = null } = {}) {
  const look = await hubLooks({ check });
  contractCheck(nn, look);
  const row = clientId ? rowOf(look.board) : null;
  const mail = sentSince(mailMark).map((m) => ({ at: m.at, from: m.from, to: m.to, subject: m.subject, first: firstLine(m.text), warmup: Boolean(m.headers?.['X-Aviance-Warm']) }));
  mailMark = sim.sent.length;
  const alerts = await newAlerts();
  const snapshot = trimmed({ step: `${nn}-${name}`, what, at: clock.iso(), check: look.check || null, board: look.board, detail: look.detail || null, ...(extra ? { extra } : {}) });
  const file = path.join(FIX, `${nn}-${name}.json`);
  if (WRITE_SNAPSHOTS) {
    fs.mkdirSync(FIX, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(scrub(snapshot), null, 1)}\n`);
  } else if (fs.existsSync(file)) {
    // Contract guard: every field the saved answer had is still there (lists that grow are not held to it).
    const want = paths(JSON.parse(fs.readFileSync(file, 'utf8')));
    const have = paths(scrub(snapshot));
    const gone = [...want].filter((p) => !have.has(p) && /^(board|detail)\./.test(p) && !/(^|\.)(events|history|thread|replies|timeline|calls|todos|alerts|todo|detail|upcoming|pacelog|flags|reports|bookings|placement|sample)(\[\]|\.|$)/.test(p));
    assert.deepEqual(gone.slice(0, 20), [], `${nn}-${name}: fields the hub had before are gone`);
  }
  steps.push({
    nn, name, what, at: clock.iso(),
    state: row?.state || null, simple: row?.simple || null, bigTodo: row?.todo?.[0] ? { text: row.todo[0].text, urgent: row.todo[0].urgent } : null,
    boardTodos: (look.board.todos || []).map((t) => `${t.urgent ? '!' : '·'} ${t.clientName}: ${t.text}`),
    mail, alerts, check: look.check || null,
  });
  return { ...look, row };
}

// ── the report ───────────────────────────────────────────────────────────────

const fmt = (iso, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
function writeReport(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'journey.json'), JSON.stringify(steps, null, 1));
  const lines = ['# The journey of one applicant — Ridgeline IT (Dana Whitfield)', '',
    'Every step as the owner sees it in the hub: the simple status (label + what next), the big to-do, every email the machine sent and every alert. Times: US Eastern / Sri Lanka.', ''];
  for (const s of steps) {
    lines.push(`## ${s.nn}. ${s.name}`, '', `*${fmt(s.at, 'America/New_York')} ET · ${fmt(s.at, 'Asia/Colombo')} Colombo*`, '', s.what, '');
    if (s.simple) {
      lines.push(`- **Status:** ${s.simple.label}${s.simple.needsYou ? ' (red dot: needs you)' : ''}`, `- **Next:** ${s.simple.next}`);
      if (s.bigTodo) lines.push(`- **Big to-do:** ${s.bigTodo.text}${s.bigTodo.urgent ? ' (urgent)' : ''}`);
      if (s.state) lines.push(`- **State:** ${s.state}`);
    }
    const warm = s.mail.filter((m) => m.warmup).length;
    const mail = s.mail.filter((m) => !m.warmup);
    const cold = mail.filter((m) => m.to !== OWNER.email && m.to !== APPLICANT.email && !m.to.endsWith('@getridgelineit.com'));
    const people = mail.filter((m) => !cold.includes(m));
    if (people.length) { lines.push('', '**Emails:**'); for (const m of people) lines.push(`- ${fmt(m.at, 'America/New_York')} ET → ${m.to}: “${m.subject}” — ${m.first.slice(0, 140)}`); }
    if (cold.length) lines.push('', `**Cold emails and replies to prospects:** ${cold.length} (first: “${cold[0].subject}” → ${cold[0].to})`);
    if (warm) lines.push('', `**Warm-up emails:** ${warm}`);
    if (s.alerts.length) { lines.push('', '**Alerts to the owner:**'); for (const a of s.alerts) lines.push(`- ${a.urgent ? '(urgent) ' : ''}\`${a.key}\` — ${a.title}`); }
    lines.push('');
  }
  fs.writeFileSync(path.join(dir, 'journey.md'), lines.join('\n'));
}

// ── the run ──────────────────────────────────────────────────────────────────

test('the journey: website form → Day 30 → converted, through the real routes', { timeout: 1_800_000 }, async () => {
  __reset();
  installJourney();
  const toDana = () => sentSince(mailMark).filter((m) => m.to === APPLICANT.email);
  const hourOf = (iso) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(new Date(iso))) % 24;

  // ── 0. The owner's one-time setup (hub › Settings; no heartbeat yet) ──────
  clock.set(colombo('2026-10-01', '10:00'));
  // As the hub's Settings save them: the whole top-level block, one field changed.
  const setting = async (dotted, value) => {
    const [top, ...rest] = dotted.split('.');
    const all = (await call('api/mc/config/route', 'GET')).json.settings;
    let block = structuredClone(all.find((x) => x.key === top).value);
    if (rest.length) { let o = block; for (const k of rest.slice(0, -1)) o = o[k]; o[rest[rest.length - 1]] = value; } else block = value;
    const r = await call('api/mc/config/route', 'POST', { body: { action: 'set', key: top, value: block } });
    assert.equal(r.status, 200, `${dotted}: ${JSON.stringify(r.json)}`);
  };
  await setting('OWNER.signerName', OWNER.name);
  await setting('OWNER.address', '14 Galle Road, Colombo 03, Sri Lanka');
  await setting('REVIEW.clutchUrl', 'https://clutch.co/profile/aviance');
  await setting('PAYMENT.paypalMe', 'https://paypal.me/aviance');
  await setting('WINBACK_TEXT.whatsNew', 'a faster list build');
  // The free Reoon tier checks 20 addresses a day; the journey lifts it so the whole list verifies in the build weeks.
  await setting('VERIFY.services.reoon.daily', 5000);
  // Google Meet: paste the OAuth client, press Connect, Allow on Google's screen.
  assert.equal((await call('api/mc/google/route', 'POST', { body: { action: 'saveClient', clientId: GOOGLE.clientId, clientSecret: GOOGLE.clientSecret } })).status, 200);
  const connect = await call('api/mc/google/route', 'POST', { body: { action: 'connect' } });
  const state = new URL(connect.json.url).searchParams.get('state');
  const back = await call('api/google/callback/route', 'GET', { path: `/api/google/callback?state=${encodeURIComponent(state)}&code=owner-said-allow&scope=${encodeURIComponent('https://www.googleapis.com/auth/calendar.events openid email')}` });
  assert.equal(back.status, 303);
  assert.match(back.headers.get('location'), /connected=1/);
  // CheapInboxes: paste the API key (the first look at the account runs after the answer).
  const ci = await call('api/mc/cheapinboxes/route', 'POST', { body: { action: 'saveKey', apiKey: CI_KEY } });
  assert.equal(ci.status, 200, JSON.stringify(ci.json));
  assert.equal(ci.json.webhook, 'registered');
  await snap('00', 'owner-setup', 'The owner connects Google Meet and CheapInboxes and fills his settings. No trial yet, and no heartbeat (cron-job.org is not set up).');

  // ── 1. The website trial form ─────────────────────────────────────────────
  clock.set(et('2026-10-01', '15:40'));
  const form = {
    source: 'website', name: APPLICANT.name, email: 'Dana@RidgelineIT.com', website: 'https://www.ridgelineit.com/', city: APPLICANT.city,
    sell: 'Managed IT and cybersecurity for law firms and accounting firms with 10–75 staff in the Carolinas',
    value: '$5,000–$20,000', capacity: '5–10 a week', strangers: 'Yes — cold buyers already', calendar: 'Yes',
    then: 'Move to Growth — 20 calls a month', notes: 'We tried LinkedIn ads in 2024; not much came of it.', agree: true, proof: ['Intro to one peer'],
  };
  const applied = await call('api/apply/route', 'POST', { path: '/api/apply', body: form, headers: { 'x-forwarded-for': '98.24.1.7', origin: 'https://www.aviance.online' } });
  assert.equal(applied.status, 200, JSON.stringify(applied.json));
  assert.equal(applied.json.outcome, 'review');
  clientId = await kv.hget(K.mainDomainIndex(), APPLICANT.domain);
  assert.ok(clientId, 'the application is saved under their domain');
  const s1 = await snap('01', 'applied', 'Dana Whitfield of Ridgeline IT fills the trial form on aviance.online. The owner hears at once; the machine reads the whole website, the public records and Google, then scores the fit.', { check: false });
  assert.equal(s1.row.state, 'applied');
  assert.deepEqual([s1.row.simple.step, s1.row.simple.needsYou], ['new', true]);
  assert.deepEqual(steps.at(-1).alerts.map((a) => a.key), ['new_application', 'application_scored'], 'the owner hears of it, then gets the score');
  const research = s1.detail.application.research;
  assert.equal(research.status, 'done');
  assert.ok(research.deep.pagesRead >= 15, `the whole site was read (${research.deep.pagesRead} pages)`);
  assert.ok(research.deep.documents.length >= 1, 'the capabilities PDF was read');
  assert.equal(research.deep.money.federal.ppp.length, 1, 'their PPP loan (not the roofing company\'s)');
  assert.equal(research.deep.emailSetup.mailHost, 'Microsoft 365');
  assert.ok(research.deep.history.firstSeen.startsWith('2013'));
  // Journey fix: Google lists at most 60 a search, so the research's quick count is a floor — never "Market too small".
  assert.equal(research.market.capped, true);
  assert.ok(!research.score.dealbreakers.some((d) => /Market too small/.test(d.text)), JSON.stringify(research.score.dealbreakers));
  assert.notEqual(research.score.label, 'Not a fit', `${research.score.score}/100 ${research.score.label}`);
  assert.equal(s1.row.todo[0].text, "Review Ridgeline IT's trial application", 'one to-do for the application, not also its alert');

  // ── 2. The owner reads it in the morning (Sri Lanka) and says yes ────────
  clock.set(colombo('2026-10-02', '08:55'));
  await snap('02', 'owner-reads', 'Friday morning in Colombo the owner opens the hub and reads the application, the research and the fit score.');
  clock.set(colombo('2026-10-02', '09:00'));
  const yes = await call('api/mc/clients/[id]/intake/route', 'POST', { path: `/api/mc/clients/${clientId}/intake`, params: { id: clientId }, body: { action: 'approveApplication' } });
  assert.equal(yes.status, 200, JSON.stringify(yes.json));
  assert.equal(yes.json.outcome, 'onboarding');
  const accepted = toDana();
  assert.equal(accepted.length, 1, 'exactly one email to them on a yes');
  assert.equal(accepted[0].from, OWNER.inbox);
  assert.match(accepted[0].subject, /book your onboarding call/);
  const onboardToken = linkIn(accepted[0].text, 'onboard');
  assert.ok(linkIn(accepted[0].text, 'book'), "the booking link is the machine's own booking page");
  assert.ok(onboardToken, 'the one-page onboarding link is in it');
  const pixel = /src="([^"]+\/api\/track\/open\?t=[^"]+)"/.exec(accepted[0].html)?.[1]?.replace(/&amp;/g, '&');
  assert.ok(pixel, 'one tracking pixel');
  const s3 = await snap('03', 'accepted', 'The owner presses “Say yes”: one email goes to Dana with the booking page and the onboarding page.');
  // Journey fix: the urgent new_application alert is handled by the yes — no to-do or red dot is left behind.
  assert.equal(s3.row.simple.needsYou, false, JSON.stringify(s3.row.todo));
  assert.ok((await allAlerts()).find((a) => a.key === 'new_application').acknowledged);

  // Dana opens it on her phone the next morning (Gmail loads the pixel through its proxy).
  clock.set(et('2026-10-02', '07:50'));
  const u = new URL(pixel);
  const opened = await call('api/track/open/route', 'GET', { path: u.pathname + u.search, headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)' } });
  assert.equal(opened.status, 200);
  assert.ok(await kv.hget(K.onboardCall(clientId), 'openedAt'), 'the open is recorded');

  // ── 4. Dana replies; the hub's check finds it and the reply bot answers ──
  const acceptedId = accepted[0].messageId.replace(/[<>]/g, '').toLowerCase();
  clock.set(et('2026-10-02', '09:05'));
  const herReply = deliver(OWNER.inbox, { from: APPLICANT.email, fromName: APPLICANT.name, to: [OWNER.inbox], subject: `Re: ${accepted[0].subject}`, text: `Hi Limeth,\n\nThanks — great news! What times work for you next week?\n\nDana\n\nOn Thu, Oct 1, 2026 at 11:30 PM Limeth Sith <${OWNER.inbox}> wrote:\n> Good news: we'd like to run your free 30-day trial`, threadIds: [acceptedId], inReplyTo: [acceptedId], references: [acceptedId], date: clock.iso() });
  clock.set(et('2026-10-02', '09:10'));
  const s4 = await snap('04', 'reply-bot', 'Dana writes back “What times work for you next week?”. When the owner opens the hub, its check reads the inbox and the reply bot answers with the booking page and three free times.');
  const botMail = sim.sent.filter((m) => m.to === APPLICANT.email).at(-1);
  assert.equal(steps.at(-1).mail.filter((m) => m.to === APPLICANT.email).length, 1, 'one answer from the bot');
  assert.equal(s4.detail.conversation.thread.at(-1).rule, 'wants_time');
  assert.deepEqual(steps.at(-1).alerts.map((a) => a.key), ['bot_replied']);
  assert.equal(botMail.inReplyTo, herReply.messageId, 'threaded under her reply');
  assert.ok(botMail.references.includes(accepted[0].messageId), 'references the acceptance email');
  assert.equal((botMail.text.match(/^• /gm) || []).length, 3, 'three free times');
  // Journey fix: the status says who answered — the bot, not "you" — and points at the Calendar.
  assert.equal(s4.row.simple.label, 'Accepted — the reply bot answered, waiting for them to pick a time');
  assert.equal(s4.detail.onboardCall.label, 'The reply bot answered — waiting for them to book');
  assert.equal(s4.row.simple.needsYou, false);

  // ── 5. She opens the booking page and picks Tuesday 11:00 ─────────────────
  clock.set(et('2026-10-02', '10:02'));
  const pageToken = linkIn(botMail.text, 'book');
  const bookPage = await call('c/[token]/book/route', 'GET', { path: `/c/${pageToken}/book`, params: { token: pageToken } });
  assert.equal(bookPage.status, 200);
  const offered = [...bookPage.text.matchAll(/name="start" value="([^"]+)"/g)].map((m) => m[1]);
  const tue11 = et('2026-10-06', '11:00').toISOString();
  assert.ok(offered.includes(tue11), `Tue 6 Oct 11:00 ET is offered (${offered.length} times)`);
  const picked = await call('api/c/book/route', 'POST', { path: '/api/c/book', form: { token: pageToken, tz: 'America/New_York', start: tue11, note: 'Marcus (our CEO) may join too.' } });
  assert.equal(picked.status, 303);
  assert.match(picked.headers.get('location'), /flash=sent/);
  assert.equal(toDana().length, 1, 'one "got it" email');
  const s5 = await snap('05', 'time-requested', 'Dana picks Tuesday 6 October 11:00 am (her time, Eastern) on the booking page. The owner is asked to say yes in the Calendar.', { extra: { calendar: (await call('api/mc/calendar/route', 'GET', { path: '/api/mc/calendar' })).json } });
  assert.deepEqual(steps.at(-1).alerts.map((a) => a.key), ['meeting_requested']);
  assert.match(s5.row.simple.label, /^They asked for Tue 6 Oct, 8:30 pm your time/);
  assert.equal(s5.row.simple.needsYou, true);

  // The owner says yes in the Calendar (Friday evening in Colombo).
  clock.set(colombo('2026-10-02', '20:00'));
  const cal = (await call('api/mc/calendar/route', 'GET', { path: '/api/mc/calendar' })).json;
  assert.equal(cal.requests.length, 1);
  const meetingId = cal.requests[0].id;
  const confirm = await call('api/mc/calendar/route', 'POST', { path: '/api/mc/calendar', body: { action: 'confirm', id: meetingId } });
  assert.equal(confirm.status, 200, JSON.stringify(confirm.json));
  const meetLink = confirm.json.meeting.meetLink;
  assert.match(meetLink, /^https:\/\/meet\.google\.com\//);
  const confirmation = toDana();
  assert.equal(confirmation.length, 1, 'one confirmation email');
  assert.ok(confirmation[0].icalEvent && /BEGIN:VCALENDAR/.test(confirmation[0].icalEvent.content), 'an .ics invite');
  assert.ok(confirmation[0].text.includes(meetLink) && confirmation[0].icalEvent.content.includes(meetLink), 'the Meet link in the email and the invite');
  assert.equal(world.google.events.size, 1, 'one event on the owner\'s Google Calendar');
  const s6 = await snap('06', 'call-confirmed', 'The owner presses Yes in the Calendar: a Google Calendar event with a Meet link is made, and Dana gets the confirmation with the invite.', { extra: { calendar: (await call('api/mc/calendar/route', 'GET', { path: '/api/mc/calendar' })).json } });
  assert.equal(s6.detail.onboardCall.status, 'booked');
  assert.equal(s6.detail.onboardCall.bookedFor, tue11);
  assert.equal(s6.row.simple.label, 'Call booked for Tue 6 Oct, 8:30 pm your time');
  assert.equal(s6.row.simple.needsYou, false);

  // The weekend: the owner opens the hub now and then; nothing goes to Dana.
  for (const [d, t] of [['2026-10-03', '11:00'], ['2026-10-04', '19:30']]) { clock.set(colombo(d, t)); await hubLooks(); }
  assert.equal(toDana().length, 0, 'no email to her over the weekend');
  // Monday: the day-before reminder goes when the owner's hub checks in US hours (no heartbeat yet).
  clock.set(et('2026-10-05', '08:45'));
  await hubLooks();
  assert.equal(toDana().length, 0, 'not before US hours');
  clock.set(et('2026-10-05', '09:30'));
  await snap('07', 'day-before', 'Monday morning (US): when the owner opens the hub, the day-before reminder with the Meet link goes to Dana.');
  const tomorrow = steps.at(-1).mail.filter((m) => m.to === APPLICANT.email);
  assert.equal(tomorrow.length, 1, 'one day-before reminder');
  assert.ok(sim.sent.filter((m) => m.to === APPLICANT.email).at(-1).text.includes(meetLink), 'with the Meet link');

  // Tuesday: the call happens; the owner marks it done in the Calendar.
  clock.set(et('2026-10-06', '11:40'));
  const held = await call('api/mc/calendar/route', 'POST', { path: '/api/mc/calendar', body: { action: 'held', id: meetingId } });
  assert.equal(held.status, 200, JSON.stringify(held.json));
  const s8 = await snap('08', 'call-held', 'Tuesday 11:40 am Eastern: the call happened; the owner marks it done in the Calendar.');
  assert.equal(s8.detail.onboardCall.status, 'held');
  assert.equal(s8.row.simple.label, 'Call done — waiting for them to finish the onboarding page');

  // ── 6. The onboarding page and the agreement (the link from the acceptance email) ──
  clock.set(et('2026-10-06', '14:05'));
  const onboard = (body) => call('api/c/onboard/route', 'POST', { path: '/api/c/onboard', body: { token: onboardToken, ...body }, headers: { 'x-forwarded-for': '98.24.1.7' } });
  const loaded = await onboard({ action: 'load' });
  assert.equal(loaded.status, 200, JSON.stringify(loaded.json));
  assert.equal(loaded.json.state, 'onboarding');
  const saved = await onboard({ action: 'save', fields: {
    companyName: 'Ridgeline IT', senderName: 'Dana Whitfield', senderTitle: 'Director of Client Success', senderPrefix: 'dana',
    calendarUrl: 'https://cal.com/ridgeline-it/intro', postalAddress: '2100 South Blvd, Suite 300, Charlotte, NC 28203', hotLeadEmail: APPLICANT.email,
    suppressCustomers: 'hollisgrantlaw.com\nCarolina Tax Partners', competitors: 'Queen City IT, bluegrid-it.com',
    sellsTo: 'We run managed IT and cybersecurity for law firms and CPA firms with 10–75 staff in the Carolinas.',
    proofLine: 'We look after 30 law and CPA firms in Charlotte and Raleigh.',
    defaultNiche: 'managed IT', defaultIcp: 'law firms and CPA firms', industry: 'law firm, accounting firm',
    cities: 'Charlotte, NC\nRaleigh, NC\nGreenville, SC', states: 'NC, SC', sizeMin: '10', sizeMax: '75',
    titles: 'Managing Partner\nOffice Manager\nFirm Administrator\nOwner', excludedTitles: 'Intern\nParalegal',
    dreamCustomers: [{ name: 'Moore & Van Allen', website: 'mvalaw.com' }, { name: 'Dixon Hughes', website: 'dhg.com' }, { name: 'Wyrick Robbins', website: 'wyrick.com' }],
    capacityPerWeek: '6', winCondition: 'Three real conversations with firm owners we do not know yet.',
  } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.deepEqual(saved.json.errors, {});
  clock.set(et('2026-10-06', '14:20'));
  const signed = await onboard({ action: 'accept', name: 'Dana Whitfield', title: 'Director of Client Success', agree: true });
  assert.equal(signed.status, 200, JSON.stringify(signed.json));
  assert.equal((await getClient(clientId)).state, 'awaiting_purchase', 'the market count passed inside the agreement request');
  // Journey fix: without a heartbeat the Price Scout ran in the agreement's after(): Dana hears
  // "setup in progress", the owner gets the list — with the CheapInboxes wording, not "paste the logins".
  assert.ok(toDana().some((m) => /set/i.test(m.subject || '') && !/agreement/i.test(m.subject || '')), `setup_in_progress reached Dana: ${toDana().map((m) => m.subject)}`);
  const shopAlert = sim.sent.filter((m) => m.to === OWNER.email && /Shopping list ready/.test(m.subject)).at(-1);
  assert.ok(shopAlert, 'the owner got the shopping list');
  assert.match(shopAlert.text, /CheapInboxes/);
  assert.doesNotMatch(shopAlert.text, /paste form|Turn auto-renew OFF/);
  const s9 = await snap('09', 'agreement-signed', 'Dana fills the one-page onboarding form and signs the agreement. The market count passes; the shopping list is made and Dana hears that setup has started.');
  assert.equal(s9.row.state, 'awaiting_purchase');
  assert.equal(s9.detail.autobuy.status, 'ready_to_buy');
  assert.equal(s9.row.simple.label, 'Buy their domain and 2 inboxes on CheapInboxes');
  assert.equal(s9.row.simple.needsYou, true);
  assert.equal(s9.row.todo.filter((t) => /buy/i.test(t.text)).length, 1, 'one buy to-do, not also the shopping-list alert');
  assert.ok(s9.detail.shopping.offers?.length, "the Price Scout's list is in the trial too (HUB-API v2 shopping)");
  const toBuy = s9.detail.autobuy.buy;

  // ── 7. The owner buys in CheapInboxes (Wednesday morning in Colombo); the machine does the rest ──
  clock.set(colombo('2026-10-07', '08:00'));
  await hubLooks();
  clock.set(colombo('2026-10-07', '08:12'));
  const domainId = ownerBuysInCheapInboxes(toBuy.domain, toBuy.mailboxes);
  const hook = async (event) => {
    const { raw, headers } = cheapInboxesWebhook(event);
    const r = await call('api/webhooks/cheapinboxes/route', 'POST', { path: '/api/webhooks/cheapinboxes', body: raw, headers: { 'content-type': 'application/json', ...headers } });
    assert.equal(r.status, 200);
    return r;
  };
  await hook('order.completed');
  const s10 = await snap('10', 'purchase-found', 'The owner buys the domain and two inboxes in his CheapInboxes account. CheapInboxes tells the machine (webhook); the machine finds the purchase and links it to Ridgeline IT.', { check: false, extra: { cheapinboxes: (await call('api/mc/cheapinboxes/route', 'GET')).json } });
  assert.equal(s10.detail.autobuy.status, 'provisioning');
  assert.equal(s10.row.simple.label, 'Setting up their inboxes (about 2 days)');
  assert.equal(s10.row.simple.needsYou, false, JSON.stringify(s10.row.todo));
  // CheapInboxes: the domain is live (DNS, DKIM, DMARC set by them) …
  clock.set(et('2026-10-07', '02:10'));
  cheapInboxesDomainReady(domainId);
  await hook('domain.dns_configured');
  // … and the two mailboxes with their logins.
  clock.set(et('2026-10-07', '05:40'));
  cheapInboxesMailboxesReady(domainId);
  await hook('mailbox.active');
  clock.advance(4000);
  await hook('mailbox.credentials_ready');
  const s11 = await snap('11', 'inboxes-connected', 'CheapInboxes finishes the domain and the mailboxes. The machine sets the forwarding, stores the logins (encrypted), runs the setup checks and starts warm-up — but the warm-up circle has no helpers yet.', { check: false });
  assert.equal(s11.row.state, 'warming');
  assert.equal(s11.detail.autobuy.status, 'done');
  assert.equal(s11.detail.domain.checks.dmarc.status, 'pass');
  assert.equal(s11.detail.domain.blacklist, 'clean');
  assert.equal(s11.detail.warmup.status, 'waiting_for_helpers');
  assert.equal(s11.row.simple.needsYou, true, 'add helpers');
  assert.equal(world.ci.forbidden.length, 0, 'the machine never ordered, paid or cancelled anything');
  assert.ok(world.ci.calls.filter((c) => /credentials$/.test(c.path)).length >= 2, 'the logins were fetched');
  assert.equal((await kv.hgetall(K.heartbeat()))?.lastTickAt || null, null, 'everything so far ran with no heartbeat');

  // ── 8. Warm-up: the owner adds 8 free helper accounts (each login tested first) ──
  clock.set(colombo('2026-10-07', '19:00'));
  const helpers = [
    ['google', 'avc.helper.one@gmail.com', 'Nadia Perera'], ['google', 'avc.helper.two@gmail.com', 'Ruwan Silva'], ['google', 'avc.helper.three@gmail.com', 'Kasun Jay'],
    ['yahoo', 'avc.helper@yahoo.com', 'Anne Fox'], ['aol', 'avc.helper@aol.com', 'Ben Cole'], ['icloud', 'avc.helper@icloud.com', 'Cara Dunn'],
    ['gmx', 'avc.helper@gmx.com', 'Dev Rao'], ['yandex', 'avc.helper@yandex.com', 'Eli Moss'],
  ];
  for (const [provider, email, displayName] of helpers) {
    const r = await call('api/mc/warmup/route', 'POST', { path: '/api/mc/warmup', body: { action: 'addHelper', provider, email, password: 'abcd efgh ijkl mnop', displayName } });
    assert.equal(r.status, 200, `${email}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.helper.health, 'ok');
  }
  const warmSettings = (await call('api/mc/warmup/route', 'GET', { path: '/api/mc/warmup' })).json;
  assert.equal(warmSettings.circle.ready, true, JSON.stringify(warmSettings.circle));
  const s12 = await snap('12', 'helpers-added', 'The owner makes 8 free helper accounts (Gmail, Yahoo, AOL, iCloud, GMX, Yandex) and adds each in Settings › Warm-up; each login is tested first. The circle is complete. From now on the heartbeat runs (cron-job.org).', { extra: { warmupSettings: warmSettings } });
  assert.equal(s12.detail.warmup.status, 'warming', JSON.stringify(s12.detail.warmup));
  assert.equal(s12.row.simple.needsYou, false, JSON.stringify(s12.row.todo));

  // ── From here the heartbeat runs (cron-job.org, every 15 minutes) ──────────
  const tick = async () => {
    const r = await call('api/cron/tick/route', 'GET', { path: '/api/cron/tick?source=cronjob', headers: { authorization: 'Bearer journey-cron' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json;
  };
  let hooks = [];
  /** Tick every 15 minutes up to `until` (every hook after each tick); the clock then sits at `until`. */
  const goTo = async (until) => {
    let t = Math.ceil(clock.now.getTime() / (15 * 60_000)) * 15 * 60_000;
    const end = until.getTime();
    while (t <= end) {
      clock.set(t);
      await tick();
      for (const h of hooks) await h(clock.now);
      t += 15 * 60_000;
    }
    clock.set(end);
  };
  const usHours = (d) => { const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(d); const h = Number(p.find((x) => x.type === 'hour').value) % 24; const wd = p.find((x) => x.type === 'weekday').value; return !['Sat', 'Sun'].includes(wd) && h >= 9 && h < 17; };

  // The Lead Finder (a GitHub Actions job the machine dispatched) posts its results to the webhook.
  let leadsPosted = false;
  const leadFinder = async () => {
    if (leadsPosted) return;
    const st = (await kv.hgetall(K.leadfinder(clientId))) || {};
    if (!st.initialAt || !world.calls.some((c) => c.kind === 'dispatch')) return;
    leadsPosted = true;
    const places = [['Charlotte', 'NC'], ['Raleigh', 'NC'], ['Greenville', 'SC']];
    const FIRST = ['Alan', 'Beth', 'Carl', 'Dina', 'Evan', 'Faye', 'Glen', 'Hana', 'Ivan', 'Jill', 'Kyle', 'Lena', 'Mark', 'Nora', 'Owen', 'Pia', 'Reid', 'Sara', 'Tate', 'Vera'];
    const LAST = ['Adams', 'Brooks', 'Chen', 'Dalton', 'Ellis', 'Foster', 'Grant', 'Hayes', 'Irwin', 'Jensen', 'Keller', 'Lowe', 'Mercer', 'Nash', 'Ortiz', 'Price', 'Quinn', 'Reyes', 'Shaw', 'Tran', 'Upton', 'Vance', 'Webb'];
    const TITLES = ['Managing Partner', 'Office Manager', 'Firm Administrator', 'Owner'];
    for (let b = 0; b < 5; b++) {
      const leads = Array.from({ length: 90 }, (_, i) => {
        const n = b * 90 + i;
        const [city, st2] = places[n % 3];
        const law = n % 2 === 0;
        const first = FIRST[n % FIRST.length];
        const last = LAST[(n * 7) % LAST.length];
        const host = `${last.toLowerCase()}${law ? 'law' : 'cpa'}${n}.com`;
        return { email: `${first.toLowerCase()}@${host}`, first_name: first, name: `${first} ${last}`, title: TITLES[n % 4], company: `${last} ${law ? 'Law Group' : 'CPA'} ${n}`, website: `https://www.${host}`, city, state: st2, types: [law ? 'lawyer' : 'accounting'], employees: 12 + (n % 50), riskLevel: 'safe', score: 3 };
      });
      if (b === 0) {
        // A current customer and a role inbox: the machine must never email them.
        leads.push({ email: 'renee@hollisgrantlaw.com', first_name: 'Renee', name: 'Renee Hollis', title: 'Managing Partner', company: 'Hollis & Grant Law', website: 'https://hollisgrantlaw.com', city: 'Charlotte', state: 'NC', types: ['lawyer'], employees: 40, riskLevel: 'safe' });
        leads.push({ email: 'info@shawcpa999.com', first_name: '', name: '', title: '', company: 'Shaw CPA', website: 'https://shawcpa999.com', city: 'Raleigh', state: 'NC', types: ['accounting'], employees: 15, riskLevel: 'safe' });
      }
      const r = await call('api/webhooks/leadfinder/route', 'POST', { path: '/api/webhooks/leadfinder', headers: { authorization: 'Bearer journey-leadfinder' }, body: { clientId, type: 'batch', runId: 'lf1', batchNo: b, mode: 'initial', leads, placesRequests: 30 } });
      assert.equal(r.status, 200, JSON.stringify(r.json));
    }
    const done = await call('api/webhooks/leadfinder/route', 'POST', { path: '/api/webhooks/leadfinder', headers: { authorization: 'Bearer journey-leadfinder' }, body: { clientId, type: 'done', runId: 'lf1', mode: 'initial', found: 452, candidates: 900 } });
    assert.equal(done.status, 200, JSON.stringify(done.json));
  };
  // Dana answers her emails in her business hours.
  let approvedAt = null;
  const danaApproves = async (now) => {
    if (approvedAt || !usHours(now)) return;
    const mail = sim.sent.find((m) => m.to === APPLICANT.email && linkIn(m.text, 'approve'));
    if (!mail) return;
    const token = linkIn(mail.text, 'approve');
    const page = await call('api/c/approve/route', 'POST', { path: '/api/c/approve', body: { op: 'load', token } });
    assert.equal(page.status, 200, JSON.stringify(page.json));
    for (const section of ['profile', 'list', 'copy']) {
      const r = await call('api/c/approve/route', 'POST', { path: '/api/c/approve', body: { op: 'approve', token, section } });
      assert.equal(r.status, 200, JSON.stringify(r.json));
    }
    approvedAt = clock.iso();
  };
  let bookingTestedAt = null;
  const danaTestsBooking = async (now) => {
    if (bookingTestedAt || !usHours(now)) return;
    const mail = sim.sent.find((m) => m.to === APPLICANT.email && linkIn(m.text, 'booking-ok'));
    if (!mail) return;
    const r = await call('api/c/booking-ok/route', 'POST', { path: '/api/c/booking-ok', body: { token: linkIn(mail.text, 'booking-ok') } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    bookingTestedAt = clock.iso();
  };
  hooks = [leadFinder, danaApproves, danaTestsBooking];

  clock.set(et('2026-10-07', '09:40'));
  await goTo(et('2026-10-09', '12:00'));
  const s13 = await snap('13', 'warming-day-3', 'Two days of warm-up: the new inboxes trade friendly emails with the helpers, a few at first. The Lead Finder has run.');
  assert.equal(s13.detail.warmup.status, 'warming');
  // Journey fix: a trial inbox's warm-up replies count against its ramp quota (3 a day on days 1–3).
  for (const i of s13.detail.warmup.inboxes) assert.ok(i.sentToday <= i.quota, `${i.email}: ${i.sentToday} sent, quota ${i.quota}`);
  await goTo(et('2026-10-13', '12:00'));
  const s14 = await snap('14', 'warming-day-7', 'A week of warm-up; the list is in and graded.');
  for (const i of s14.detail.warmup.inboxes) assert.ok(i.sentToday <= i.quota, `${i.email}: ${i.sentToday} sent, quota ${i.quota}`);
  assert.ok(Number(s14.detail.leadsByStatus.unsent) >= 400, 'the list is in');
  assert.equal(s14.detail.leadQuality.grades.rejected, 2, 'the customer and the role address are out');
  await goTo(et('2026-10-14', '12:00'));
  const s15 = await snap('15', 'approval-sent', 'Day −7: the list and the four emails go to Dana for her OK — at 9 am her time — and she approves.');
  const approvalMail = sim.sent.find((m) => m.to === APPLICANT.email && linkIn(m.text, 'approve'));
  assert.ok(approvalMail, 'the approval link went');
  // Journey fix: never at midnight their time.
  assert.ok(hourOf(approvalMail.at) >= 9 && hourOf(approvalMail.at) < 17, `approval link at ${approvalMail.at}`);
  assert.ok(approvedAt, 'Dana approved it');
  assert.equal(s15.detail.sequence.approvalMode, 'click');
  await goTo(et('2026-10-21', '12:00'));
  const s16 = await snap('16', 'day-1', 'Day 1: warm-up done, list and copy approved, the booking link tested — the first emails went out at 9 am their time.');
  assert.equal(s16.row.state, 'sending');
  assert.equal(s16.detail.trial.day1Date, '2026-10-21');
  assert.equal(s16.row.simple.label, 'Sending — day 1 of 30, 0 calls booked');
  // Journey fix: the booking test went on a business day (Day −4 was a Saturday → the Friday before), inside US hours.
  const testMail = sim.sent.find((m) => m.to === APPLICANT.email && linkIn(m.text, 'booking-ok'));
  assert.equal(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date(testMail.at)), 'Fri');
  assert.ok(hourOf(testMail.at) >= 9 && hourOf(testMail.at) < 17, `booking test at ${testMail.at}`);
  assert.ok(bookingTestedAt);

  // ── 9. Sending: Day 1 → Day 30 ────────────────────────────────────────────
  const sentLeads = async () => (await getLeads(clientId)).filter((l) => l.sent_at && l.status === 'in_sequence' && l.original_message_id).sort((a, b) => a.email.localeCompare(b.email));
  // Dana answers every hot lead in its thread, in her business hours.
  const answered = new Set();
  const danaAnswersHotLeads = async (now) => {
    if (!usHours(now)) return;
    for (const m of sim.sent) {
      if (m.to !== APPLICANT.email || !/^Hot/.test(m.subject || '') || answered.has(m.messageId)) continue;
      answered.add(m.messageId);
      deliver(m.from, { from: APPLICANT.email, subject: `Re: ${m.subject}`, text: 'On it — I will call them this afternoon.', threadIds: [m.messageId.replace(/[<>]/g, '')] });
    }
  };
  // Prospects answer like real ones: about 1 cold email in 25, a few hours to two days later.
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const KIND_TEXT = ['No thanks.', 'Not interested, please remove me.', 'Not right now — maybe next quarter.', 'Do you work with firms our size?', 'Interested. What would this cost for 20 people?', 'Received.'];
  const scheduled = [];
  let coldMark = sim.sent.length;
  const prospectsReply = async (now) => {
    for (const m of sim.sent.slice(coldMark)) {
      if (!m.from.endsWith('@getridgelineit.com') || m.headers?.['X-Aviance-Warm'] || m.to.endsWith('@getridgelineit.com') || m.to === APPLICANT.email) continue;
      if (rnd() >= 0.04) continue;
      scheduled.push({ at: now.getTime() + (3 + rnd() * 40) * 3600e3, to: m.to, text: KIND_TEXT[Math.floor(rnd() * KIND_TEXT.length)] });
    }
    coldMark = sim.sent.length;
    for (const r of scheduled.filter((x) => !x.done && x.at <= now.getTime())) {
      r.done = true;
      const lead = (await getLeads(clientId)).find((l) => l.email === r.to);
      if (!lead || !lead.original_message_id || lead.status !== 'in_sequence') continue;
      deliver(lead.account_used, { from: lead.email, subject: `Re: ${lead.original_subject}`, text: r.text, threadIds: [lead.original_message_id.replace(/[<>]/g, '')] });
    }
  };
  hooks = [danaAnswersHotLeads, prospectsReply];

  await goTo(et('2026-10-23', '11:45'));
  // Replies of every kind land in the trial inboxes.
  const TEXT = {
    interested: 'Interested — we have had two outages this year. What does it cost?',
    question: 'Who else in Charlotte do you look after?',
    notnow: 'Not right now, maybe next quarter.',
    no: 'No thanks.',
    wrongperson: "I'm not the right person — please contact maria.lopez@{host}, she runs operations.",
    angry: 'Stop emailing me. How did you get my address?',
    unclear: 'Received.',
  };
  const used = {};
  const pool = await sentLeads();
  for (const kind of ['interested', 'question', 'notnow', 'no', 'ooo', 'wrongperson', 'angry', 'unclear']) {
    const lead = pool.shift();
    used[kind] = lead;
    const threadIds = [lead.original_message_id.replace(/[<>]/g, '')];
    if (kind === 'ooo') deliver(lead.account_used, { from: lead.email, subject: `Out of Office: ${lead.original_subject}`, text: 'I am out of the office until next Monday.', threadIds, kind: 'ooo' });
    else deliver(lead.account_used, { from: lead.email, subject: `Re: ${lead.original_subject}`, text: TEXT[kind].replace('{host}', lead.email.split('@')[1]), threadIds });
  }
  await goTo(et('2026-10-23', '13:00'));
  const s17 = await snap('17', 'replies', 'Day 3: replies of every kind come in. Interested and questions go to Dana as hot leads; “no” and angry ones are suppressed everywhere; a referral becomes a new lead; an out-of-office waits.');
  const kinds = [...new Set(Object.values((await kv.hgetall(K.replies(clientId))) || {}).map((r) => r.kind))];
  for (const k of ['angry', 'interested', 'no', 'notnow', 'ooo', 'question', 'unclear', 'wrongperson']) assert.ok(kinds.includes(k), `${k} handled`);
  assert.ok(sim.sent.some((m) => m.to === APPLICANT.email && /^Hot/.test(m.subject)), 'hot leads reach Dana');
  assert.ok(await kv.sismember(K.suppression(), used.angry.email));
  // Journey fix: alert titles name the trial ("Ridgeline IT"), not its id.
  const angry = steps.at(-1).alerts.find((a) => a.key === 'angry_reply');
  assert.equal(angry.title, 'Angry reply: Ridgeline IT');
  // The owner reads the angry reply and presses the to-do's button (acknowledge).
  const angryTodo = s17.board.todos.find((t) => t.clientId === clientId && t.action?.path === '/api/mc/alerts' && /Angry/.test(t.text));
  assert.ok(angryTodo, 'the urgent alert is a to-do');
  assert.equal((await call('api/mc/alerts/route', 'POST', { body: angryTodo.action.body })).status, 200);

  // The interested prospect books through Dana's calendar for Tue 27 Oct 11:00; the invite arrives in the trial inbox.
  const lead = used.interested;
  const slot = et('2026-10-27', '11:00');
  const dt = slot.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  deliver(lead.account_used, { from: 'notifications@cal.com', subject: `New Event: Intro call with ${lead.name}`, text: `A new event was booked with ${lead.name}.`, kind: 'human', ics: [['BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VEVENT', `UID:cal-${lead.email}`, `DTSTART:${dt}`, `DTEND:${dt}`, 'SUMMARY:Intro call', `ORGANIZER;CN=Dana Whitfield:mailto:${lead.account_used}`, `ATTENDEE;CN=${lead.name}:mailto:${lead.email}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')] });
  await goTo(et('2026-10-23', '15:00'));
  const s18 = await snap('18', 'prospect-booked', "The interested prospect books a call on Dana's calendar; Dana gets the hand-off.");
  assert.equal(Object.values((await kv.hgetall(K.bookings(clientId))) || {}).length, 1);
  assert.equal(s18.row.simple.label, 'Sending — day 3 of 30, 1 call booked');

  // Mid-trial Dana writes to the owner (not a hot lead: a question for him).
  await goTo(et('2026-10-26', '10:12'));
  deliver(OWNER.inbox, { from: APPLICANT.email, subject: 'Question about the trial', text: 'Hi Limeth — could we add Columbia, SC to the cities next week?\n\nDana', date: clock.iso() });
  await goTo(et('2026-10-26', '10:30'));
  const s19 = await snap('19', 'client-writes', "Day 6: Dana emails the owner a question. The hub shows “Answer Dana's message”.");
  assert.equal(s19.row.simple.needsReply, true);
  assert.equal(s19.row.simple.next, "Answer Dana's message");
  const replied = await call('api/mc/clients/[id]/messages/route', 'POST', { path: `/api/mc/clients/${clientId}/messages`, params: { id: clientId }, body: { action: 'reply', text: 'Hi Dana — yes, I will add Columbia from Monday.' } });
  assert.equal(replied.status, 200, JSON.stringify(replied.json));
  await goTo(et('2026-10-26', '10:45'));
  const s20 = await snap('20', 'owner-answered', 'The owner answers from the hub (it goes from the onboarding inbox, in her thread); the red dot goes.');
  assert.equal(s20.row.simple.needsReply, false);

  // The call happens; Dana taps "Showed".
  await goTo(new Date(slot.getTime() + 90 * 60_000));
  const tapMail = sim.sent.find((m) => m.to === APPLICANT.email && linkIn(m.text, 'tap'));
  assert.ok(tapMail, 'the one-tap email reached Dana');
  await goTo(new Date(slot.getTime() + 3.5 * 3600e3));
  const tapToken = linkIn(tapMail.text, 'tap');
  const tapView = await call('api/c/tap/route', 'GET', { path: `/api/c/tap?t=${tapToken}` });
  assert.equal(tapView.status, 200, JSON.stringify(tapView.json));
  const tapped = await call('api/c/tap/route', 'POST', { path: '/api/c/tap', body: { t: tapToken, action: 'showed' } });
  assert.equal(tapped.status, 200, JSON.stringify(tapped.json));
  const s21 = await snap('21', 'call-showed', 'The prospect showed up; Dana taps “Showed”. That is the first qualified call.');
  assert.equal(Number(s21.detail.counters.qualified), 1);

  // A legal reply holds sending on this domain until the owner has read it.
  await goTo(et('2026-10-28', '10:40'));
  const late = (await sentLeads()).find((l) => !Object.values(used).some((x) => x.email === l.email));
  deliver(late.account_used, { from: late.email, subject: `Re: ${late.original_subject}`, text: 'Forwarding this to our attorney. Cease and desist.', threadIds: [late.original_message_id.replace(/[<>]/g, '')] });
  await goTo(et('2026-10-28', '12:00'));
  const s22 = await snap('22', 'legal-hold', 'Day 6: a prospect answers with a legal threat. The address is suppressed everywhere and sending stops until the owner has read it.');
  assert.ok(s22.detail.holds.legalHoldAt);
  // Journey fix: the status must not say "Sending — day 6" while nothing is sent.
  assert.equal(s22.row.simple.label, 'Sending stopped — a prospect replied with a legal threat');
  assert.equal(s22.row.simple.needsYou, true);
  assert.equal(s22.row.todo.filter((t) => /legal/i.test(t.text)).length, 1, 'one to-do for it, not also its alert');
  // The owner reads it that evening (Colombo) and presses the to-do's button.
  await goTo(colombo('2026-10-28', '21:30'));
  const legalTodo = (await hubLooks()).board.todos.find((t) => t.id === `legal:${clientId}`);
  assert.ok(legalTodo && legalTodo.action.type === 'api', 'a one-button to-do');
  const cleared = await call('api/mc/clients/[id]/route', 'POST', { path: legalTodo.action.path, params: { id: clientId }, body: legalTodo.action.body });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
  const s23 = await snap('23', 'hold-cleared', 'The owner reads the legal reply and clears the hold; sending continues. The alert goes with it.');
  assert.equal(s23.detail.holds.legalHoldAt, null);
  assert.ok(!s23.row.todo.some((t) => /LEGAL/.test(t.text)), 'the legal alert does not linger as a to-do');

  await goTo(et('2026-11-04', '12:00'));
  const s24 = await snap('24', 'day-15', 'Day 15: halfway (US clocks went back on 1 November; the sends follow their 9–5).');
  assert.equal(s24.row.simple.dayOf30, 15);
  await goTo(et('2026-11-18', '12:00'));
  const s25 = await snap('25', 'day-29', 'Day 29: the trial report and the market report go to Dana.');
  assert.ok(s25.detail.reports.some((r) => r.name === 'day29' && r.renderedAt));
  await goTo(et('2026-11-19', '12:00'));
  const s26 = await snap('26', 'day-30', 'Day 30: the handover (everything from the trial) and the decision page go to Dana.');
  assert.equal(s26.row.state, 'deciding');
  // Dana presses Start on the decision page.
  const decision = sim.sent.filter((m) => m.to === APPLICANT.email && linkIn(m.text, 'decide')).at(-1);
  assert.ok(decision, 'the decision page link reached Dana');
  await goTo(et('2026-11-19', '14:10'));
  const dToken = linkIn(decision.text, 'decide');
  const view = await call('api/c/decide/route', 'GET', { path: `/api/c/decide?token=${dToken}` });
  assert.equal(view.status, 200, JSON.stringify(view.json));
  const start = await call('api/c/decide/route', 'POST', { path: '/api/c/decide', body: { token: dToken, action: 'start' } });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  const s27 = await snap('27', 'converted', 'Dana presses Start: Ridgeline IT becomes a client on Starter. The month-one invoice goes out.');
  assert.equal(s27.row.state, 'converted');
  assert.equal(s27.row.simple.label, 'Finished — became a client');
  assert.equal(steps.at(-1).alerts.find((a) => a.key === 'converted').title, 'Converted: Ridgeline IT on Starter');
  // The money lands a few days later; the owner presses the to-do.
  await goTo(colombo('2026-11-24', '09:00'));
  const paidTodo = (await hubLooks()).board.todos.find((t) => t.id === `invoice:${clientId}`);
  assert.ok(paidTodo, 'a to-do to mark the invoice paid');
  const paid = await call('api/mc/clients/[id]/route', 'POST', { path: paidTodo.action.path, params: { id: clientId }, body: paidTodo.action.body });
  assert.equal(paid.status, 200, JSON.stringify(paid.json));
  const s28 = await snap('28', 'paid', 'The money lands; the owner marks the invoice paid. The trial pair keeps sending for the new client until the plan’s inboxes are added.');
  assert.equal(s28.row.simple.next, 'Nothing for you');

  // ── The whole run ─────────────────────────────────────────────────────────
  if (process.env.JOURNEY_REPORT) writeReport(process.env.JOURNEY_REPORT);
  const every = await allAlerts();
  // Journey fix: a CheapInboxes domain never raises the daily false "DNS record wrong".
  assert.deepEqual(every.filter((a) => a.key === 'dns_fail').map((a) => a.title), []);
  // Journey fix: normal silence is not an emergency (no "no replies" stop on a healthy campaign).
  assert.deepEqual(every.filter((a) => a.key === 'emergency').map((a) => a.title), []);
  // Journey fix: the Monday digest carries the owner's own date (a Monday).
  for (const a of every.filter((x) => x.key === 'monday_digest')) {
    const d = a.title.match(/\d{4}-\d{2}-\d{2}/)[0];
    assert.equal(new Date(`${d}T12:00:00Z`).getUTCDay(), 1, a.title);
  }
  // No alert title shows the id where the name belongs.
  assert.deepEqual(every.filter((a) => a.clientId === clientId && / ridgelineit\b/.test(a.title)).map((a) => a.title), []);
  // Every automatic email to Dana went at a sensible hour for her (8 am – 8 pm) — except what the owner's own
  // button sent and the hot leads, which go the minute a prospect writes (speed decides those).
  const night = sim.sent.filter((m) => m.to === APPLICANT.email && !/book your onboarding call|^Hot —/.test(m.subject || '') && (hourOf(m.at) < 8 || hourOf(m.at) >= 20));
  assert.deepEqual(night.map((m) => `${m.at} ${m.subject}`), [], 'no email to the client at night');
  // New cold emails (the sequence's first touches; answers to a prospect who wrote go at once, any hour) only on
  // US business days, 9–5 their time (all leads are Eastern) — across the clock change on 1 November and never
  // on Veterans Day (11 November).
  const cold = sim.sent.filter((m) => m.from.endsWith('@getridgelineit.com') && m.headers?.['List-Unsubscribe'] && !/^Re:/i.test(m.subject || ''));
  assert.ok(cold.length > 200, `${cold.length} new cold emails`);
  const etDay = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(iso));
  const etWeekday = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date(iso));
  assert.deepEqual(cold.filter((m) => hourOf(m.at) < 9 || hourOf(m.at) >= 17 || ['Sat', 'Sun'].includes(etWeekday(m.at)) || etDay(m.at) === '2026-11-11').map((m) => `${m.at} ${m.subject} → ${m.to}`), []);
  assert.ok(cold.some((m) => etDay(m.at) === '2026-11-02' && hourOf(m.at) === 9), 'after the clock change the first sends are still at 9 am Eastern');
  assert.deepEqual(world.unknown, [], 'the machine only talked to the world it knows');
  assert.equal(world.ci.forbidden.length, 0);
});
