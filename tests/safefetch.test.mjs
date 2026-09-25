// SSRF guard for outside addresses (lib/safefetch.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { isPrivateAddress, safeFetch, safeLookup } from '@/lib/safefetch';

test('private, loopback, link-local, CGNAT, mapped and reserved addresses are refused', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', 'not-an-ip']) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('names that resolve to private addresses are refused in the socket lookup', async () => {
  const err = await new Promise((resolve) => safeLookup('localhost', {}, (e) => resolve(e)));
  assert.equal(err?.code, 'EBLOCKED');
});

test('safeFetch never reaches the machine itself: literals, localhost, other schemes, credentials', async () => {
  const server = http.createServer((req, res) => { res.end('internal secret'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const was = globalThis.__blockSafeFetch;
  globalThis.__blockSafeFetch = false;
  try {
    for (const url of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`, `http://2130706433:${port}/`, `http://0x7f.1:${port}/`, 'file:///etc/passwd', `http://user:pw@example.com/`, 'http://metadata.google.internal/']) {
      await assert.rejects(safeFetch(url, { timeoutMs: 3000 }), (e) => e.code === 'EBLOCKED', url);
    }
  } finally {
    globalThis.__blockSafeFetch = was;
    server.close();
  }
});

test('security: cron key in the header only, sessions, redirects after sign-in, push hosts', async () => {
  const { cronAuthorized, makeSession, verifySession, safeNext, HUB_SESSION_HOURS } = await import('@/lib/auth/session');
  const { pushHostAllowed } = await import('@/lib/push');
  const req = (headers, url = 'https://x/api/cron/tick') => new Request(url, { headers });
  assert.equal(cronAuthorized(req({ authorization: 'Bearer s3cret' }), 's3cret'), true);
  assert.equal(cronAuthorized(req({}, 'https://x/api/cron/tick?token=s3cret'), 's3cret'), false, 'no key in the address');
  assert.equal(cronAuthorized(req({ authorization: 'Bearer ' }), ''), false, 'no secret set: nobody gets in');
  const hub = await makeSession('pw', { hours: HUB_SESSION_HOURS });
  assert.ok(Number(hub.split('.')[0]) < Date.now() + 13 * 3600e3);
  assert.equal(await verifySession(hub, 'pw'), true);
  const old = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'rotated';
  assert.equal(await verifySession(hub, 'pw'), false, 'changing SESSION_SECRET signs every device out');
  if (old === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = old;
  for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', '/leads', '/mcevil', '/mc\r\nSet-Cookie:x']) assert.equal(safeNext(bad), '/mc', bad);
  for (const good of ['/mc', '/mc/clients/acme', '/mc?x=1']) assert.equal(safeNext(good), good);
  assert.equal(pushHostAllowed('https://web.push.apple.com/abc'), true);
  assert.equal(pushHostAllowed('https://fcm.googleapis.com/fcm/send/abc'), true);
  assert.equal(pushHostAllowed('https://evil.example/collect'), false);
  assert.equal(pushHostAllowed('http://fcm.googleapis.com/x'), false);
});
