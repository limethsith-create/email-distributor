// The owner's complete test: TWO applicants from the website to a month of
// sending and the money, side by side, through the real route handlers.
//
// - Harbor Dental Group applies on the website for a free TRIAL (POST /api/apply).
// - Summit Roofing Co asks for the paid GROWTH plan on the website (POST /api/inquiry).
//
// The owner says yes to both in the hub, the onboarding calls are booked
// (one through the reply bot + booking page, one through the Calendar), held,
// the onboarding pages and agreements are filled, the owner buys each client's
// domain + inboxes in his CheapInboxes account and the machine connects them
// (each client's logins land in THAT client's inbox records only), warm-up
// runs with the owner's helpers, the launch calls approve the lists and the
// emails, and the machine sends for a month. Prospects reply (interested,
// question, not now, out of office, bounce, unsubscribe…); the reply bot
// answers what it should and hands the interested ones over; a prospect books.
// Each client writes to the owner through the onboarding Gmail and the owner
// answers from the hub. Money: Summit's Growth invoice is issued and paid;
// Harbor's trial ends, Harbor presses Start, the invoice is issued and paid.
// At the end the hub, the trial detail, growth and the client dashboards agree.
//
// The world is tests/journey-world.mjs (a simulated clock, fake SMTP / IMAP /
// Google / CheapInboxes / DNS / websites); nothing leaves the machine.
//
// DEMO_STATE=1 rewrites tests/fixtures/demo-state.json: the final Redis state
// of the two clients, which POST /api/mc/demo {action:'load'} replays into the
// real hub (src/lib/systems/demo.js). A normal run checks the fixture still
// has the same keys this run produced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kv, __reset, __dump } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { getClient } from '@/lib/db/client';
import { getLeads } from '@/lib/db/leads';
import { getInboxRecords } from '@/lib/db/inboxes';
import { decrypt } from '@/lib/crypto';
import { trialDay } from '@/lib/time';
import {
  sim, world, clock, et, colombo, installJourney, call, deliver, sentSince, linkIn,
  OWNER, GOOGLE, CI_KEY, addApplicantSite,
  ownerBuysInCheapInboxes, cheapInboxesDomainReady, cheapInboxesMailboxesReady, cheapInboxesWebhook,
} from './journey-world.mjs';
import { exportDemoState, exportDemoPart, DEMO } from '@/lib/systems/demo';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO_FIXTURE = path.join(HERE, 'fixtures', 'demo-state.json');

// ── the two applicants and their websites ────────────────────────────────────

const page = (brand, title, body) => `<!doctype html><html><head><title>${title}</title><meta name="description" content="${brand}"></head><body><nav><a href="/">Home</a> <a href="/about">About</a> <a href="/services">Services</a> <a href="/team">Team</a> <a href="/contact">Contact</a></nav><main>${body}</main><footer>© 2026 ${brand}</footer></body></html>`;

const HARBOR = {
  key: 'harbor', company: 'Harbor Dental Group', person: 'Megan Ortiz', first: 'Megan', email: 'megan@harbordentalgroup.com',
  domain: 'harbordentalgroup.com', site: 'https://www.harbordentalgroup.com', city: 'Portland, ME', plan: 'trial',
};
const SUMMIT = {
  key: 'summit', company: 'Summit Roofing Co', person: 'Jordan Blake', first: 'Jordan', email: 'jordan@summitroofingco.com',
  domain: 'summitroofingco.com', site: 'https://www.summitroofingco.com', city: 'Denver, CO', plan: 'growth',
};
const BOTH = [HARBOR, SUMMIT];

function addSites() {
  const hb = (t, b) => page('Harbor Dental Group', t, b);
  addApplicantSite(HARBOR.domain, {
    site: HARBOR.site, ip: '34.117.60.10', registered: '2009-05-11T12:00:00Z',
    pages: {
      '/': hb('Harbor Dental Group | Workplace dental care for Maine employers', '<h1>Dental care that comes to your workplace</h1><p>On-site dental days and workplace dental plans for employers with 50–500 staff in Maine and New Hampshire.</p><a href="/employers">For employers</a>'),
      '/about': hb('About Harbor Dental Group', '<h1>About us</h1><p>Founded in 2009 in Portland, Maine. Six dentists, twelve hygienists and a mobile clinic. We look after 40 employers across Maine and New Hampshire.</p>'),
      '/services': hb('Services | Harbor Dental Group', '<h1>Services</h1><ul><li>On-site dental days</li><li>Workplace dental plans</li><li>Family dentistry</li></ul>'),
      '/employers': hb('For employers | Harbor Dental Group', '<h1>For HR teams</h1><p>Fewer sick days, happier staff. We bring cleanings and check-ups to your office twice a year.</p>'),
      '/team': hb('Our team | Harbor Dental Group', '<h1>Our team</h1><h3>Dr. Alan Reyes</h3><p>Founder</p><h3>Megan Ortiz</h3><p>Practice Growth Manager</p>'),
      '/contact': hb('Contact | Harbor Dental Group', '<h1>Contact</h1><p>120 Commercial St, Portland, ME 04101</p><p>(207) 555-0190</p>'),
    },
    txt: { [HARBOR.domain]: [['v=spf1 include:_spf.google.com ~all']], [`_dmarc.${HARBOR.domain}`]: [['v=DMARC1; p=none']] },
    mx: { [HARBOR.domain]: [{ exchange: 'aspmx.l.google.com', priority: 1 }] },
    place: { name: 'Harbor Dental Group', category: 'Dental clinic', address: '120 Commercial St, Portland, ME 04101, USA', rating: 4.9, reviews: 212, phone: '(207) 555-0190', cid: 7101 },
    competitors: [
      { name: 'Casco Bay Dental', category: 'Dental clinic', address: '5 Fore St, Portland, ME 04101, USA', rating: 4.7, reviews: 180, web: 'https://www.cascobaydental.com/', cid: 7102 },
      { name: 'Back Cove Smiles', category: 'Dental clinic', address: '90 Baxter Blvd, Portland, ME 04101, USA', rating: 4.8, reviews: 95, web: 'https://www.backcovesmiles.com/', cid: 7103 },
    ],
  });
  const sr = (t, b) => page('Summit Roofing Co', t, b);
  addApplicantSite(SUMMIT.domain, {
    site: SUMMIT.site, ip: '34.117.60.20', registered: '2014-02-03T12:00:00Z',
    pages: {
      '/': sr('Summit Roofing Co | Commercial roofing in Denver', '<h1>Commercial roofs that last</h1><p>Roof inspections, repairs and maintenance plans for property managers and HOAs across the Denver metro.</p>'),
      '/about': sr('About Summit Roofing Co', '<h1>About us</h1><p>Family-owned since 2014, 28 people, GAF Master Elite. We look after 300 commercial roofs in Colorado.</p>'),
      '/services': sr('Services | Summit Roofing Co', '<h1>Services</h1><ul><li>Roof inspections</li><li>Maintenance plans</li><li>Hail damage repair</li></ul>'),
      '/team': sr('Team | Summit Roofing Co', '<h1>Team</h1><h3>Jordan Blake</h3><p>Owner</p>'),
      '/contact': sr('Contact | Summit Roofing Co', '<h1>Contact</h1><p>4400 Brighton Blvd, Denver, CO 80216</p><p>(303) 555-0133</p>'),
    },
    txt: { [SUMMIT.domain]: [['v=spf1 include:spf.protection.outlook.com -all']] },
    mx: { [SUMMIT.domain]: [{ exchange: 'summitroofingco-com.mail.protection.outlook.com', priority: 0 }] },
    place: { name: 'Summit Roofing Co', category: 'Roofing contractor', address: '4400 Brighton Blvd, Denver, CO 80216, USA', rating: 4.8, reviews: 143, phone: '(303) 555-0133', cid: 8101 },
    competitors: [
      { name: 'Front Range Roofing', category: 'Roofing contractor', address: '10 Blake St, Denver, CO 80202, USA', rating: 4.6, reviews: 320, web: 'https://www.frontrangeroofing.com/', cid: 8102 },
    ],
  });
}

// ── the Test run's live trial: Harbor on its Day 12, renamed Lakeview Physical Therapy ──

