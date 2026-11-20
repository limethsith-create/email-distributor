import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, kv } from '@vercel/kv';
import { saveInquiry, listInquiries, setInquiryStatus, addInquiryNote, normaliseInquiry } from '@/lib/systems/inquiries';
import { hubBoard } from '@/lib/systems/hubview';
import { pushIo, savePushSub } from '@/lib/push';
import { io } from '@/lib/systems/intake-io';
import { getClient, createClient } from '@/lib/db/client';
import { runDayJobs } from '@/lib/systems/trialmanager';

// Exactly what aviance.online's "Book a call" form sends.
const site = (over = {}) => ({
  name: 'Bob Stone', email: 'Bob@StoneRoofing.com', company: 'Stone Roofing', website: 'stoneroofing.com',
  sells: 'Commercial roofing for property managers in Texas', plan: 'growth',
  slotStart: '2027-09-30T14:00:00.000Z', slotEnd: '2027-09-30T14:15:00.000Z', theirTz: 'America/Chicago',
  whenTheirs: 'Thursday, October 1, 2026 at 9:00 AM CDT', whenHost: 'Thursday, October 1, 2026 at 7:30 PM', ...over,
});
let pushed = [];
let emails = [];

beforeEach(async () => {
  __reset();
  pushed = [];
  emails = [];
  process.env.VAPID_PUBLIC_KEY = 'BPUB'; process.env.VAPID_PRIVATE_KEY = 'priv';
  pushIo.send = async (s, payload) => { pushed.push(JSON.parse(payload)); return { statusCode: 201 }; };
  await savePushSub({ endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'p', auth: 'a' } }, 'iPhone');
  io.notifyClient = async (clientId, key) => { emails.push(key); return { sent: true }; };
  io.alertOwner = async () => ({ sent: true });
  io.fetchExt = async () => ({ ok: true, status: 200, url: 'https://stoneroofing.com/', text: async () => '<title>Stone Roofing</title>' });
});

test('an inquiry from the website (no website given) lands in the hub and pops up on the phone', async () => {
  const r = await saveInquiry(site({ website: '' }));
  assert.equal(r.ok, true);
  const { inquiries, counts } = await listInquiries();
  assert.equal(inquiries.length, 1);
  assert.equal(inquiries[0].email, 'bob@stoneroofing.com');
  assert.equal(inquiries[0].plan, 'growth');
  assert.equal(inquiries[0].status, 'new');
  assert.equal(counts.new, 1);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].title, 'Urgent: New plan inquiry: Stone Roofing — call Thursday, October 1, 2026 at 7:30 PM (your time)');
  assert.equal(pushed[0].url, `/#inquiry/${r.id}`);
  assert.match(pushed[0].body, /Bob Stone <bob@stoneroofing\.com> from Stone Roofing asked about Growth/);
  // Double-click on the form: merged, no second alert.
  assert.equal((await saveInquiry(site({ website: '' }))).duplicate, true);
  assert.equal(pushed.length, 1);
  // The board shows it as a to-do: calm while the booked call is still ahead (the server refuses times that have passed).
  const board = await hubBoard();
  const todo = board.todos.find((t) => t.id === `inquiry:${r.id}`);
  assert.equal(todo.urgent, false);
  assert.match(todo.text, /is booked/);
  assert.deepEqual(todo.action, { type: 'view', view: 'inquiry', inquiryId: r.id });
  assert.equal(board.inquiries.counts.new, 1);
});

test('validation, status, notes; Won makes them a paying client (one onboarding email), Lost closes the record quietly', async () => {
  assert.deepEqual(Object.keys(normaliseInquiry({ name: '', email: 'x', company: '', sells: '' }).errors).sort(), ['company', 'email', 'name', 'sells']);
  const { id } = await saveInquiry(site({ plan: 'nonsense', website: '' }));
  assert.equal((await listInquiries()).inquiries[0].plan, null);
  await addInquiryNote(id, 'Left a voicemail');
  const q = await setInquiryStatus(id, 'contacted', 'Call on Thursday');
  assert.equal(q.status, 'contacted');
  assert.deepEqual(q.notes.map((n) => n.text), ['Left a voicemail', 'Call on Thursday']);
  await assert.rejects(() => setInquiryStatus(id, 'maybe'), /status must be one of/);
  // No website: Won cannot make a client, and the booking stays where it was.
  await assert.rejects(() => setInquiryStatus(id, 'won'), /has no website/);
  assert.equal((await listInquiries()).inquiries[0].status, 'contacted');
  // With a website: Won → a Starter client in onboarding, one email.
  const rec = (await listInquiries()).inquiries[0];
  await kv.hset('inquiries', { [id]: { ...rec, website: 'https://stoneroofing.com' } });
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith') });
  const w = await setInquiryStatus(id, 'won');
  assert.equal(w.status, 'won');
  assert.ok(w.clientId);
  const c = await getClient(w.clientId);
  assert.deepEqual([c.state, c.plan], ['onboarding', 'starter']);
  assert.deepEqual(emails, ['accepted_call']);
  // Won again: nothing new.
  await setInquiryStatus(id, 'won');
  assert.deepEqual(emails, ['accepted_call']);
});

