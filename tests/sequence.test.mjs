import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSequence, varsFor, renderTouch, sequenceReady, TemplateError } from '@/lib/systems/sequence';
import { __reset } from '@vercel/kv';

const lead = { email: 'ann@acme.com', first_name: 'Ann', company: 'Acme IT', city: 'Dallas', marketCount: 612, sizeBand: '10-50', dealValue: '5,000' };
const profile = { senderName: 'Limethsith', postalAddress: '1 Main St, Dover, DE 19901', defaultNiche: 'IT service companies', defaultIcp: 'small offices near you' };

test('Sequence T renders all four touches when every slot has a value', async () => {
  __reset();
  const seq = await getSequence('aviance');
  assert.equal(seq.touches.length, 4);
  const vars = varsFor(lead, { profile });
  const d0 = renderTouch(seq, 'd0', vars);
  assert.equal(d0.subject, '30-day trial for Acme IT');
  assert.match(d0.body, /^Hi Ann,/);
  assert.match(d0.body, /book sales calls for IT service companies/);
  assert.doesNotMatch(d0.body, /https?:\/\/|www\./);
  assert.match(d0.text, /1 Main St, Dover, DE 19901/);
  assert.match(d0.text, /reply STOP/);
  const d7 = renderTouch(seq, 'd7', vars);
  assert.equal(d7.subject, '612 companies in Dallas');
  assert.match(d7.body, /worth \$5,000/);
  assert.equal(renderTouch(seq, 'd3', vars).thread, 'd0');
  assert.equal(renderTouch(seq, 'd10', vars).thread, 'd7');
});

test('a missing value blocks that touch instead of sending a blank', async () => {
  const seq = await getSequence('aviance');
  const vars = varsFor({ ...lead, marketCount: undefined }, { profile });
  assert.throws(() => renderTouch(seq, 'd7', vars), (e) => e instanceof TemplateError && e.missing.includes('Count'));
  assert.throws(() => renderTouch(seq, 'd0', varsFor({ ...lead, first_name: '' , name: ''}, { profile })), TemplateError);
});

test('sending is held until the footer (name + postal address) can render', async () => {
  __reset();
  const notReady = await sequenceReady('aviance', { profile: { senderName: 'L' } });
  assert.equal(notReady.ok, false);
  assert.ok(notReady.missing.includes('postalAddress'));
  assert.equal((await sequenceReady('aviance', { profile })).ok, true);
});