/** Every name in Harbor's snapshot changed consistently: the client, its trade, its people and its prospects. */
function lakeviewPart(harbor, dump, now) {
  const words = [
    ['Harbor Dental Group', 'Lakeview Physical Therapy'], ['Harbor Dental', 'Lakeview PT'], ['harbor-dental', 'lakeview-pt'], ['harborhq', 'lakeviewhq'],
    ['Dr. Alan Reyes', 'Dr. Paul Novak'], ['Alan Reyes', 'Paul Novak'], ['Megan Ortiz', 'Dana Whitfield'], ['megan.ortiz', 'dana.whitfield'], ['Megan', 'Dana'], ['megan', 'dana'], ['Ortiz', 'Whitfield'],
    ['workplace dental care', 'on-site physical therapy'], ['dental check-ups and cleanings', 'physical therapy and injury screenings'],
    ['On-site dental days', 'On-site PT days'], ['on-site dental days', 'on-site PT days'], ['on-site dental day', 'on-site PT day'],
    ['Workplace dental plans', 'Workplace injury-prevention plans'], ['workplace dental plans', 'workplace injury-prevention plans'],
    ['Family dentistry', 'Sports rehab'], ['dentists', 'physical therapists'], ['hygienists', 'athletic trainers'], ['Dental clinic', 'Physical therapy clinic'],
    ['cleanings', 'screenings'], ['check-ups', 'screenings'], ['Dental', 'Physical Therapy'], ['dental', 'physical therapy'], ['Harbor', 'Lakeview'], ['harbor', 'lakeview'],
  ];
  // Its prospects: other companies and other people (a fixed one-to-one swap, so every mention agrees).
  const swap = (a, b) => new Map(a.map((x, i) => [x, b[i]]));
  const FIRSTS = swap(['Alan', 'Beth', 'Carl', 'Dina', 'Evan', 'Faye', 'Glen', 'Hana', 'Ivan', 'Jill', 'Kyle', 'Lena', 'Mark', 'Nora', 'Owen', 'Pia', 'Reid', 'Sara', 'Tate', 'Vera'],
    ['Brian', 'Clara', 'Derek', 'Elena', 'Frank', 'Grace', 'Henry', 'Irene', 'Jason', 'Karen', 'Leo', 'Maria', 'Nathan', 'Olivia', 'Peter', 'Rosa', 'Simon', 'Tina', 'Victor', 'Wendy']);
  const LASTS = swap(['Adams', 'Brooks', 'Chen', 'Dalton', 'Ellis', 'Foster', 'Grant', 'Hayes', 'Irwin', 'Jensen', 'Keller', 'Lowe', 'Mercer', 'Nash', 'Okafor', 'Price', 'Quinn', 'Rivera', 'Shaw', 'Tran', 'Upton', 'Vance', 'Webb'],
    ['Bishop', 'Carver', 'Doyle', 'Everett', 'Fischer', 'Gibson', 'Holland', 'Ingram', 'Jordan', 'Kramer', 'Lambert', 'Moreno', 'Norris', 'Osborne', 'Patel', 'Ramsey', 'Sutton', 'Tucker', 'Vaughn', 'Walsh', 'Young', 'Zimmer', 'Barker']);
  const NAMES2 = swap(['Granite', 'Bayview', 'Northgate', 'Cedar', 'Atlantic', 'Pinecrest', 'Riverside', 'Keystone', 'Maplewood', 'Ironwood', 'Lighthouse', 'Coastal', 'Birchwood', 'Stonebridge', 'Oakridge', 'Westbrook', 'Fairfield', 'Evergreen', 'Silverline', 'Redwood', 'Clearwater', 'Highland', 'Brightside', 'Meridian', 'Blue Ridge', 'Willowbrook', 'Falcon', 'Copperline', 'Liberty', 'Frontier'],
    ['Pioneer', 'Crestview', 'Southport', 'Aspen', 'Pacific', 'Hillcrest', 'Lakeshore', 'Cornerstone', 'Elmwood', 'Driftwood', 'Beacon', 'Tidewater', 'Rosewood', 'Millbrook', 'Ridgeline', 'Eastgate', 'Greenfield', 'Sequoia', 'Goldline', 'Sycamore', 'Brookside', 'Lowland', 'Sunnyside', 'Horizon', 'Green Valley', 'Foxhollow', 'Osprey', 'Ironline', 'Heritage', 'Pathway']);
  const leads = dump.get(`client:${harbor.id}:leads`);
  const people = [];
  for (const [email, raw] of leads) {
    const l = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const [first, last] = String(l.name || '').split(' ');
    const nf = FIRSTS.get(first);
    const nl = LASTS.get(last);
    const pre = [...NAMES2.keys()].find((k) => String(l.company || '').startsWith(`${k} `));
    if (!nf || !nl || !pre) continue;
    const company = `${NAMES2.get(pre)}${l.company.slice(pre.length)}`;
    const host = `${company.toLowerCase().replace(/[^a-z]/g, '')}.com`;
    const oldHost = email.split('@')[1];
    people.push([email, `${nf.toLowerCase()}@${host}`], [oldHost, host], [l.company, company], [l.name, `${nf} ${nl}`]);
  }
  for (const [a, b] of FIRSTS) people.push([`${a},`, `${b},`], [`Hi ${a}`, `Hi ${b}`], [`${a} —`, `${b} —`], [`, ${a}.`, `, ${b}.`]);
  const part = exportDemoPart([[harbor.id, DEMO.lakeview]], { dump, now, before: [[harbor.domain, 'lakeviewpt.com'], [SUMMIT.domain, 'summitroofing.com'], [SUMMIT.id, DEMO.summit]], words: [...words, ...people], meetingPrefix: 'mdlake' });
  // The bare first / last names on the lead records.
  const rec = part.keys[`client:${DEMO.lakeview}:leads`];
  for (const l of Object.values(rec?.v || {})) {
    if (FIRSTS.has(l.first_name)) l.first_name = FIRSTS.get(l.first_name);
    if (LASTS.has(l.last_name)) l.last_name = LASTS.get(l.last_name);
  }
  return part;
}

// ── the hub, as the owner sees it ────────────────────────────────────────────

const rowOf = (board, id) => board.stages.flatMap((s) => s.clients).find((r) => r.id === id) || null;
const hubBoard = async () => (await call('api/mc/hub/route', 'GET', { path: '/api/mc/hub' })).json;
const hubDetail = async (id) => (await call('api/mc/hub/[id]/route', 'GET', { path: `/api/mc/hub/${id}`, params: { id } })).json;
async function hubLooks() {
  const check = (await call('api/mc/onboard-calls/check/route', 'POST', { path: '/api/mc/onboard-calls/check' })).json;
  const board = await hubBoard();
  const out = { check, board };
  for (const c of BOTH) if (c.id) out[c.key] = { row: rowOf(board, c.id), detail: await hubDetail(c.id) };
  return out;
}
const SECRETS = [CI_KEY, GOOGLE.clientSecret, GOOGLE.refresh, 'abcd efgh ijkl mnop', 'wxyz abcd efgh ijkl', 'app-pw-owner', 'journey-cron', 'journey-leadfinder'];
function noSecrets(what, look) {
  const text = JSON.stringify(look);
  assert.deepEqual(SECRETS.filter((s) => text.includes(s)), [], `${what}: a secret is in a hub answer`);
  assert.ok(!/passwordEnc|loginPasswordEnc|apiKeyEnc|webhookSecretEnc|refreshToken/i.test(text), `${what}: an encrypted field name is in a hub answer`);
}

const mailTo = (c, since = 0) => sim.sent.slice(since).filter((m) => m.to === c.email);
const hourIn = (tz, iso) => Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date(iso))) % 24;
/** A client opens every email to them so far (Gmail loads the pixel through its proxy). */
const opened = new Set();
async function readsMail(c, { olderThanMs = 0 } = {}) {
  for (const m of sim.sent) {
    if (m.to !== c.email || opened.has(m.messageId) || clock.now.getTime() - Date.parse(m.at) < olderThanMs) continue;
    opened.add(m.messageId);
    const src = /src="([^"]+\/api\/track\/open\?t=[^"]+)"/.exec(m.html || '')?.[1]?.replace(/&amp;/g, '&');
    if (!src) continue;
    const u = new URL(src);
    assert.equal((await call('api/track/open/route', 'GET', { path: u.pathname + u.search, headers: { 'user-agent': 'Mozilla/5.0 (via ggpht.com GoogleImageProxy)' } })).status, 200);
  }
}
const TRIAL_WORDS = /\b(trial|30-day|free 30|Day 30|day 29)\b/i;

// ── the run ──────────────────────────────────────────────────────────────────