test('POST /api/inquiry: honeypot, bad data', async () => {
  const { POST } = await import('@/app/api/inquiry/route');
  const ok = await POST(new Request('http://x/api/inquiry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(site({ email: 'z@zeta.com' })) }));
  assert.equal((await ok.json()).ok, true);
  const hp = await POST(new Request('http://x/api/inquiry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(site({ company_url2: 'spam' })) }));
  assert.equal((await hp.json()).ok, true);
  assert.equal((await listInquiries()).inquiries.length, 1, 'the honeypot saved nothing');
  const bad = await POST(new Request('http://x/api/inquiry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }) }));
  assert.equal(bad.status, 400);
});

test('a booking with a website: researched and held for the sales call; Won emails them the onboarding call; Lost declines with no email', async () => {
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith') });
  const r = await saveInquiry(site());
  assert.equal(r.ok, true);
  assert.ok(r.clientId, 'a record was made for the call');
  const c = await getClient(r.clientId);
  assert.equal(c.plan, 'growth'); assert.equal(c.state, 'applied'); assert.equal(c.source, 'inquiry');
  const app = await kv.hgetall(`client:${r.clientId}:application`);
  assert.equal(app.review, 'pending');
  assert.match(app.answers, /Plan they asked for.*Growth/);
  assert.deepEqual(emails, [], 'nothing goes to them before Won');
  assert.equal((await listInquiries()).inquiries[0].clientId, r.clientId);
  // The board: the booking is the one to-do (not a second one for the record).
  const board = await hubBoard();
  assert.equal(board.todos.filter((t) => t.id === `inquiry:${r.id}`).length, 1);
  assert.equal(board.todos.filter((t) => String(t.id).includes(r.clientId)).length, 0);
  // Won → the onboarding email, straight to onboarding.
  const won = await setInquiryStatus(r.id, 'won');
  assert.equal(won.clientId, r.clientId);
  assert.deepEqual(emails, ['accepted_call']);
  assert.equal((await getClient(r.clientId)).state, 'onboarding');
  // Sending on Day 60: no report, no decision, it keeps sending.
  await kv.hset(`client:${r.clientId}`, { state: 'sending' });
  await kv.hset(`client:${r.clientId}:trial`, { day1Date: '2026-01-01', firstSendAt: '2026-01-01T15:00:00Z', day1NoticeAt: '2026-01-01T16:00:00Z' });
  const dj = await runDayJobs(r.clientId, { now: new Date('2026-03-01T15:00:00Z') });
  assert.equal(dj.day, 60, 'Day 60 of sending');
  assert.equal((await getClient(r.clientId)).state, 'sending');
  const row = (await hubBoard()).stages.find((st) => st.key === 'live').clients.find((x) => x.id === r.clientId);
  assert.equal(row.plan, 'growth');
  assert.ok(!/of 30|trial/i.test(row.stateLabel) && !/of 30|trial/i.test(row.simple.label), row.stateLabel + ' / ' + row.simple.label);

  // Won / Lost pressed on the client page (the intake route) move the booking too.
  const { POST: intake } = await import('@/app/api/mc/clients/[id]/intake/route');
  const b = await saveInquiry(site({ email: 'won2@stoneroofing.com', company: 'Page Roofing', website: 'pageroofing.com', slotStart: '2027-09-30T18:00:00.000Z', slotEnd: '2027-09-30T18:15:00.000Z' }));
  const wr = await intake(new Request('http://x', { method: 'POST', body: JSON.stringify({ action: 'approveApplication' }) }), { params: { id: b.clientId } });
  assert.equal(wr.status, 200);
  assert.equal((await getClient(b.clientId)).state, 'onboarding');
  assert.equal((await listInquiries()).inquiries.find((q) => q.id === b.id).status, 'won');
  emails = [];
  const c2 = await saveInquiry(site({ email: 'lost2@stoneroofing.com', company: 'Gone Roofing', website: 'goneroofing.com', slotStart: '2027-09-30T19:00:00.000Z', slotEnd: '2027-09-30T19:15:00.000Z' }));
  await intake(new Request('http://x', { method: 'POST', body: JSON.stringify({ action: 'declineApplication' }) }), { params: { id: c2.clientId } });
  assert.equal((await getClient(c2.clientId)).state, 'declined');
  assert.equal((await listInquiries()).inquiries.find((q) => q.id === c2.id).status, 'lost');
  assert.deepEqual(emails, []);

  // Lost: the record is declined and nothing is emailed.
  emails = [];
  const l = await saveInquiry(site({ email: 'old+lost@stoneroofing.com', company: 'Lost Roofing', website: 'lostroofing.com', slotStart: '2027-09-30T16:00:00.000Z', slotEnd: '2027-09-30T16:15:00.000Z' }));
  assert.equal(l.ok, true, l.error);
  await setInquiryStatus(l.id, 'lost');
  assert.equal((await getClient(l.clientId)).state, 'declined');
  assert.deepEqual(emails, []);
});

test('the owner adds a paying client by hand (POST /api/mc/clients/new): the onboarding email; no plan → Starter', async () => {
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith') });
  const { POST } = await import('@/app/api/mc/clients/new/route');
  const res = await POST(new Request('http://x/api/mc/clients/new', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ companyName: 'Oak Legal', contactName: 'Olive Oak', contactEmail: 'olive@oaklegal.com', website: 'oaklegal.com', plan: 'Scale' }) }));
  const r = await res.json();
  assert.equal(r.ok, true); assert.equal(r.outcome, 'onboarding');
  const c = await getClient(r.clientId);
  assert.equal(c.plan, 'scale'); assert.equal(c.state, 'onboarding'); assert.equal(c.source, 'owner');
  assert.deepEqual(emails, ['accepted_call']);
  const t = await (await POST(new Request('http://x/api/mc/clients/new', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ companyName: 'Elm Dental', contactName: 'Eli Elm', contactEmail: 'eli@elmdental.com', website: 'elmdental.com' }) }))).json();
  assert.equal((await getClient(t.clientId)).plan, 'starter'); assert.equal(t.outcome, 'onboarding');
});

