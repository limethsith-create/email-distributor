// The product fixes the two-client run (tests/two-clients.test.mjs) found,
// each on its own: a long one-word domain gets sending names, the client's
// own acronym and sentence pass the Copy Checker, a paying client never counts
// as a trial, gets no trial wording and is invoiced at the plan agreement, its
// website request moves on when the owner answers it, and a thank-you after
// onboarding needs no answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kv, __reset } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { DEFAULTS } from '@/lib/config';
import { createClient } from '@/lib/db/client';
import { generateCandidates, rankCandidates, brandStems } from '@/lib/systems/domains';
import { checkEmail, clientAcronyms } from '@/lib/systems/copycheck';
import { renderTemplate } from '@/lib/templates/client';
import { boardData } from '@/lib/systems/boarddata';
import { clientButtonsText } from '@/lib/systems/clientwatch';
import { saveInquiry, getInquiry, settleInquiryFor } from '@/lib/systems/inquiries';
import { onInbound } from '@/lib/systems/replybot';

const D = DEFAULTS.DOMAINS;
const TRIAL_WORDS = /\b(trial|30-day|Day 30)\b/i;

test('a long one-word domain gets sending names from the company name (it used to get none)', () => {
  assert.deepEqual(generateCandidates('harbordentalgroup.com', D, ['com']), [], 'the domain alone gives nothing that fits 15 letters');
  const names = rankCandidates('harbordentalgroup.com', D, ['com'], 'Harbor Dental Group').map((c) => c.domain);
  assert.ok(names.includes('harborhq.com') && names.includes('getharbor.com'), names.join(', '));
  assert.ok(rankCandidates('summitroofingco.com', D, ['com'], 'Summit Roofing Co').some((c) => c.domain === 'summithq.com'));
  // A domain that already gives names keeps exactly the same list (the company name is only a fallback).
  assert.deepEqual(rankCandidates('ridgelineit.com', D, ['com'], 'Ridgeline IT'), rankCandidates('ridgelineit.com', D, ['com']));
  // Only leading words the domain really starts with.
  assert.deepEqual(brandStems('harbordentalgroup.com', 'Casco Bay Dental').map((x) => x.stem), ['harbordentalgroup']);
});

test('Copy Checker: the client’s own acronym is not shouting, and their own sentence is not graded', () => {
  const profile = { senderName: 'Jordan Blake', postalAddress: '4400 Brighton Blvd, Denver, CO 80216', sellsTo: 'We inspect and maintain commercial roofs for property managers and HOAs across the Denver metro.', defaultIcp: 'property managers and HOA boards' };
  assert.deepEqual(clientAcronyms(profile), ['HOA']);
  const body = `Hi Carl,\n\nFor a lot of property managers and HOA boards, small repairs wait weeks for a crew and then turn into big ones.\n\n${profile.sellsTo}\n\nWho do you call today when something needs fixing?`;
  const text = `${body}\n\nJordan Blake\n${profile.postalAddress}\n\nIf this isn't for you, reply STOP and I won't email you again.`;
  const r = checkEmail({ touch: 'd0', subject: 'who you call', body, text }, profile);
  assert.deepEqual(r.failures, []);
  // Shouting the client did not write is still caught.
  const loud = checkEmail({ touch: 'd0', subject: 'who you call', body: body.replace('small repairs', 'SMALL repairs'), text: text.replace('small repairs', 'SMALL repairs') }, profile);
  assert.deepEqual(loud.failures.map((f) => f.rule), ['all_caps']);
});

test('a paying client: not a trial on the board, no trial words in its emails, no "Stop the trial" button', async () => {
  __reset();
  process.env.ENC_KEY = process.env.ENC_KEY || Buffer.alloc(32, 3).toString('base64');
  await createClient('summit', { name: 'Summit', plan: 'growth', state: 'onboarding', contactEmail: 'j@summit.test' });
  await createClient('harbor', { name: 'Harbor', plan: 'trial', state: 'onboarding', contactEmail: 'm@harbor.test' });
  assert.equal((await boardData(new Date())).activeTrials, 1, 'only the trial counts against the trial cap');
  assert.doesNotMatch(await clientButtonsText('summit'), /Stop the trial/);
  assert.match(await clientButtonsText('harbor'), /Stop the trial/);
  const vars = { firstName: 'Jordan', day1Date: 'Thursday 22 October', startWhen: 'Thursday 22 October at 9:00 am', inWhoseName: 'in your name', inboxes: 'a@x.example', sendWindow: '9–5', day30Date: 'Friday 20 November', ownerName: 'Limeth', Name: 'Carl', Company: 'Dalton', invoiceNo: 'AV-1', planName: 'Growth', issuedDate: 'Wed 7 Oct', priceText: '$3,997', calls: 20, paymentLines: 'PayPal: x', bonusLine: 'x' };
  for (const key of ['welcome_two_dates_paid', 'quote_request_paid', 'invoice_plan_start']) {
    const m = renderTemplate(key, vars);
    assert.doesNotMatch(`${m.subject}\n${m.text}`, TRIAL_WORDS, key);
  }
  assert.doesNotMatch(renderTemplate('invoice_plan_start', vars).text, /bonus|trial domain/i);
});

test('the website request behind a paid application: yes → contacted, agreement → won, no → lost', async () => {
  __reset();
  const r = await saveInquiry({ name: 'Jordan Blake', email: 'jordan@summit.test', company: 'Summit', sells: 'roofs', plan: 'growth' });
  await kv.hset(K.inquiries(), { [r.id]: { ...(await getInquiry(r.id)), clientId: 'summit' } });
  await settleInquiryFor('summit', 'contacted', 'said yes');
  assert.equal((await getInquiry(r.id)).status, 'contacted');
  await settleInquiryFor('summit', 'won', 'signed');
  assert.equal((await getInquiry(r.id)).status, 'won');
  await settleInquiryFor('summit', 'lost', 'late no');
  assert.equal((await getInquiry(r.id)).status, 'won', 'only forward: a won request stays won');
  assert.equal(await settleInquiryFor('nobody', 'won'), null);
});

test('a plain thank-you after onboarding needs no answer (no alert, no red dot)', async () => {
  __reset();
  const client = { id: 'harbor', name: 'Harbor', contactName: 'Megan Ortiz', state: 'sending', plan: 'trial' };
  const thanks = await onInbound(client, {}, { entryId: 'in-1', at: new Date().toISOString(), text: 'Perfect — thanks!\n\nMegan', from: 'megan@harbor.test' });
  assert.deepEqual(thanks, { rule: 'thanks', alert: false });
  const question = await onInbound(client, {}, { entryId: 'in-2', at: new Date().toISOString(), text: 'Can we add Portsmouth?', from: 'megan@harbor.test' });
  assert.equal(question.alert, true, 'a real question is still the owner’s');
});