test('two clients, trial + paying: website → yes → setup → warm-up → a month of sending → money, all in the hub', { timeout: 3_600_000 }, async () => {
  __reset();
  installJourney({ seed: 20261002 });
  addSites();

  // ── 0. The owner's one-time setup (as in the journey) ─────────────────────
  clock.set(colombo('2026-10-01', '10:00'));
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
  await setting('VERIFY.services.reoon.daily', 5000);
  assert.equal((await call('api/mc/google/route', 'POST', { body: { action: 'saveClient', clientId: GOOGLE.clientId, clientSecret: GOOGLE.clientSecret } })).status, 200);
  const connect = await call('api/mc/google/route', 'POST', { body: { action: 'connect' } });
  const gstate = new URL(connect.json.url).searchParams.get('state');
  assert.equal((await call('api/google/callback/route', 'GET', { path: `/api/google/callback?state=${encodeURIComponent(gstate)}&code=owner-said-allow&scope=${encodeURIComponent('https://www.googleapis.com/auth/calendar.events openid email')}` })).status, 303);
  const ci = await call('api/mc/cheapinboxes/route', 'POST', { body: { action: 'saveKey', apiKey: CI_KEY } });
  assert.equal(ci.status, 200, JSON.stringify(ci.json));

  // ── 1. Both apply on the website ──────────────────────────────────────────
  clock.set(et('2026-10-01', '15:40'));
  const harborForm = {
    source: 'website', name: HARBOR.person, email: 'Megan@HarborDentalGroup.com', website: `${HARBOR.site}/`, city: HARBOR.city,
    sell: 'On-site dental days and workplace dental plans for employers with 50–500 staff in Maine and New Hampshire',
    value: '$5,000–$20,000', capacity: '5–10 a week', strangers: 'Yes — cold buyers already', calendar: 'Yes',
    then: 'Move to Starter', notes: 'HR managers are hard to reach by phone.', agree: true, proof: ['Intro to one peer'],
  };
  const a1 = await call('api/apply/route', 'POST', { path: '/api/apply', body: harborForm, headers: { 'x-forwarded-for': '71.1.2.3', origin: 'https://www.aviance.online' } });
  assert.equal(a1.status, 200, JSON.stringify(a1.json));
  assert.equal(a1.json.outcome, 'review');
  HARBOR.id = await kv.hget(K.mainDomainIndex(), HARBOR.domain);
  assert.ok(HARBOR.id, 'Harbor is saved under its domain');

  clock.set(et('2026-10-01', '16:05'));
  const a2 = await call('api/inquiry/route', 'POST', { path: '/api/inquiry', headers: { 'x-forwarded-for': '73.9.8.7', origin: 'https://www.aviance.online' }, body: {
    name: SUMMIT.person, email: SUMMIT.email, company: SUMMIT.company, website: SUMMIT.site, plan: 'growth',
    sells: 'Commercial roof inspections and maintenance plans for property managers and HOAs in the Denver metro',
  } });
  assert.equal(a2.status, 200, JSON.stringify(a2.json));
  SUMMIT.id = await kv.hget(K.mainDomainIndex(), SUMMIT.domain);
  assert.ok(SUMMIT.id, 'Summit is saved under its domain (a paid application)');
  assert.notEqual(HARBOR.id, SUMMIT.id);

  const l1 = await hubLooks();
  noSecrets('applied', l1);
  const hr = l1.harbor.row;
  const sr = l1.summit.row;
  assert.equal(hr.state, 'applied');
  assert.equal(hr.plan, 'trial', 'Harbor is in the Trials list');
  assert.equal(sr.state, 'applied');
  assert.equal(sr.plan, 'growth', 'Summit is in the Paying clients list');
  for (const [c, look] of [[HARBOR, l1.harbor], [SUMMIT, l1.summit]]) {
    assert.ok(look.row.fitScore && Number.isFinite(look.row.fitScore.score), `${c.company}: a match % on the row: ${JSON.stringify(look.row.fitScore)}`);
    assert.equal(look.row.simple.needsYou, true, `${c.company}: review it`);
    assert.ok(look.row.todo.some((t) => t.id === `review:${c.id}`), `${c.company}: a review to-do`);
    assert.ok(look.detail.application, `${c.company}: the application is in the detail`);
    assert.equal(look.detail.application.research?.status, 'done', `${c.company}: research done`);
  }
  assert.equal(l1.summit.detail.application.answers.find((a) => a.q === 'Plan they asked for').a, 'Growth');
  assert.equal(l1.board.machine.activeTrials, 0);
  assert.equal(mailTo(HARBOR).length + mailTo(SUMMIT).length, 0, 'nothing reaches an applicant before the owner decides');


  // ── 2. The owner says yes to both (Friday morning in Colombo) ─────────────
  clock.set(colombo('2026-10-02', '09:00'));
  let mark = sim.sent.length;
  const accepted = {};
  for (const c of BOTH) {
    const yes = await call('api/mc/clients/[id]/intake/route', 'POST', { path: `/api/mc/clients/${c.id}/intake`, params: { id: c.id }, body: { action: 'approveApplication' } });
    assert.equal(yes.status, 200, `${c.company}: ${JSON.stringify(yes.json)}`);
    assert.equal(yes.json.outcome, 'onboarding', c.company);
    const got = mailTo(c, mark);
    assert.equal(got.length, 1, `${c.company}: exactly one email on a yes`);
    assert.equal(got[0].from, OWNER.inbox, 'from the onboarding Gmail');
    assert.match(got[0].subject, /book your onboarding call/);
    assert.ok(linkIn(got[0].text, 'onboard'), 'the onboarding page link');
    assert.ok(linkIn(got[0].text, 'book'), 'the booking page link');
    assert.match(got[0].text, new RegExp(`^Hi ${c.first},`));
    accepted[c.key] = got[0];
    mark = sim.sent.length;
  }
  assert.match(accepted.harbor.text, /free 30-day trial for Harbor Dental Group/, 'trial wording for the trial client');
  assert.match(accepted.summit.text, /on the Growth plan/, 'plan wording for the paying client');
  assert.doesNotMatch(`${accepted.summit.subject}\n${accepted.summit.text}`, TRIAL_WORDS, 'no trial words to the paying client');
  for (const c of BOTH) await readsMail(c);
  const l2 = await hubLooks();
  for (const c of BOTH) {
    assert.equal(l2[c.key].row.state, 'onboarding', c.company);
    assert.equal(l2[c.key].row.simple.needsYou, false, `${c.company}: ${JSON.stringify(l2[c.key].row.todo)}`);
    assert.equal(l2[c.key].detail.onboardCall.status, 'sent');
  }
  assert.equal(l2.board.machine.activeTrials, 1, 'only the trial counts against the 3-trial cap');
  // The website request behind the paid application is answered too: no longer "new" in Inquiries.
  assert.equal(l2.board.inquiries.counts.new, 0, JSON.stringify(l2.board.inquiries));
  assert.equal(l2.board.inquiries.latest.find((q) => q.clientId === SUMMIT.id)?.status, 'contacted');
  for (const c of BOTH) assert.equal(l2[c.key].row.demo, false, 'a real client is not a test-run one');

  // ── 3. The onboarding calls ───────────────────────────────────────────────
  // Harbor answers the email "what times work?"; the hub's check reads the onboarding Gmail and the reply bot answers.
  clock.set(et('2026-10-02', '09:05'));
  const accId = accepted.harbor.messageId.replace(/[<>]/g, '').toLowerCase();
  const herAsk = deliver(OWNER.inbox, { from: HARBOR.email, fromName: HARBOR.person, to: [OWNER.inbox], subject: `Re: ${accepted.harbor.subject}`, text: `Hi Limeth,\n\nThanks! What times work for you next week?\n\nMegan\n\nOn Fri, Oct 2, 2026 Limeth Sith <${OWNER.inbox}> wrote:\n> Good news`, threadIds: [accId], inReplyTo: [accId], references: [accId], date: clock.iso() });
  clock.set(et('2026-10-02', '09:10'));
  mark = sim.sent.length;
  const l3 = await hubLooks();
  const bot1 = mailTo(HARBOR, mark);
  assert.equal(bot1.length, 1, 'one answer from the reply bot');
  assert.equal(bot1[0].from, OWNER.inbox);
  assert.equal(bot1[0].inReplyTo, herAsk.messageId, 'in her thread');
  assert.equal((bot1[0].text.match(/^• /gm) || []).length, 3, 'three free times');
  assert.equal(l3.harbor.detail.conversation.thread.at(-1).rule, 'wants_time');
  assert.equal(l3.harbor.row.simple.label, 'Accepted — the reply bot answered, waiting for them to pick a time');

  /** A person opens a booking page and picks the first offered time on or after `want` (their zone). */
  const pickTime = async (c, token, want, tz) => {
    const pg = await call('c/[token]/book/route', 'GET', { path: `/c/${token}/book`, params: { token } });
    assert.equal(pg.status, 200);
    const offered = [...pg.text.matchAll(/name="start" value="([^"]+)"/g)].map((m) => m[1]).sort();
    const start = offered.find((x) => x >= want.toISOString());
    assert.ok(start, `${c.company}: a time on or after ${want.toISOString()} (${offered.length} offered)`);
    const r = await call('api/c/book/route', 'POST', { path: '/api/c/book', form: { token, tz, start } });
    assert.equal(r.status, 303);
    assert.match(r.headers.get('location'), /flash=sent/);
    return start;
  };
  /** The owner says yes to a client's request in the Calendar. */
  const ownerConfirms = async (c) => {
    const cal = (await call('api/mc/calendar/route', 'GET', { path: '/api/mc/calendar' })).json;
    const req = cal.requests.find((m) => m.clientId === c.id);
    assert.ok(req, `${c.company}: a request in the Calendar`);
    const r = await call('api/mc/calendar/route', 'POST', { path: '/api/mc/calendar', body: { action: 'confirm', id: req.id } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.match(r.json.meeting.meetLink, /^https:\/\/meet\.google\.com\//);
    return { id: req.id, meetLink: r.json.meeting.meetLink };
  };

  clock.set(et('2026-10-02', '10:02'));
  const harborCall = await pickTime(HARBOR, linkIn(bot1[0].text, 'book'), et('2026-10-06', '11:00'), 'America/New_York');
  // Summit books straight from the acceptance email's booking link (Mountain time).
  clock.set(et('2026-10-02', '12:30'));
  const summitCall = await pickTime(SUMMIT, linkIn(accepted.summit.text, 'book'), et('2026-10-07', '12:00'), 'America/Denver');
  const l3b = await hubLooks();
  for (const c of BOTH) assert.equal(l3b[c.key].row.simple.needsYou, true, `${c.company}: say yes in the Calendar`);
  clock.set(colombo('2026-10-02', '20:00'));
  mark = sim.sent.length;
  const calls = { harbor: await ownerConfirms(HARBOR), summit: await ownerConfirms(SUMMIT) };
  for (const c of BOTH) {
    const conf = mailTo(c, mark);
    assert.equal(conf.length, 1, `${c.company}: one confirmation`);
    assert.ok(conf[0].icalEvent && conf[0].text.includes(calls[c.key].meetLink), 'the invite and the Meet link');
  }
  assert.equal(world.google.events.size, 2);
  const l3c = await hubLooks();
  assert.equal(l3c.harbor.detail.onboardCall.status, 'booked');
  assert.equal(l3c.harbor.detail.onboardCall.bookedFor, harborCall);
  assert.equal(l3c.summit.detail.onboardCall.bookedFor, summitCall);
  // The calls happen; the owner marks each done in the Calendar.
  clock.set(new Date(Date.parse(harborCall) + 40 * 60e3));
  mark = sim.sent.length;
  assert.equal((await call('api/mc/calendar/route', 'POST', { path: '/api/mc/calendar', body: { action: 'held', id: calls.harbor.id } })).status, 200);
  assert.deepEqual(mailTo(HARBOR, mark).map((m) => m.subject), ['Your trial — what happens now']);
  clock.set(new Date(Date.parse(summitCall) + 40 * 60e3));
  mark = sim.sent.length;
  assert.equal((await call('api/mc/calendar/route', 'POST', { path: '/api/mc/calendar', body: { action: 'held', id: calls.summit.id } })).status, 200);
  const summitPlan = mailTo(SUMMIT, mark);
  assert.deepEqual(summitPlan.map((m) => m.subject), ['What happens now']);
  assert.doesNotMatch(summitPlan[0].text, TRIAL_WORDS, 'the paying client’s plan email has no trial words');

  for (const c of BOTH) await readsMail(c);
  // ── 4. The onboarding pages and the agreements ────────────────────────────
  const FIELDS = {
    harbor: {
      companyName: HARBOR.company, senderName: HARBOR.person, senderTitle: 'Practice Growth Manager', senderPrefix: 'megan',
      calendarUrl: 'https://cal.com/harbor-dental/intro', postalAddress: '120 Commercial St, Portland, ME 04101', hotLeadEmail: HARBOR.email,
      suppressCustomers: 'idexx.com\nL.L.Bean', competitors: 'Casco Bay Dental',
      sellsTo: 'We bring dental check-ups and cleanings to workplaces for employers with 50–500 staff in Maine and New Hampshire.',
      proofLine: 'We look after 40 employers across Maine and New Hampshire.',
      defaultNiche: 'workplace dental care', defaultIcp: 'HR directors at mid-size employers', industry: 'manufacturing, healthcare, professional services',
      cities: 'Portland, ME\nBangor, ME\nManchester, NH', states: 'ME, NH', sizeMin: '50', sizeMax: '500',
      titles: 'HR Director\nHR Manager\nOffice Manager\nCEO', excludedTitles: 'Intern',
      dreamCustomers: [{ name: 'WEX', website: 'wexinc.com' }, { name: 'Hannaford', website: 'hannaford.com' }, { name: 'Unum', website: 'unum.com' }],
      capacityPerWeek: '5', winCondition: 'Three employers asking for an on-site dental day.',
    },
    summit: {
      companyName: SUMMIT.company, senderName: SUMMIT.person, senderTitle: 'Owner', senderPrefix: 'jordan',
      calendarUrl: 'https://cal.com/summit-roofing/inspection', postalAddress: '4400 Brighton Blvd, Denver, CO 80216', hotLeadEmail: SUMMIT.email,
      suppressCustomers: 'Pinnacle Property Management', competitors: 'Front Range Roofing',
      sellsTo: 'We inspect and maintain commercial roofs for property managers and HOAs across the Denver metro.',
      proofLine: 'We look after 300 commercial roofs in Colorado.',
      defaultNiche: 'commercial roofing', defaultIcp: 'property managers and HOA boards', industry: 'property management, real estate',
      cities: 'Denver, CO\nAurora, CO\nLakewood, CO', states: 'CO', sizeMin: '5', sizeMax: '200',
      titles: 'Property Manager\nFacilities Manager\nHOA Board President\nOwner', excludedTitles: 'Leasing Agent',
      dreamCustomers: [{ name: 'Greystar', website: 'greystar.com' }, { name: 'FirstService Residential', website: 'fsresidential.com' }, { name: 'Lincoln Property', website: 'lpc.com' }],
      capacityPerWeek: '8', winCondition: 'Ten roof inspections booked a month.',
    },
  };
  mark = sim.sent.length;
  for (const c of BOTH) {
    clock.advance(20 * 60e3);
    const token = linkIn(accepted[c.key].text, 'onboard');
    const onboard = (body) => call('api/c/onboard/route', 'POST', { path: '/api/c/onboard', body: { token, ...body }, headers: { 'x-forwarded-for': '98.24.1.7' } });
    const loaded = await onboard({ action: 'load' });
    assert.equal(loaded.status, 200, JSON.stringify(loaded.json));
    const saved = await onboard({ action: 'save', fields: FIELDS[c.key] });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.deepEqual(saved.json.errors, {}, c.company);
    const signed = await onboard({ action: 'accept', name: c.person, title: FIELDS[c.key].senderTitle, agree: true });
    assert.equal(signed.status, 200, JSON.stringify(signed.json));
    assert.equal((await getClient(c.id)).state, 'awaiting_purchase', `${c.company}: the market count passed`);
  }
  for (const m of mailTo(SUMMIT, mark)) assert.doesNotMatch(`${m.subject}\n${m.text}`, TRIAL_WORDS, `no trial words to the paying client: “${m.subject}”`);
  const l4 = await hubLooks();
  noSecrets('agreements', l4);
  for (const c of BOTH) {
    assert.equal(l4[c.key].detail.autobuy.status, 'ready_to_buy', c.company);
    assert.equal(l4[c.key].row.simple.needsYou, true, `${c.company}: buy`);
  }
  // Money: the paying client is invoiced for month one when the plan agreement is signed; the trial is not.
  assert.equal(l4.harbor.detail.invoice, null, 'no invoice during a free trial');
  const summitInv = l4.summit.detail.invoice;
  assert.deepEqual([summitInv.plan, summitInv.amount, summitInv.status, summitInv.paidAt, summitInv.calls], ['growth', 3997, 'sent', null, 20], JSON.stringify(summitInv));
  const invMail = mailTo(SUMMIT, mark).find((m) => /^Invoice AV-/.test(m.subject));
  assert.ok(invMail, 'the Growth invoice reached Summit');
  assert.match(invMail.text, /Growth: \$3,997 a month for 20 guaranteed booked calls/);
  assert.match(invMail.text, /paypal\.me\/aviance\/3997USD/);
  assert.ok(l4.summit.row.todo.some((t) => t.id === `invoice:${SUMMIT.id}`), 'a to-do to mark it paid when the money lands');
  assert.deepEqual(l4.summit.row.invoice, { number: summitInv.number, amount: 3997, issuedAt: summitInv.issuedAt, paidAt: null, status: 'sent', plan: 'growth' }, 'the money is on the board row');
  assert.equal(l4.harbor.row.invoice, null);
  assert.equal((await call('api/mc/inquiries/route', 'GET', { path: '/api/mc/inquiries' })).json.inquiries.find((q) => q.clientId === SUMMIT.id).status, 'won', 'the request is won once the plan agreement is signed');

  // ── 5. The owner buys each client's domain + inboxes in CheapInboxes; the machine connects them ──
  clock.set(colombo('2026-10-08', '08:10'));
  const hook = async (event) => {
    const { raw, headers } = cheapInboxesWebhook(event);
    const r = await call('api/webhooks/cheapinboxes/route', 'POST', { path: '/api/webhooks/cheapinboxes', body: raw, headers: { 'content-type': 'application/json', ...headers } });
    assert.equal(r.status, 200);
  };
  const bought = {};
  for (const c of BOTH) {
    const buy = l4[c.key].detail.autobuy.buy;
    c.sendDomain = buy.domain;
    bought[c.key] = { buy, domainId: ownerBuysInCheapInboxes(buy.domain, buy.mailboxes) };
    clock.advance(3 * 60e3);
  }
  await hook('order.completed');
  const l5 = await hubLooks();
  for (const c of BOTH) assert.equal(l5[c.key].detail.autobuy.status, 'provisioning', `${c.company}: ${JSON.stringify(l5[c.key].detail.autobuy)}`);
  clock.set(et('2026-10-08', '02:10'));
  for (const c of BOTH) cheapInboxesDomainReady(bought[c.key].domainId);
  await hook('domain.dns_configured');
  clock.set(et('2026-10-08', '05:40'));
  for (const c of BOTH) cheapInboxesMailboxesReady(bought[c.key].domainId);
  await hook('mailbox.active');
  clock.advance(4000);
  await hook('mailbox.credentials_ready');
  const l5b = await hubLooks();
  noSecrets('connected', l5b);
  // The codes (each mailbox's login) went into EACH client's own inbox records — never mixed.
  for (const c of BOTH) {
    const recs = await getInboxRecords(c.id);
    const want = bought[c.key].buy.mailboxes.map((m) => m.email).sort();
    assert.deepEqual(recs.map((r) => r.email).sort(), want, `${c.company}: its own two inboxes`);
    for (const r of recs) {
      assert.ok(r.email.endsWith(`@${c.sendDomain}`), `${r.email} is on ${c.company}'s domain`);
      const cred = [...world.ci.creds.values()].find((x) => x.email === r.email);
      assert.ok(r.passwordEnc && !JSON.stringify(r).includes(cred.app_password), 'stored encrypted');
      assert.equal(decrypt(r.passwordEnc).replace(/\s/g, ''), cred.app_password.replace(/\s/g, ''), `${r.email}: the right login`);
      assert.equal(String(r.clientId || c.id), c.id);
    }
    assert.equal(l5b[c.key].row.state, 'warming', c.company);
    assert.equal(l5b[c.key].detail.autobuy.status, 'done');
    assert.equal(l5b[c.key].detail.inboxes.length, 2);
  }
  const other = { harbor: SUMMIT, summit: HARBOR };
  for (const c of BOTH) {
    const mine = (await getInboxRecords(c.id)).map((r) => r.email);
    const theirs = (await getInboxRecords(other[c.key].id)).map((r) => r.email);
    assert.deepEqual(mine.filter((e) => theirs.includes(e)), [], 'no inbox shared between the two clients');
  }
  assert.deepEqual((await getInboxRecords('aviance')).map((r) => r.email).filter((e) => e.endsWith(`@${HARBOR.sendDomain}`) || e.endsWith(`@${SUMMIT.sendDomain}`)), [], "none of them in the owner's own outreach");
  assert.equal(world.ci.forbidden.length, 0, 'the machine never ordered, paid or cancelled anything');

  for (const c of BOTH) await readsMail(c);
  // Summit's money lands; the owner presses the to-do (Colombo morning).
  clock.set(colombo('2026-10-09', '09:00'));
  const payTodo = (await hubBoard()).todos.find((t) => t.id === `invoice:${SUMMIT.id}`);
  assert.ok(payTodo, 'the pay to-do is on the board');
  const paidSummit = await call('api/mc/clients/[id]/route', 'POST', { path: payTodo.action.path, params: { id: SUMMIT.id }, body: payTodo.action.body });
  assert.equal(paidSummit.status, 200, JSON.stringify(paidSummit.json));
  const l5c = await hubLooks();
  assert.equal(l5c.summit.detail.invoice.status, 'paid');
  assert.ok(l5c.summit.detail.invoice.paidAt);
  assert.ok(!l5c.summit.row.todo.some((t) => t.id === `invoice:${SUMMIT.id}`));

  // ── 6. Warm-up: the owner adds 8 helper accounts; from now on the heartbeat runs ──
  clock.set(colombo('2026-10-08', '19:00'));
  const helpers = [
    ['google', 'avc.helper.one@gmail.com', 'Nadia Perera'], ['google', 'avc.helper.two@gmail.com', 'Ruwan Silva'], ['google', 'avc.helper.three@gmail.com', 'Kasun Jay'],
    ['yahoo', 'avc.helper@yahoo.com', 'Anne Fox'], ['aol', 'avc.helper@aol.com', 'Ben Cole'], ['icloud', 'avc.helper@icloud.com', 'Cara Dunn'],
    ['gmx', 'avc.helper@gmx.com', 'Dev Rao'], ['yandex', 'avc.helper@yandex.com', 'Eli Moss'],
  ];
  for (const [provider, email, displayName] of helpers) {
    const r = await call('api/mc/warmup/route', 'POST', { path: '/api/mc/warmup', body: { action: 'addHelper', provider, email, password: 'abcd efgh ijkl mnop', displayName } });
    assert.equal(r.status, 200, `${email}: ${JSON.stringify(r.json)}`);
  }
  const l6 = await hubLooks();
  for (const c of BOTH) {
    assert.equal(l6[c.key].detail.warmup.status, 'warming', `${c.company}: ${JSON.stringify(l6[c.key].detail.warmup)}`);
    assert.equal(l6[c.key].row.simple.needsYou, false, `${c.company}: ${JSON.stringify(l6[c.key].row.todo)}`);
  }

  const tick = async () => {
    const r = await call('api/cron/tick/route', 'GET', { path: '/api/cron/tick?source=cronjob', headers: { authorization: 'Bearer journey-cron' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  };
  let hooks = [];
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
  const TZ = { harbor: 'America/New_York', summit: 'America/Denver' };
  const workHours = (c, d) => { const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ[c.key], weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(d); const h = Number(p.find((x) => x.type === 'hour').value) % 24; return !['Sat', 'Sun'].includes(p.find((x) => x.type === 'weekday').value) && h >= 9 && h < 17; };
  const awake = (c, d) => { const h = hourIn(TZ[c.key], d.toISOString()); return h >= 7 && h < 22; };

  // The Lead Finder (a GitHub Actions job) posts each client's list to the webhook once it was dispatched for that client.
  const LEADS = {
    harbor: { places: [['Portland', 'ME'], ['Bangor', 'ME'], ['Manchester', 'NH']], titles: ['HR Director', 'HR Manager', 'Office Manager', 'CEO'], kind: ['Manufacturing', 'manufacturing'], kind2: ['Health Services', 'health'], emp: (n) => 60 + (n % 300) },
    summit: { places: [['Denver', 'CO'], ['Aurora', 'CO'], ['Lakewood', 'CO']], titles: ['Property Manager', 'Facilities Manager', 'HOA Board President', 'Owner'], kind: ['Property Management', 'property_management'], kind2: ['Real Estate', 'real_estate'], emp: (n) => 8 + (n % 120) },
  };
  // Real-looking prospects: 450 different companies per client (30 names × 15 trades), one person each.
  const FIRST = ['Alan', 'Beth', 'Carl', 'Dina', 'Evan', 'Faye', 'Glen', 'Hana', 'Ivan', 'Jill', 'Kyle', 'Lena', 'Mark', 'Nora', 'Owen', 'Pia', 'Reid', 'Sara', 'Tate', 'Vera'];
  const LAST = ['Adams', 'Brooks', 'Chen', 'Dalton', 'Ellis', 'Foster', 'Grant', 'Hayes', 'Irwin', 'Jensen', 'Keller', 'Lowe', 'Mercer', 'Nash', 'Okafor', 'Price', 'Quinn', 'Rivera', 'Shaw', 'Tran', 'Upton', 'Vance', 'Webb'];
  const NAMES = ['Granite', 'Bayview', 'Northgate', 'Cedar', 'Atlantic', 'Pinecrest', 'Riverside', 'Keystone', 'Maplewood', 'Ironwood', 'Lighthouse', 'Coastal', 'Birchwood', 'Stonebridge', 'Oakridge', 'Westbrook', 'Fairfield', 'Evergreen', 'Silverline', 'Redwood', 'Clearwater', 'Highland', 'Brightside', 'Meridian', 'Blue Ridge', 'Willowbrook', 'Falcon', 'Copperline', 'Liberty', 'Frontier'];
  const TRADES = {
    harbor: ['Manufacturing', 'Health Partners', 'Precision Parts', 'Medical Group', 'Foods', 'Industries', 'Care Center', 'Fabrication', 'Family Health', 'Plastics', 'Logistics', 'Components', 'Credit Union', 'Packaging', 'Insurance'],
    summit: ['Property Management', 'Realty', 'HOA Services', 'Properties', 'Management Group', 'Real Estate', 'Property Group', 'Residential', 'Commercial Properties', 'Asset Management', 'Community Management', 'Realty Partners', 'Estates', 'Property Services', 'Holdings'],
  };
  const posted = new Set();
  const leadFinder = async () => {
    for (const c of BOTH) {
      if (posted.has(c.key)) continue;
      const st = (await kv.hgetall(K.leadfinder(c.id))) || {};
      if (!st.initialAt || !world.calls.some((x) => x.kind === 'dispatch' && String(x.body || '').includes(c.id))) continue;
      posted.add(c.key);
      const L = LEADS[c.key];
      for (let b = 0; b < 5; b++) {
        const leads = Array.from({ length: 90 }, (_, i) => {
          const n = b * 90 + i;
          const [city, st2] = L.places[n % 3];
          const [, type] = n % 2 === 0 ? L.kind : L.kind2;
          const first = FIRST[n % FIRST.length];
          const last = LAST[(n * 7) % LAST.length];
          const company = `${NAMES[n % NAMES.length]} ${TRADES[c.key][Math.floor(n / NAMES.length) % 15]}`;
          const host = `${company.toLowerCase().replace(/[^a-z]/g, '')}.com`;
          return { email: `${first.toLowerCase()}@${host}`, first_name: first, name: `${first} ${last}`, title: L.titles[n % 4], company, website: `https://www.${host}`, city, state: st2, types: [type], employees: L.emp(n), riskLevel: 'safe', score: 3 };
        });
        const r = await call('api/webhooks/leadfinder/route', 'POST', { path: '/api/webhooks/leadfinder', headers: { authorization: 'Bearer journey-leadfinder' }, body: { clientId: c.id, type: 'batch', runId: `lf-${c.key}`, batchNo: b, mode: 'initial', leads, placesRequests: 30 } });
        assert.equal(r.status, 200, JSON.stringify(r.json));
      }
      const done = await call('api/webhooks/leadfinder/route', 'POST', { path: '/api/webhooks/leadfinder', headers: { authorization: 'Bearer journey-leadfinder' }, body: { clientId: c.id, type: 'done', runId: `lf-${c.key}`, mode: 'initial', found: 450, candidates: 900 } });
      assert.equal(done.status, 200, JSON.stringify(done.json));
    }
  };
  // Each client presses the booking-test link in their working hours, and reads their email (Gmail loads the pixel).
  const tested = new Set();
  const clientsAct = async (now) => {
    for (const c of BOTH) {
      if (!tested.has(c.key) && workHours(c, now)) {
        const m = sim.sent.find((x) => x.to === c.email && linkIn(x.text, 'booking-ok'));
        if (m) {
          const r = await call('api/c/booking-ok/route', 'POST', { path: '/api/c/booking-ok', body: { token: linkIn(m.text, 'booking-ok') } });
          assert.equal(r.status, 200, JSON.stringify(r.json));
          tested.add(c.key);
        }
      }
      if (awake(c, now)) await readsMail(c, { olderThanMs: 3 * 3600e3 });
    }
  };
  // The launch call: each client books from the invite in their working hours (the first time from the next day on);
  // the owner says yes in the Calendar; after the call the owner presses "Approved on the call".
  const launch = { harbor: {}, summit: {} };
  const launchActs = async (now) => {
    for (const c of BOTH) {
      const L = launch[c.key];
      if (!L.invite) L.invite = sim.sent.find((m) => m.to === c.email && m.subject === 'Your list is ready');
      if (L.invite && !L.requested && workHours(c, now)) {
        const token = linkIn(L.invite.text, 'book');
        L.requested = await pickTime(c, token, new Date(now.getTime() + 20 * 3600e3), TZ[c.key]);
      }
      if (L.requested && !L.confirmed) { L.confirmed = await ownerConfirms(c); }
      if (L.confirmed && !L.approved && now.getTime() >= Date.parse(L.requested) + 40 * 60e3) {
        const r = await call('api/mc/clients/[id]/launch-call/route', 'POST', { path: `/api/mc/clients/${c.id}/launch-call`, params: { id: c.id }, body: { action: 'approvedOnCall' } });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        L.approved = clock.iso();
      }
    }
  };
  hooks = [leadFinder, clientsAct, launchActs];

  clock.set(et('2026-10-08', '09:45'));
  await goTo(et('2026-10-15', '12:00'));
  const l7 = await hubLooks();
  for (const c of BOTH) {
    assert.equal(l7[c.key].detail.warmup.status, 'warming', c.company);
    for (const i of l7[c.key].detail.warmup.inboxes) assert.ok(i.sentToday <= i.quota, `${i.email}: ${i.sentToday} sent, quota ${i.quota}`);
    assert.ok(Number(l7[c.key].detail.leadsByStatus.unsent) >= 300, `${c.company}: the list is in (${JSON.stringify(l7[c.key].detail.leadsByStatus)})`);
  }

  // ── 7. The launch calls, and Day 1 ────────────────────────────────────────
  await goTo(et('2026-10-22', '12:00'));
  const l8 = await hubLooks();
  for (const c of BOTH) {
    const L = launch[c.key];
    assert.ok(L.invite && L.requested && L.confirmed && L.approved, `${c.company}: the launch call went through ${JSON.stringify({ invite: Boolean(L.invite), requested: L.requested, approved: L.approved })}`);
    assert.equal(L.invite.from, OWNER.inbox);
    assert.equal(l8[c.key].detail.launchCall.status, 'held', c.company);
    assert.equal(l8[c.key].detail.sequence.approvalMode, 'call');
    assert.ok(tested.has(c.key), `${c.company}: the booking test was confirmed`);
  }
  assert.doesNotMatch(launch.summit.invite.text, TRIAL_WORDS);

  // ── 8. A month of sending; prospects answer ───────────────────────────────
  const inboxesOf = async (c) => (await getInboxRecords(c.id)).map((r) => r.email);
  for (const c of BOTH) c.inboxes = await inboxesOf(c);
  const clientOf = (addr) => BOTH.find((c) => c.inboxes.includes(addr)) || null;
  const sentLeads = async (c) => (await getLeads(c.id)).filter((l) => l.sent_at && l.status === 'in_sequence' && l.original_message_id)
    // The most recently contacted first: no follow-up of theirs is due while their answer is read.
    .sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at)) || a.email.localeCompare(b.email));
  // Each client answers every hot lead in its thread, in their working hours.
  const answered = new Set();
  const clientsAnswerHotLeads = async (now) => {
    for (const m of sim.sent) {
      const c = BOTH.find((x) => x.email === m.to);
      if (!c || !/^Hot/.test(m.subject || '') || answered.has(m.messageId) || !workHours(c, now)) continue;
      answered.add(m.messageId);
      deliver(m.from, { from: c.email, subject: `Re: ${m.subject}`, text: 'On it — I will call them this afternoon.', threadIds: [m.messageId.replace(/[<>]/g, '')] });
    }
  };
  // Prospects answer like real ones: about 1 cold email in 30, a few hours to two days later.
  let seed = 11;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const KIND_TEXT = ['No thanks.', 'Not right now — maybe next quarter.', 'Do you work with companies our size?', 'Interested. What would this cost?', 'Received.'];
  const later = [];
  let coldMark = sim.sent.length;
  const scripted = new Set();
  const prospectsReply = async (now) => {
    for (const m of sim.sent.slice(coldMark)) {
      if (m.headers?.['X-Aviance-Warm'] || !clientOf(m.from) || clientOf(m.to) || BOTH.some((c) => c.email === m.to) || /^Re:/i.test(m.subject || '')) continue;
      if (rnd() >= 1 / 30) continue;
      later.push({ at: now.getTime() + (3 + rnd() * 40) * 3600e3, c: clientOf(m.from), to: m.to, text: KIND_TEXT[Math.floor(rnd() * KIND_TEXT.length)] });
    }
    coldMark = sim.sent.length;
    for (const r of later.filter((x) => !x.done && x.at <= now.getTime())) {
      r.done = true;
      if (scripted.has(r.to)) continue;
      const lead = (await getLeads(r.c.id)).find((l) => l.email === r.to);
      if (!lead || !lead.original_message_id || lead.status !== 'in_sequence') continue;
      deliver(lead.account_used, { from: lead.email, subject: `Re: ${lead.original_subject}`, text: r.text, threadIds: [lead.original_message_id.replace(/[<>]/g, '')] });
    }
  };
  hooks = [clientsAnswerHotLeads, prospectsReply, clientsAct];

  await goTo(et('2026-10-27', '10:45'));
  // Replies of every kind land in each client's inboxes.
  const TEXT = {
    interested: 'Interested — can you come and look at it next week? What does it cost?',
    question: 'Who else near us do you work with?',
    notnow: 'Not right now, maybe next quarter.',
    stop: 'STOP',
  };
  const used = { harbor: {}, summit: {} };
  const inbound = { harbor: {}, summit: {} };
  let unsubUrl = {};
  for (const c of BOTH) {
    const pool = await sentLeads(c);
    for (const kind of ['interested', 'question', 'notnow', 'ooo', 'bounce', 'stop', 'oneclick']) {
      const lead = pool.shift();
      used[c.key][kind] = lead;
      scripted.add(lead.email);
      const threadIds = [lead.original_message_id.replace(/[<>]/g, '')];
      if (kind === 'ooo') inbound[c.key][kind] = deliver(lead.account_used, { from: lead.email, subject: `Out of Office: ${lead.original_subject}`, text: 'I am out of the office until next Monday.', threadIds, kind: 'ooo' });
      else if (kind === 'bounce') inbound[c.key][kind] = deliver(lead.account_used, { from: 'mailer-daemon@googlemail.com', subject: 'Delivery Status Notification (Failure)', text: `Your message wasn't delivered to ${lead.email} because the address couldn't be found.\n\nFinal-Recipient: rfc822; ${lead.email}\nAction: failed\nStatus: 5.1.1\nDiagnostic-Code: smtp; 550 5.1.1 The email account that you tried to reach does not exist.`, threadIds, kind: 'dsn' });
      else if (kind === 'oneclick') {
        const m = sim.sent.find((x) => x.to === lead.email && x.headers?.['List-Unsubscribe']);
        unsubUrl[c.key] = /<(https?:[^>]+)>/.exec(m.headers['List-Unsubscribe'])[1];
      } else inbound[c.key][kind] = deliver(lead.account_used, { from: lead.email, fromName: lead.name, subject: `Re: ${lead.original_subject}`, text: TEXT[kind], threadIds });
    }
    // One prospect presses the one-click unsubscribe in Gmail (RFC 8058 POST to the List-Unsubscribe address).
    const u = new URL(unsubUrl[c.key]);
    const r = await call('api/unsubscribe/route', 'POST', { path: u.pathname + u.search, body: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  mark = sim.sent.length;
  await goTo(et('2026-10-27', '12:00'));
  const l9 = await hubLooks();
  for (const c of BOTH) {
    const toLead = (k) => sentSince(mark).filter((m) => m.to === used[c.key][k].email);
    const replies = Object.values((await kv.hgetall(K.replies(c.id))) || {});
    const kindOf = (k) => replies.find((r) => r.leadEmail === used[c.key][k].email)?.kind;
    const kinds = { interested: 'interested', question: 'question', notnow: 'notnow', ooo: 'ooo', bounce: 'bounce', stop: 'no' };
    for (const [k, want] of Object.entries(kinds)) assert.equal(kindOf(k), want, `${c.company}: the ${k} reply is read as ${want}`);
    // The reply bot answers the interested, the not-now and the STOP — in the prospect's thread, from the inbox that wrote to them.
    for (const [k, re] of [['interested', /glad it’s of interest/], ['notnow', /I’ll check back in/], ['stop', /Taken you off the list/]]) {
      const out = toLead(k);
      assert.equal(out.length, 1, `${c.company}: one answer to the ${k} reply`);
      assert.match(out[0].text, re);
      assert.equal(out[0].from, used[c.key][k].account_used, `${c.company}: from the inbox that holds the thread`);
      assert.ok(c.inboxes.includes(out[0].from), `${c.company}: from its own inbox`);
      assert.equal(out[0].inReplyTo, inbound[c.key][k].messageId, 'threaded under their reply');
      assert.match(out[0].subject, /^Re: /);
    }
    // The question, the out-of-office and the bounce get no automatic answer; nothing more goes to the one-click unsubscribe.
    for (const k of ['question', 'ooo', 'bounce', 'oneclick']) assert.deepEqual(toLead(k).map((m) => m.subject), [], `${c.company}: nothing to the ${k} one`);
    // The interested one and the question are handed over to the client at once (hot leads).
    const hot = sentSince(mark).filter((m) => m.to === c.email && /^Hot — /.test(m.subject));
    for (const k of ['interested', 'question']) assert.ok(hot.some((m) => m.subject.includes(used[c.key][k].company)), `${c.company}: the ${k} lead handed over (${hot.map((m) => m.subject)})`);
    assert.ok(hot.every((m) => c.inboxes.includes(m.from)), 'hot leads come from the client’s own inbox');
    assert.equal((await getLeads(c.id)).find((l) => l.email === used[c.key].bounce.email).status, 'bounced');
    assert.ok(await kv.sismember(K.suppression(), used[c.key].stop.email), 'STOP suppressed everywhere');
    assert.ok(await kv.sismember(K.suppression(), used[c.key].oneclick.email), 'the one-click unsubscribe suppressed everywhere');
    assert.ok(Number(l9[c.key].row.five.replies) >= 4, `${c.company}: replies counted (${JSON.stringify(l9[c.key].row.five)})`);
  }
  // The bounce pause is the owner's rule (≥ 1.5 % over 50 sends): he reads the alert and presses its to-do.
  clock.set(colombo('2026-10-28', '08:30'));
  for (const t of (await hubBoard()).todos.filter((x) => BOTH.some((c) => c.id === x.clientId) && x.urgent && x.action?.path === '/api/mc/alerts')) {
    assert.equal((await call('api/mc/alerts/route', 'POST', { body: t.action.body })).status, 200);
  }

  // The interested prospects book through the client's calendar (the invite lands in the client inbox).
  const booked = {};
  for (const c of BOTH) {
    const lead = used[c.key].interested;
    const slot = c.key === 'harbor' ? et('2026-11-03', '10:00') : et('2026-11-04', '13:00');
    booked[c.key] = { lead, slot };
    const dt = slot.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    deliver(lead.account_used, { from: 'notifications@cal.com', subject: `New Event: Intro call with ${lead.name}`, text: `A new event was booked with ${lead.name}.`, kind: 'human', ics: [['BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VEVENT', `UID:cal-${lead.email}`, `DTSTART:${dt}`, `DTEND:${dt}`, 'SUMMARY:Intro call', `ORGANIZER;CN=${c.person}:mailto:${lead.account_used}`, `ATTENDEE;CN=${lead.name}:mailto:${lead.email}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')] });
  }
  await goTo(et('2026-10-28', '11:00'));
  const l10 = await hubLooks();
  for (const c of BOTH) {
    assert.equal(l10[c.key].detail.bookings.length, 1, `${c.company}: one booked call`);
    assert.equal(l10[c.key].detail.bookings[0].leadEmail, booked[c.key].lead.email);
    assert.equal(Number(l10[c.key].row.five.booked), 1);
    assert.ok(sim.sent.some((m) => m.to === c.email && /^Booked — /.test(m.subject)), `${c.company}: the hand-off went to the client`);
  }

  // ── 9. Each client writes to the owner through the onboarding Gmail; the owner answers from the hub ──
  const LINES = {
    harbor: ['Hi Limeth — could we add Portsmouth, NH to the cities?\n\nMegan', 'Great, thank you. One more: can the emails mention our mobile clinic?\n\nMegan', 'Perfect — thanks!\n\nMegan'],
    summit: ['Hi Limeth — the first replies look good. Can we also target HOA management companies?\n\nJordan', 'Thanks. And could the Friday note go to my ops manager too?\n\nJordan', 'Great, appreciated.\n\nJordan'],
  };
  const ANSWERS = {
    harbor: ['Hi Megan — yes, I will add Portsmouth from Monday.', 'Yes — I will add a line about the mobile clinic to the next emails.'],
    summit: ['Hi Jordan — yes, I will add HOA management companies to the list.', 'Of course — send me their address and I will copy them in.'],
  };
  for (let i = 0; i < 3; i++) {
    for (const c of BOTH) {
      const lastOut = sim.sent.filter((m) => m.to === c.email && m.from === OWNER.inbox).at(-1);
      const ref = lastOut ? [lastOut.messageId.replace(/[<>]/g, '').toLowerCase()] : [];
      deliver(OWNER.inbox, { from: c.email, fromName: c.person, to: [OWNER.inbox], subject: i === 0 ? 'A question' : 'Re: A question', text: LINES[c.key][i], date: clock.iso(), ...(i ? { threadIds: ref, inReplyTo: ref, references: ref } : {}) });
    }
    await goTo(new Date(clock.now.getTime() + 20 * 60e3));
    const look = await hubLooks();
    for (const c of BOTH) {
      const conv = look[c.key].detail.conversation;
      assert.equal(conv.thread.filter((e) => e.dir === 'in' && e.from === c.email).at(-1)?.text?.split('\n')[0], LINES[c.key][i].split('\n')[0], `${c.company}: message ${i + 1} is in the hub`);
      if (i === 2) {
        // A plain thank-you needs no answer: no red dot, nothing sent.
        assert.equal(look[c.key].row.simple.needsReply, false, `${c.company}: a thank-you waits for nothing (${JSON.stringify(look[c.key].row.simple)})`);
        assert.equal(look[c.key].detail.conversation.thread.filter((e) => e.dir === 'in').at(-1).rule, 'thanks');
        continue;
      }
      assert.equal(look[c.key].row.simple.needsReply, true, `${c.company}: ${JSON.stringify(look[c.key].row.simple)}`);
      mark = sim.sent.length;
      const r = await call('api/mc/clients/[id]/messages/route', 'POST', { path: `/api/mc/clients/${c.id}/messages`, params: { id: c.id }, body: { action: 'reply', text: ANSWERS[c.key][i] } });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      const out = mailTo(c, mark);
      assert.equal(out.length, 1, `${c.company}: the owner's answer went`);
      assert.equal(out[0].from, OWNER.inbox, 'from the onboarding Gmail');
      assert.ok(out[0].inReplyTo, 'in their thread');
      assert.ok(out[0].text.startsWith(ANSWERS[c.key][i]));
    }
  }
  const l11 = await hubLooks();
  for (const c of BOTH) {
    const t = l11[c.key].detail.conversation.thread;
    assert.equal(t.filter((e) => e.from === c.email && e.dir === 'in').length >= 3, true);
    assert.equal(t.filter((e) => e.kind === 'owner_reply').length, 2, `${c.company}: two answers from the hub`);
  }

  // ── 10. The rest of the month ─────────────────────────────────────────────
  // The booked prospects show up; each client taps "Showed" in the one-tap email.
  const tappedBy = new Set();
  const clientsTap = async (now) => {
    for (const c of BOTH) {
      if (tappedBy.has(c.key) || now.getTime() < booked[c.key].slot.getTime() + 3 * 3600e3 || !workHours(c, now)) continue;
      const m = sim.sent.find((x) => x.to === c.email && linkIn(x.text, 'tap'));
      if (!m) continue;
      const t = linkIn(m.text, 'tap');
      assert.equal((await call('api/c/tap/route', 'GET', { path: `/api/c/tap?t=${t}` })).status, 200);
      const r = await call('api/c/tap/route', 'POST', { path: '/api/c/tap', body: { t, action: 'showed' } });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      tappedBy.add(c.key);
    }
  };
  // The owner reads the urgent alerts each Colombo morning and presses their to-dos.
  let lastMorning = null;
  const ownerMorning = async (now) => {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo' }).format(now);
    if (day === lastMorning || hourIn('Asia/Colombo', now.toISOString()) !== 8) return;
    lastMorning = day;
    for (const t of (await hubBoard()).todos.filter((x) => BOTH.some((c) => c.id === x.clientId) && x.urgent && x.action?.path === '/api/mc/alerts')) {
      assert.equal((await call('api/mc/alerts/route', 'POST', { body: t.action.body })).status, 200);
    }
  };
  // The Test run's third client: Harbor's trial on its Day 12 (Monday evening), every name changed (Lakeview).
  let lakeview = null;
  const lakeviewSnapshot = async (now) => {
    if (lakeview || now.getTime() < et('2026-11-02', '20:00').getTime()) return;
    const d = await hubDetail(HARBOR.id);
    assert.equal(d.row.state, 'sending', 'Harbor is sending on its Day 12');
    assert.equal(d.row.plan, 'trial');
    assert.equal(trialDay(d.trial, now), 12, 'the snapshot is the evening of Day 12');
    lakeview = { part: lakeviewPart(HARBOR, __dump(), clock.now), day: trialDay(d.trial, now), sent: d.row.five.sent };
  };
  hooks = [clientsAnswerHotLeads, prospectsReply, clientsAct, clientsTap, ownerMorning, lakeviewSnapshot];
  await goTo(et('2026-11-06', '12:00'));
  const l12 = await hubLooks();
  for (const c of BOTH) {
    assert.ok(tappedBy.has(c.key), `${c.company}: the client tapped Showed`);
    assert.equal(Number(l12[c.key].detail.counters.qualified), 1, `${c.company}: one qualified call`);
  }
  await goTo(et('2026-11-20', '12:00'));
  const l13 = await hubLooks();
  assert.equal(l13.harbor.row.state, 'deciding', 'the trial ended on Day 30');
  assert.equal(l13.harbor.row.simple.step, 'deciding');
  assert.equal(l13.summit.row.state, 'sending', 'the paying client keeps sending — no Day 30');
  assert.ok(l13.harbor.detail.links.decision, 'the decision page link is in the hub');

  // ── 11. Money: Harbor presses Start; the invoice goes; the money lands and the owner marks it paid ──
  const decideMail = sim.sent.filter((m) => m.to === HARBOR.email && linkIn(m.text, 'decide')).at(-1);
  assert.ok(decideMail, 'the decision page reached Megan');
  await goTo(et('2026-11-20', '14:30'));
  const dToken = linkIn(decideMail.text, 'decide');
  const view = await call('api/c/decide/route', 'GET', { path: `/api/c/decide?token=${dToken}` });
  assert.equal(view.status, 200, JSON.stringify(view.json));
  mark = sim.sent.length;
  const start = await call('api/c/decide/route', 'POST', { path: '/api/c/decide', body: { token: dToken, action: 'start' } });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  assert.equal(start.json.outcome, 'converted');
  const harborPlan = start.json.plan;
  const PRICE = { starter: 2497, growth: 3997, scale: 8497 };
  const l14 = await hubLooks();
  assert.equal(l14.harbor.row.state, 'converted');
  assert.equal(l14.harbor.row.plan, harborPlan, 'Harbor is now a paying client too');
  const hInv = l14.harbor.detail.invoice;
  assert.deepEqual([hInv.plan, hInv.amount, hInv.status, hInv.paidAt], [harborPlan, PRICE[harborPlan], 'sent', null], JSON.stringify(hInv));
  assert.ok(mailTo(HARBOR, mark).some((m) => m.subject === `Invoice ${hInv.number} — ${harborPlan[0].toUpperCase()}${harborPlan.slice(1)}, month one`), 'the invoice email went');
  // The money lands a few days later; the owner presses the to-do.
  await goTo(colombo('2026-11-24', '09:00'));
  const hPay = (await hubBoard()).todos.find((t) => t.id === `invoice:${HARBOR.id}`);
  assert.ok(hPay, 'a to-do to mark the invoice paid');
  assert.equal((await call('api/mc/clients/[id]/route', 'POST', { path: hPay.action.path, params: { id: HARBOR.id }, body: hPay.action.body })).status, 200);

  // ── 12. Everything in the hub, the same numbers everywhere ────────────────
  const fin = await hubLooks();
  noSecrets('the end', fin);
  const report = {};
  for (const c of BOTH) {
    const row = fin[c.key].row;
    const d = fin[c.key].detail;
    // Money on the board row (the hub's "money received") = the invoice in the detail.
    assert.ok(row.invoice, `${c.company}: the invoice is on the board row`);
    assert.deepEqual(row.invoice, { number: d.invoice.number, amount: d.invoice.amount, issuedAt: d.invoice.issuedAt, paidAt: d.invoice.paidAt, status: d.invoice.status, plan: d.invoice.plan });
    assert.equal(d.invoice.status, 'paid');
    assert.ok(d.invoice.paidAt);
    assert.deepEqual(d.row.five, row.five, 'the detail row is the board row');
    // Growth (the Growth tab): the daily series add up to the five numbers.
    const g = (await call('api/mc/hub/[id]/growth/route', 'GET', { path: `/api/mc/hub/${c.id}/growth?days=45`, params: { id: c.id } })).json;
    const sum = (a) => (a || []).reduce((x, y) => x + (Number(y) || 0), 0);
    assert.equal(g.days.length, 45);
    assert.equal(sum(g.email.sent), row.five.sent, `${c.company}: growth sent = the board's sent`);
    assert.equal(sum(g.email.replies), row.five.replies, `${c.company}: growth replies`);
    assert.equal(sum(g.email.booked), row.five.booked, `${c.company}: growth booked`);
    assert.equal(sum(g.email.bounces), Number(d.counters.bounces || 0), `${c.company}: growth bounces`);
    // The client's own dashboard shows the same numbers.
    const dashToken = /\/c\/([A-Za-z0-9_-]{20,})\/dashboard/.exec(d.links.dashboard || '')?.[1];
    assert.ok(dashToken, `${c.company}: a dashboard link`);
    const dash = (await call('api/c/dashboard/route', 'GET', { path: `/api/c/dashboard?token=${dashToken}` })).json;
    assert.equal(dash.ok, true);
    assert.deepEqual(dash.five, { sent: row.five.sent, opened: null, replies: row.five.replies, bounced: Number(d.counters.bounces ?? 0), interested: row.five.positive, booked: row.five.booked }, `${c.company}: the dashboard's numbers = the hub's`);
    assert.equal(dash.calls.prospects.length, d.bookings.filter((b) => b.scheduledAt).length);
    assert.ok(dash.last30.totals.sent <= row.five.sent && dash.last30.totals.sent > 0);
    assert.ok(!JSON.stringify(dash).includes('invoice'), 'the client dashboard shows no owner money data');
    // A month of sending at realistic volumes (no day over the inboxes' caps).
    const perDay = g.email.sent.filter((x) => Number(x) > 0);
    assert.ok(perDay.length >= 20, `${c.company}: sent on ${perDay.length} days`);
    assert.ok(Math.max(...perDay) <= 2 * 50, `${c.company}: at most ${Math.max(...perDay)} a day`);
    report[c.key] = { sent: row.five.sent, replies: row.five.replies, positive: row.five.positive, bounces: Number(d.counters.bounces || 0), booked: row.five.booked, qualified: row.five.qualified, invoice: { number: d.invoice.number, plan: d.invoice.plan, amount: d.invoice.amount, paidAt: d.invoice.paidAt }, days: perDay.length, maxPerDay: Math.max(...perDay) };
  }
  // Both are in the Paying clients list now; only the trial counted against the trial cap, and it is over.
  assert.equal(fin.board.machine.activeTrials, 0);
  assert.equal(fin.harbor.row.stateLabel, 'Converted — paid');

  // Every email to the paying client reads without trial words; nothing went to either client at night.
  const summitMail = sim.sent.filter((m) => m.to === SUMMIT.email);
  assert.deepEqual(summitMail.filter((m) => TRIAL_WORDS.test(`${m.subject}\n${m.text}`)).map((m) => m.subject), [], 'no trial wording to the paying client');
  for (const c of BOTH) {
    const night = sim.sent.filter((m) => m.to === c.email && !/book your onboarding call|^Hot —|^Booked —|^Re: /.test(m.subject || '') && (hourIn(TZ[c.key], m.at) < 7 || hourIn(TZ[c.key], m.at) >= 21));
    assert.deepEqual(night.map((m) => `${m.at} ${m.subject}`), [], `${c.company}: no email at night`);
    // New cold emails only on weekdays, 9–5 in the prospects' own zone.
    const cold = sim.sent.filter((m) => c.inboxes.includes(m.from) && m.headers?.['List-Unsubscribe'] && !/^Re:/i.test(m.subject || ''));
    const wd = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: TZ[c.key], weekday: 'short' }).format(new Date(iso));
    assert.deepEqual(cold.filter((m) => hourIn(TZ[c.key], m.at) < 9 || hourIn(TZ[c.key], m.at) >= 17 || ['Sat', 'Sun'].includes(wd(m.at))).map((m) => `${m.at} → ${m.to}`), [], `${c.company}: cold emails in business hours`);
  }
  // The inboxes of one client never wrote to the other client's prospects.
  const hLeads = new Set((await getLeads(HARBOR.id)).map((l) => l.email));
  assert.deepEqual(sim.sent.filter((m) => SUMMIT.inboxes.includes(m.from) && hLeads.has(m.to)).map((m) => m.to), []);
  assert.deepEqual(world.unknown, [], 'the machine only talked to the world it knows');
  assert.equal(world.ci.forbidden.length, 0);
  console.log('RESULT', JSON.stringify(report));
  if (process.env.TWO_CLIENTS_REPORT) fs.writeFileSync(process.env.TWO_CLIENTS_REPORT, JSON.stringify(report, null, 1));

  // ── Every email and every conversation, per client, in the hub ────────────
  for (const c of BOTH) {
    const d = fin[c.key].detail;
    const leads = await getLeads(c.id);
    const coldSent = leads.reduce((n, l) => n + ['sent_at', 'd3_sent_at', 'd7_sent_at', 'd10_sent_at'].filter((f) => l[f]).length, 0);
    assert.equal(coldSent, fin[c.key].row.five.sent, `${c.company}: one cold email on the lead records per email counted`);
    const emails = async (q = '') => (await call('api/mc/hub/[id]/emails/route', 'GET', { path: `/api/mc/hub/${c.id}/emails${q}`, params: { id: c.id } })).json;
    const all = [];
    let page = await emails('?limit=200');
    for (let guard = 0; guard < 50; guard++) {
      all.push(...page.sent);
      if (!page.next) break;
      page = await emails(`?limit=200&before=${encodeURIComponent(page.next)}`);
    }
    assert.equal(all.length, page.total, `${c.company}: the pages add up to the total`);
    assert.equal(new Set(all.map((e) => e.id)).size, all.length, 'no email twice');
    const cold = all.filter((e) => e.kind === 'first' || e.kind === 'followup');
    assert.equal(cold.filter((e) => e.status !== 'failed').length, coldSent, `${c.company}: every cold email is in the log`);
    assert.ok(all.some((e) => e.kind === 'bot' && e.threadId), `${c.company}: the machine's answers to prospects`);
    assert.ok(all.some((e) => e.kind === 'owner') && all.some((e) => e.kind === 'client'), `${c.company}: what went to the client`);
    assert.ok(all.some((e) => e.status === 'replied') && all.some((e) => e.status === 'bounced'));
    const threads = (await call('api/mc/hub/[id]/threads/route', 'GET', { path: `/api/mc/hub/${c.id}/threads`, params: { id: c.id } })).json.threads;
    const replied = new Set(d.replies.map((r) => r.leadEmail));
    assert.equal(threads.length, replied.size, `${c.company}: one thread per prospect who wrote back`);
    const it = threads.find((t) => t.lead.email === used[c.key].interested.email);
    assert.deepEqual([it.kind, it.handledBy], ['interested', 'client']);
    const th = (await call('api/mc/hub/[id]/threads/[threadId]/route', 'GET', { path: `/api/mc/hub/${c.id}/threads/${it.threadId}`, params: { id: c.id, threadId: it.threadId } })).json;
    const first = sim.sent.find((m) => m.to === it.lead.email && m.subject === used[c.key].interested.original_subject);
    assert.equal(th.messages[0].text, first.text, `${c.company}: our first email, word for word`);
    assert.deepEqual(th.messages.map((m) => `${m.dir}:${m.by}`).slice(0, 2), ['out:system', 'in:prospect'], 'our email, then their reply');
    assert.equal(th.messages[1].text, TEXT.interested);
    assert.equal(th.messages[1].from, `${used[c.key].interested.name} <${it.lead.email}>`, 'names on the addresses');
    assert.match(th.messages.find((m) => m.by === 'bot').text, /glad it’s of interest/, 'the machine’s answer');
    assert.equal(th.messages.find((m) => m.by === 'client')?.text, 'On it — I will call them this afternoon.', 'the client answered the hand-off');
    assert.deepEqual([...th.messages].sort((a, b) => a.at.localeCompare(b.at)).map((m) => m.at), th.messages.map((m) => m.at), 'oldest first');
    // A prospect who never wrote back: their thread still opens (our emails, word for word).
    const quiet = all.find((e) => e.kind === 'first' && e.status === 'sent');
    const qt = (await call('api/mc/hub/[id]/threads/[threadId]/route', 'GET', { path: `/api/mc/hub/${c.id}/threads/${quiet.threadId}`, params: { id: c.id, threadId: quiet.threadId } })).json;
    assert.ok(qt.messages.length >= 1 && qt.messages.every((m) => m.dir === 'out' && m.text && !m.text.startsWith('(This email')), JSON.stringify(qt).slice(0, 300));
    // What went to the client: its own thread, the client ↔ owner conversation.
    assert.ok(all.filter((e) => e.kind === 'owner' || e.kind === 'client').every((e) => e.threadId === 'client'));
    const ct = (await call('api/mc/hub/[id]/threads/[threadId]/route', 'GET', { path: `/api/mc/hub/${c.id}/threads/client`, params: { id: c.id, threadId: 'client' } })).json;
    assert.ok(ct.messages.some((m) => m.by === 'client') && ct.messages.some((m) => m.by === 'owner'));
    assert.ok(all.every((e) => typeof e.threadId === 'string' && e.threadId), 'every email opens a conversation');
  }

  // ── The state for the hub's Test run (POST /api/mc/demo) ──────────────────
  assert.ok(lakeview, 'the Day-12 snapshot of the trial was taken');
  const state = await exportDemoState([HARBOR.id, SUMMIT.id], {
    dump: __dump(), now: clock.now,
    before: [[HARBOR.domain, 'harbordental.com'], [SUMMIT.domain, 'summitroofing.com']],
    extra: [{ ...lakeview.part, endsDaysAgo: 1 }],
  });
  // Loaded, each part ends the evening before the load: nothing in the hub is dated later than now.
  state.parts[0].endsDaysAgo = 1;
  console.log('DEMO', JSON.stringify({ lakeviewDay: lakeview.day, lakeviewSent: lakeview.sent, parts: state.parts.map((p) => [p.ids, Object.keys(p.keys).length]) }));
  if (process.env.DEMO_STATE === '1') fs.writeFileSync(DEMO_FIXTURE, `${JSON.stringify(state)}\n`);
  else if (fs.existsSync(DEMO_FIXTURE)) {
    const saved = JSON.parse(fs.readFileSync(DEMO_FIXTURE, 'utf8'));
    const keysOf = (st) => (st.parts || [st]).map((p) => Object.keys(p.keys).sort());
    assert.deepEqual(keysOf(saved), keysOf(state), 'tests/fixtures/demo-state.json is out of date: run DEMO_STATE=1 npm test');
  }
});