test('every client signs the plan agreement (their plan, price and calls); the onboarding page names the plan', async () => {
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith') });
  const { agreementFor, loadOnboarding } = await import('@/lib/systems/onboarding');
  await createClient('oak-legal', { name: 'Oak Legal', contactName: 'Olive Oak', contactEmail: 'olive@oaklegal.com', mainDomain: 'oaklegal.com', plan: 'growth', state: 'applied' });
  const ag = await agreementFor('oak-legal');
  assert.equal(ag.paid, true);
  assert.match(ag.text, /^Aviance — Growth Plan Agreement/);
  assert.match(ag.text, /\$3,997 a month for 20 booked sales calls a month/);
  assert.ok(!/free|30-Day Trial|review/i.test(ag.text), 'no trial wording');
  // An old record without a plan reads as Starter.
  await createClient('elm-dental', { name: 'Elm Dental', contactName: 'Eli Elm', contactEmail: 'eli@elmdental.com', mainDomain: 'elmdental.com', plan: 'trial', state: 'applied' });
  assert.match((await agreementFor('elm-dental')).text, /^Aviance — Starter Plan Agreement/);
  assert.equal((await loadOnboarding('oak-legal')).planName, 'Growth');
  assert.equal((await loadOnboarding('elm-dental')).planName, 'Starter');
});

