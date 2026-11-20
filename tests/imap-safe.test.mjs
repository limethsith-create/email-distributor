import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { guardImap, closeImap } from '@/lib/imap-safe';

// A refused Gmail sign-in must never crash the function (it did: "Unhandled Rejection … logout").
test('a dead connection is closed, not logged out; nothing throws or rejects', async () => {
  let loggedOut = 0; let closed = 0;
  const c = Object.assign(new EventEmitter(), { usable: false, logout: () => { loggedOut++; return Promise.reject(new Error('Connection not available')); }, close: () => { closed++; } });
  guardImap(c);
  c.emit('error', new Error('auth failed'));   // no listener would throw here
  await closeImap(c);
  assert.equal(loggedOut, 0);
  assert.equal(closed, 1);
});

test('a live connection logs out (and a logout that rejects or hangs is fine)', async () => {
  let closed = 0;
  const ok = { usable: true, on() {}, logout: async () => {}, close: () => { closed++; } };
  await closeImap(ok);
  const bad = { usable: true, on() {}, logout: () => Promise.reject(new Error('x')), close: () => { closed++; } };
  await closeImap(bad);
  const hang = { usable: true, on() {}, logout: () => new Promise(() => {}), close: () => { closed++; } };
  await closeImap(hang, 20);
  assert.equal(closed, 3);
});
