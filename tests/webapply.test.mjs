import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, kv } from '@vercel/kv';
import { io } from '@/lib/systems/intake-io';
import { renderTemplate } from '@/lib/templates/client';
import { usStateOf, companyFromDomain, mapWebsiteForm, fitLines, submitWebsiteApplication } from '@/lib/systems/webapply';
import { approveApplication, declineApplication } from '@/lib/systems/gatekeeper';
import { getClient, createClient } from '@/lib/db/client';
import { hubClient, hubBoard } from '@/lib/systems/hubview';

let emails = [];
let alerts = [];
beforeEach(async () => {
  __reset();
  emails = [];
  alerts = [];
  io.notifyClient = async (clientId, key, vars, opts = {}) => {
    const msg = renderTemplate(key, { clientName: 'C', contactName: 'Ann Lee', ...vars });
    emails.push({ clientId, key, vars, opts, msg });
    return { sent: true };
  };
  io.alertOwner = async (key, o = {}) => { alerts.push({ key, ...o }); return { sent: true }; };
  io.sendOwnerEmail = async () => ({ ok: true });
  io.fetchExt = async () => ({ ok: true, status: 200, url: 'https://acme-plumbing.com/', text: async () => '<title>Acme Plumbing — Charlotte</title>' });
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith') });
});

// Exactly what aviance.online/trial.html sends.
const site = (over = {}) => ({
  source: 'website', name: 'Ann Lee', email: 'Ann@Acme-Plumbing.com', website: 'https://www.acme-plumbing.com/', city: 'Charlotte, NC',
  sell: 'Commercial plumbing for property managers in the Carolinas', value: '$5,000–$20,000', capacity: '5–10 a week',
  strangers: 'Yes — cold buyers already', calendar: 'Yes', then: 'Move to Growth — 20 calls a month', notes: 'Tried cold email once',
  agree: true, proof: ['Intro to one peer'], ...over,
});
const noSite = async () => '';

test('reading the website form', () => {
  assert.equal(usStateOf('Charlotte, NC'), 'NC');
  assert.equal(usStateOf('Austin, Texas'), 'TX');
  assert.equal(usStateOf('NYC, New York'), 'NY');
  assert.equal(usStateOf('Denver CO 80202'), 'CO');
  assert.equal(usStateOf('Colombo, Sri Lanka'), null);
  assert.equal(usStateOf(''), null);
  assert.equal(companyFromDomain('acme-plumbing.com'), 'Acme Plumbing');
  const { fields, answers, mainDomain, extras } = mapWebsiteForm(site());
  assert.equal(mainDomain, 'acme-plumbing.com');
  assert.equal(fields.companyName, 'Acme Plumbing');
  assert.equal(fields.contactEmail, 'ann@acme-plumbing.com');
  assert.equal(fields.usBased, 'yes');
  assert.equal(fields.dealValue, '5000');   // the band's floor, never a midpoint
  assert.equal(fields.slotsPerWeek, '5');
  assert.equal(fields.meetWithin5Days, 'yes');
  assert.equal(fields.reviewAgreed, 'yes');
  assert.equal(extras.sellsTo, 'Commercial plumbing for property managers in the Carolinas');
  assert.ok(answers.find((a) => a.q.startsWith('What do you sell')).a.includes('property managers'));
  assert.ok(!('employees' in fields), 'headcount is never guessed');
});

test('fit verdict: pass / fail / unknown, never guessed', async () => {
  const good = await fitLines(site(), { mainDomain: 'acme-plumbing.com', fetchText: noSite });
  const by = Object.fromEntries(good.lines.map((l) => [l.rule, l.status]));
  assert.equal(good.verdict, 'fit');
  assert.equal(by.deal_value, 'pass');
  assert.equal(by.employees, 'unknown');
  assert.equal(by.dream_customers, 'unknown');
  assert.equal(by.nobody_else_emailing, 'unknown');
  assert.equal(by.slots_per_week, 'pass');
  assert.match(good.summary, /^Looks like a fit — 3 checks unknown$/);

  const bad = await fitLines(site({ value: 'Under $2,000', strangers: 'Referrals and network only so far', calendar: 'Usually', capacity: '1–2 a week', city: '' }), { mainDomain: 'acme-plumbing.com', fetchText: noSite });
  const b = Object.fromEntries(bad.lines.map((l) => [l.rule, l.status]));
  assert.equal(bad.verdict, 'fails');
  assert.equal(b.deal_value, 'fail');
  assert.equal(b.sold_to_strangers, 'fail');
  assert.equal(b.meet_within_5_days, 'unknown'); // "Usually" is not a yes and not a no
  assert.equal(b.slots_per_week, 'fail');
  assert.equal(b.us_based, 'unknown');
  assert.match(bad.summary, /^Fails 3 checks: /);

  const mid = await fitLines(site({ capacity: '3–5 a week' }), { mainDomain: 'acme-plumbing.com', fetchText: noSite });
  assert.equal(mid.lines.find((l) => l.rule === 'slots_per_week').status, 'unknown', '3–5 straddles the minimum of 5');

  const agency = await fitLines(site(), { mainDomain: 'acme-plumbing.com', fetchText: async () => 'Pipeline Pros | Appointment Setting for B2B' });
  assert.equal(agency.lines.find((l) => l.rule === 'not_agency').status, 'fail');
});