test('no plan card: the plan comes from the calls a month they can take, and their answers feed the fit score', async () => {
  const { inferPlan, applicationExtras } = await import('@/lib/systems/inquiries');
  assert.equal(inferPlan({ capacity: 'Around 10' }), 'growth');
  assert.equal(inferPlan({ capacity: '15 or more' }), 'scale');
  assert.equal(inferPlan({ capacity: 'Around 5' }), 'starter');
  assert.equal(inferPlan({ capacity: 'Not sure yet' }), null);
  assert.equal(inferPlan({ plan: 'scale', capacity: 'Around 5' }), 'scale');
  assert.deepEqual(applicationExtras({ sells: 'Dispatch software for trucking fleets', dealSize: '$5,000 – $25,000', channel: 'Inbound (ads, SEO, content)' }),
    { web_sellsTo: 'Dispatch software for trucking fleets', web_valueBand: '$5,000 – $25,000', dealValue: 5000, soldToStrangers: 'yes' });
  assert.equal(applicationExtras({ dealSize: 'Under $5,000' }).dealValue, undefined, 'a band with no floor stays a question');
  assert.equal(applicationExtras({ channel: 'Mostly referrals' }).soldToStrangers, undefined, 'referrals is not "never sold to strangers"');

  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith') });
  const r = await saveInquiry(site({ plan: null, capacity: 'Around 10', dealSize: '$5,000 – $25,000', channel: 'Our own outbound' }));
  assert.equal((await getClient(r.clientId)).plan, 'growth');
  const app = await kv.hgetall(`client:${r.clientId}:application`);
  assert.match(app.answers, /Growth \(from “Around 10” calls a month\)/);
  assert.equal(Number(app.dealValue), 5000);
  assert.equal(app.soldToStrangers, 'yes');
  assert.equal(app.web_sellsTo, 'Commercial roofing for property managers in Texas');
});

test('the two new booking answers (tried outbound before, what they want from the call) are kept and shown', async () => {
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith') });
  const r = await saveInquiry(site({ tried: 'Used an agency, it did not work', goal: 'Does this work for roofing? <b>' + 'x'.repeat(400) }));
  const { getInquiry: getInq } = await import('@/lib/systems/inquiries');
  const q = await getInq(r.id);
  assert.equal(q.tried, 'Used an agency, it did not work');
  assert.equal(q.goal.length, 300, 'capped');
  const app = await kv.hgetall(`client:${r.clientId}:application`);
  assert.match(app.answers, /Cold email or an outbound agency before/);
  assert.match(app.answers, /What they want from the call/);
});

test('website: "acme.com" is stored as https://acme.com; missing or junk stays empty (older pages, "I don\'t have one yet")', async () => {
  const { normaliseWebsite } = await import('@/lib/systems/inquiries');
  assert.equal(normaliseWebsite('acme.com'), 'https://acme.com');
  assert.equal(normaliseWebsite(' www.acme.co.uk/ '), 'https://www.acme.co.uk');
  assert.equal(normaliseWebsite('https://acme.com/about/'), 'https://acme.com/about');
  assert.equal(normaliseWebsite('http://acme.com'), 'http://acme.com');
  assert.equal(normaliseWebsite('//acme.com'), 'https://acme.com');
  for (const junk of ['', null, undefined, '   ', 'n/a', 'acme', 'javascript:alert(1)', 'ftp://acme.com']) assert.equal(normaliseWebsite(junk), '', String(junk));
  assert.equal(normaliseInquiry(site({ website: 'stoneroofing.com' })).inquiry.website, 'https://stoneroofing.com');
  assert.equal(normaliseInquiry(site({ website: undefined })).inquiry.website, '', 'a missing website is still accepted');
  assert.equal(normaliseInquiry(site({ website: undefined })).errors, undefined);
  assert.equal(normaliseInquiry(site({ website: undefined })).inquiry.noWebsite, false);
  assert.equal(normaliseInquiry(site({ website: '', noWebsite: true })).inquiry.noWebsite, true, '"I don\'t have one yet" ticked');
  assert.equal(normaliseInquiry(site({ website: 'acme.com', noWebsite: true })).inquiry.noWebsite, false, 'a real website wins');
  const r = await saveInquiry(site({ website: '', noWebsite: true }));
  assert.equal(r.ok, true); assert.equal(r.clientId, undefined, 'no website: a plain inquiry, as before');
  const { getInquiry: getInq, inquiryAnswers } = await import('@/lib/systems/inquiries');
  assert.equal((await getInq(r.id)).noWebsite, true);
  assert.deepEqual(inquiryAnswers({ website: '', noWebsite: true }).find((x) => x.q === 'Website'), { q: 'Website', a: 'Does not have one yet' });
});

