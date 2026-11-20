import { test } from 'node:test';
import assert from 'node:assert/strict';
import { varsFor, renderTouch, TemplateError } from '@/lib/systems/sequence';

const lead = { email: 'ann@acme.com', first_name: 'Ann', company: 'Acme IT', city: 'Dallas', marketCount: 612, sizeBand: '10-50', dealValue: '5,000' };
const profile = { senderName: 'Limethsith', postalAddress: '1 Main St, Dover, DE 19901', defaultNiche: 'IT service companies', defaultIcp: 'small offices near you' };

// A small four-touch sequence in the shape systems/copy.js stores for a client.
const SEQ = {
  name: 'test', version: 1,
  footer: '{SenderName}\n{postalAddress}\n\nIf this isn\'t for you, reply STOP and I won\'t email you again.',
  touches: [
    { touch: 'd0', day: 0, thread: 'new', subject: 'Calls for {Company}', body: 'Hi {FirstName},\n\nWe help {niche} reach {ICP}. Worth a chat?' },
    { touch: 'd3', day: 3, thread: 'd0', body: '{FirstName}, one more thought for {Company}.' },
    { touch: 'd7', day: 7, thread: 'new', subject: '{Count} companies in {City}', body: '{FirstName}, there are {Count} businesses near {City} with {size} staff. One customer is worth ${dealValue}.' },
    { touch: 'd10', day: 10, thread: 'd7', body: '{FirstName}, I\'ll close the file on {Company} for now.' },
  ],
};

test('a sequence renders all four touches when every slot has a value', () => {
  const vars = varsFor(lead, { profile });
  const d0 = renderTouch(SEQ, 'd0', vars);
  assert.equal(d0.subject, 'Calls for Acme IT');
  assert.match(d0.body, /^Hi Ann,/);
  assert.match(d0.body, /We help IT service companies reach small offices near you/);
  assert.match(d0.text, /1 Main St, Dover, DE 19901/);
  assert.match(d0.text, /reply STOP/);
  const d7 = renderTouch(SEQ, 'd7', vars);
  assert.equal(d7.subject, '612 companies in Dallas');
  assert.match(d7.body, /worth \$5,000/);
  assert.equal(renderTouch(SEQ, 'd3', vars).thread, 'd0');
  assert.equal(renderTouch(SEQ, 'd10', vars).thread, 'd7');
});

test('a missing value blocks that touch instead of sending a blank', () => {
  const vars = varsFor({ ...lead, marketCount: undefined }, { profile });
  assert.throws(() => renderTouch(SEQ, 'd7', vars), (e) => e instanceof TemplateError && e.missing.includes('Count'));
  assert.throws(() => renderTouch(SEQ, 'd0', varsFor({ ...lead, first_name: '', name: '' }, { profile })), TemplateError);
  // The footer (name + postal address) is required on every cold email.
  assert.throws(() => renderTouch(SEQ, 'd0', varsFor(lead, { profile: { ...profile, postalAddress: '' } })), (e) => e instanceof TemplateError && e.missing.includes('postalAddress'));
});