test('a website application is saved, held for the owner, and nobody is emailed', async () => {
  const r = await submitWebsiteApplication(site(), { fetchText: noSite });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'review');
  const c = await getClient(r.clientId);
  assert.equal(c.state, 'applied');
  assert.equal(c.source, 'website');
  assert.equal(emails.length, 0, 'the applicant hears nothing until the owner decides');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].key, 'new_application');
  assert.match(alerts[0].body, /Ann Lee <ann@acme-plumbing\.com> applied/);
  assert.match(alerts[0].body, /Looks like a fit/);

  // The hub shows it with a review to-do and the full application.
  const board = await hubBoard();
  const row = board.stages.find((s) => s.key === 'intake').clients.find((x) => x.id === r.clientId);
  assert.equal(row.stateLabel, 'Applied — waiting for your review');
  assert.equal(row.systems[0].status, 'waiting');
  const todo = board.todos.find((t) => t.id === `review:${r.clientId}`);
  assert.equal(todo.text, "Review Acme Plumbing's trial application");
  assert.deepEqual(todo.action, { type: 'view', view: 'detail', clientId: r.clientId, section: 'application' });
  const detail = await hubClient(r.clientId);
  assert.equal(detail.application.review, 'pending');
  assert.equal(detail.application.source, 'website');
  assert.equal(detail.application.fit.verdict, 'fit');
  assert.ok(detail.application.answers.length >= 10);
});

test('Approve sends the onboarding link; Decline sends the owner\'s reason', async () => {
  const a = await submitWebsiteApplication(site(), { fetchText: noSite });
  const res = await approveApplication(a.clientId);
  assert.equal(res.outcome, 'onboarding');
  assert.equal((await getClient(a.clientId)).state, 'onboarding');
  assert.deepEqual(emails.map((e) => e.key), ['onboarding_link']);
  assert.equal((await kv.hgetall(`client:${a.clientId}:profile`)).sellsTo, 'Commercial plumbing for property managers in the Carolinas');
  await assert.rejects(() => approveApplication(a.clientId), /not waiting for a review/);

  emails = [];
  const b = await submitWebsiteApplication(site({ email: 'bob@beta-hvac.com', website: 'beta-hvac.com', name: 'Bob' }), { fetchText: noSite });
  await assert.rejects(() => declineApplication(b.clientId, '  '), /reason is required/);
  const d = await declineApplication(b.clientId, 'a new customer needs to be worth at least $2,000 in year one.');
  assert.equal(d.outcome, 'declined');
  assert.equal((await getClient(b.clientId)).state, 'declined');
  assert.equal(emails[0].key, 'decline_fit');
  assert.match(emails[0].msg.text, /worth at least \$2,000/);
  assert.equal((await hubClient(b.clientId)).application.review, 'declined');
});

test('Approve still respects the 3-trial cap (→ queue)', async () => {
  for (const id of ['t1', 't2', 't3']) await createClient(id, { name: id, state: 'sending', plan: 'trial' });
  const a = await submitWebsiteApplication(site(), { fetchText: noSite });
  const res = await approveApplication(a.clientId);
  assert.equal(res.outcome, 'queued');
  assert.equal(emails[0].key, 'queued_position');
});

test('POST /api/apply takes the website form as-is', async () => {
  const { POST } = await import('@/app/api/apply/route');
  const res = await POST(new Request('http://x/api/apply', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' }, body: JSON.stringify(site({ email: 'zed@zeta-co.com', website: 'zeta-co.com' })) }));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.outcome, 'review');
  assert.match(body.message, /A person reads every one/);
  const hp = await POST(new Request('http://x/api/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(site({ company_url2: 'http://spam' })) }));
  assert.equal((await hp.json()).ok, true); // honeypot: silently accepted, nothing stored
  const bad = await POST(new Request('http://x/api/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(site({ email: 'nope', website: 'x.com' })) }));
  assert.equal(bad.status, 400);
  const noSiteRes = await POST(new Request('http://x/api/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(site({ website: 'not-a-website' })) }));
  assert.deepEqual(Object.keys((await noSiteRes.json()).errors), ['website'], 'only the website is reported — the site has no company field');
});