test('where they came from (?utm_source=cold_call / ref): stored length-limited, in the owner alert and the application answers', async () => {
  const { normaliseSource, sourceWords } = await import('@/lib/systems/inquiries');
  assert.equal(sourceWords('cold_call'), 'Cold call');
  assert.equal(sourceWords('Cold-Call'), 'Cold call');
  assert.equal(sourceWords('linkedin'), 'LinkedIn');
  assert.equal(sourceWords('email'), 'Email');
  assert.equal(sourceWords('podcast_x'), 'podcast_x', 'unknown sources pass through as sent');
  assert.deepEqual(normaliseSource({}), { utm: null, ref: null, cameFrom: null });
  const long = normaliseSource({ utm: { source: '<script>' + 'x'.repeat(500), medium: { evil: 1 } } });
  assert.equal(long.utm.source.length, 100); assert.ok(!/[<>]/.test(long.utm.source));
  assert.equal(normaliseSource({ utm_source: 'linkedin', utm_campaign: 'q4-founders' }).cameFrom, 'LinkedIn (campaign: q4-founders)');
  assert.equal(normaliseSource({ ref: 'email' }).cameFrom, 'Email');

  // No website: a plain inquiry; the owner's alert says "Came from: Cold call".
  const r = await saveInquiry(site({ website: '', utm: { source: 'cold_call', medium: 'phone', campaign: 'nov-roofers' }, ref: 'rehan' }));
  const { getInquiry: getInq } = await import('@/lib/systems/inquiries');
  const q = await getInq(r.id);
  assert.deepEqual(q.utm, { source: 'cold_call', medium: 'phone', campaign: 'nov-roofers', content: null });
  assert.equal(q.ref, 'rehan');
  assert.equal(q.cameFrom, 'Cold call (campaign: nov-roofers, ref: rehan)');
  assert.match(pushed[0].body, /asked about Growth\. Came from: Cold call \(campaign: nov-roofers, ref: rehan\) Call:/, 'on the phone preview too');

  // With a website: a paid application whose answers (and so its owner email) say where they came from.
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith') });
  const r2 = await saveInquiry(site({ email: 'amy@oakroof.com', website: 'oakroof.com', utm_source: 'cold_call', slotStart: '2027-09-30T14:30:00.000Z', slotEnd: '2027-09-30T14:45:00.000Z' }));
  const app = await kv.hgetall(`client:${r2.clientId}:application`);
  assert.ok(JSON.parse(app.answers).some((a) => a.q === 'Came from' && a.a === 'Cold call'));
  assert.equal((await getInq(r2.id)).website, 'https://oakroof.com');

  // An older page with no tracking: nothing added.
  const r3 = await saveInquiry(site({ email: 'cy@elm.com', website: '', slotStart: '2027-09-30T15:00:00.000Z', slotEnd: '2027-09-30T15:15:00.000Z' }));
  const q3 = await getInq(r3.id);
  assert.equal(q3.utm, null); assert.equal(q3.ref, null); assert.equal(q3.cameFrom, null);
  assert.ok(!/Came from/.test(pushed.at(-1).body));
});

test('phone number: optional, kept only when it looks like one, shown in the alert and the application answers', async () => {
  const { normalisePhone, inquiryAnswers, answersText } = await import('@/lib/systems/inquiries');
  assert.equal(normalisePhone('+1 (512) 555-0142'), '+1 (512) 555-0142');
  assert.equal(normalisePhone('512 555 0142 ext 12'), '512 555 0142 ext 12');
  assert.equal(normalisePhone('12345'), null, 'too short');
  assert.equal(normalisePhone('<b>call me</b>'), null, 'not a number');
  assert.equal(normalisePhone(''), null);
  const r = await saveInquiry(site({ website: '', phone: ' +1 512 555 0142 ', slotStart: '2027-09-30T16:00:00.000Z', slotEnd: '2027-09-30T16:15:00.000Z' }));
  const { getInquiry: getInq } = await import('@/lib/systems/inquiries');
  assert.equal((await getInq(r.id)).phone, '+1 512 555 0142');
  assert.match(answersText({ phone: '+1 512 555 0142' }), /Phone: \+1 512 555 0142/);
  assert.ok(inquiryAnswers({ phone: '+1 512 555 0142' }).some((a) => a.q === 'Phone' && a.a === '+1 512 555 0142'));
  const r2 = await saveInquiry(site({ email: 'np@elm.com', website: '', slotStart: '2027-09-30T16:30:00.000Z', slotEnd: '2027-09-30T16:45:00.000Z' }));
  assert.equal((await getInq(r2.id)).phone, null);
  assert.ok(!inquiryAnswers({}).some((a) => a.q === 'Phone'));
});
