import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySmtpError, plainAuthError, GMAIL_AUTH_PLAIN } from '@/lib/mailer';
import { parseAccount, getSmtpAccounts } from '@/lib/smtp-accounts';

test('an app password pasted with spaces is cleaned', () => {
  const a = parseAccount('me@gmail.com:abcd efgh ijkl mnop:Me', 1);
  assert.equal(a.password, 'abcdefghijklmnop');
  assert.equal(a.appPassword, 'abcdefghijklmnop');
  assert.equal(a.smtp.host, 'smtp.gmail.com');
  assert.equal(a.smtp.port, 465);
  assert.equal(a.smtp.secure, true);
});

test('Gmail 534 / 535 become a plain sentence', () => {
  const err = Object.assign(new Error('Invalid login: 534-5.7.9 Please log in with your web browser'), { code: 'EAUTH', responseCode: 534, command: 'AUTH PLAIN' });
  const f = classifySmtpError(err);
  assert.equal(f.kind, 'auth');
  const acct = parseAccount('me@gmail.com:abcdefghijklmnop', 1);
  assert.equal(plainAuthError(f, acct), GMAIL_AUTH_PLAIN);
  assert.match(GMAIL_AUTH_PLAIN, /app password/);
  const f535 = classifySmtpError(Object.assign(new Error('bad'), { responseCode: 535 }));
  assert.equal(plainAuthError(f535, acct), GMAIL_AUTH_PLAIN);
});

test('a non-login failure has no plain login text', () => {
  const f = classifySmtpError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }));
  assert.equal(plainAuthError(f, null), null);
});

test('GMAIL_ADDRESS + GMAIL_APP_PASSWORD makes a Gmail inbox', () => {
  process.env.GMAIL_ADDRESS = 'owner@gmail.com';
  process.env.GMAIL_APP_PASSWORD = 'wxyz wxyz wxyz wxyz';
  const a = getSmtpAccounts().find((x) => x.email === 'owner@gmail.com');
  assert.ok(a);
  assert.equal(a.password, 'wxyzwxyzwxyzwxyz');
  assert.equal(a.provider, 'google');
});
