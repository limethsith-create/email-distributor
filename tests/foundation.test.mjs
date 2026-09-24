import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { K, assertClientId, slugify, clientKeyPatterns } from '@/lib/db/keys';
import { fill, TemplateError, slotsOf } from '@/lib/templates/render';
import { trialDay, tzForState, partsIn, addDays, daysBetween } from '@/lib/time';
import { cfg, HARD_COLD_CAP } from '@/lib/config';
import { canTransition, createClient, setState, getClient } from '@/lib/db/client';
import { makeSession, verifySession, secretMatches } from '@/lib/auth/session';
import { __reset } from '@vercel/kv';

test('client ids are validated and keys are scoped', () => {
  assert.equal(K.leads('acme-plumbing'), 'client:acme-plumbing:leads');
  assert.equal(K.inbox('acme', 'Bob@X.com'), 'inbox:acme:bob@x.com');
  assert.equal(K.suppression(), 'suppression:global');
  for (const bad of ['', 'Acme', 'a b', 'x:y', '../etc', '-acme']) assert.throws(() => assertClientId(bad));
  assert.equal(slugify('https://www.Acme-Plumbing.com/about'), 'acme-plumbing');
  assert.deepEqual(clientKeyPatterns('acme'), ['client:acme:*', 'inbox:acme:*', 'pacing:acme', 'lead:acme:*']);
});

test('templates never render a blank', () => {
  assert.equal(fill('t', 'Hi {FirstName}', { FirstName: 'Ann' }), 'Hi Ann');
  assert.throws(() => fill('t', 'Hi {FirstName} at {Company}', { FirstName: 'Ann', Company: '' }), (e) => e instanceof TemplateError && e.missing[0] === 'Company');
  assert.deepEqual(slotsOf('{a} {b} {a}'), ['a', 'b']);
});

test('trial day arithmetic', () => {
  const now = new Date('2026-10-15T15:00:00Z');
  assert.equal(trialDay({ day1Date: '2026-10-15' }, now), 1);
  assert.equal(trialDay({ day1Date: '2026-10-01' }, now), 15);
  assert.equal(trialDay({ signedDay: '2026-10-14', day1Date: '2026-10-28' }, now), -13);
  assert.equal(trialDay({}, now), null);
  assert.equal(addDays('2026-10-30', 3), '2026-11-02');
  assert.equal(daysBetween('2026-10-01', '2026-10-31'), 30);
});

test('time zones', () => {
  assert.equal(tzForState('TX'), 'America/Chicago');
  assert.equal(tzForState('California'), 'America/Los_Angeles');
  assert.equal(tzForState('NY'), 'America/New_York');
  assert.equal(tzForState(''), 'America/New_York');
  const p = partsIn('America/New_York', new Date('2026-09-24T13:30:00Z'));
  assert.equal(p.hhmm, '09:30');
  assert.equal(p.weekday, 'Thu');
});

test('config defaults, overrides and hard caps', async () => {
  __reset();
  assert.equal(await cfg(null, 'MAX_ACTIVE_TRIALS'), 3);
  assert.deepEqual(await cfg(null, 'FIT.employeesMin'), 5);
  const { kv } = await import('@vercel/kv');
  await kv.hset('system:config', { COLD_CAP: JSON.stringify(90) });
  assert.equal(await cfg(null, 'COLD_CAP'), HARD_COLD_CAP);
  await kv.hset('client:acme:config', { MAX_ACTIVE_TRIALS: '5' });
  assert.equal(await cfg('acme', 'MAX_ACTIVE_TRIALS'), 5);
});

test('inbox passwords round-trip through AES-256-GCM', async () => {
  process.env.ENC_KEY = crypto.randomBytes(32).toString('base64');
  const { encrypt, decrypt } = await import('@/lib/crypto');
  const blob = encrypt('abcd efgh ijkl mnop');
  assert.ok(blob.startsWith('v1.') && !blob.includes('abcd'));
  assert.equal(decrypt(blob), 'abcd efgh ijkl mnop');
  const tampered = blob.slice(0, -2) + (blob.endsWith('A') ? 'BB' : 'AA');
  assert.throws(() => decrypt(tampered));
});

test('admin sessions', async () => {
  const s = await makeSession('s3cret');
  assert.ok(await verifySession(s, 's3cret'));
  assert.ok(!(await verifySession(s, 'other')));
  assert.ok(!(await verifySession(`1.${s.split('.')[1]}`, 's3cret')));
  assert.ok(!(await verifySession(s, undefined)));
  assert.ok(secretMatches('abc', 'abc') && !secretMatches('abc', '') && !secretMatches('', ''));
});

test('state machine only allows legal moves', async () => {
  __reset();
  assert.ok(canTransition('applied', 'onboarding'));
  assert.ok(!canTransition('applied', 'sending'));
  await createClient('acme', { name: 'Acme' });
  await assert.rejects(() => createClient('acme'));
  await assert.rejects(() => setState('acme', 'sending'));
  assert.equal(await setState('acme', 'onboarding', 'fit passed'), true);
  assert.equal(await setState('acme', 'onboarding'), false);
  assert.equal((await getClient('acme')).state, 'onboarding');
});
