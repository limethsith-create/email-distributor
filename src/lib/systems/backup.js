/**
 * Backup export / import (SPEC §10.3, §14.9). The export is every key in the
 * database as JSON, minus secrets: inbox passwords, page tokens, sessions,
 * idempotency claims and throttles never leave Redis.
 */

import { kv } from '@vercel/kv';

const EXCLUDE = [/^session:/, /^jobs:claim:/, /:token:/, /^throttle:/, /^claim:/, /^lead:.*:claim$/, /_lock$/, /^google:(access$|state:)/, /^cheapinboxes:(syncedat$|wake:)/, /^secrets$/];
// The Google keys and token (google:oauth) stay in Redis too: after a restore the owner reconnects.
// Same for CheapInboxes (cheapinboxes:account): the API key and the webhook secret never leave
// Redis; after a restore he pastes the key again. An inbox's login password (loginPasswordEnc,
// CheapInboxes inboxes) is stripped like its app password. The keys store (`secrets`, lib/secrets.js)
// is left out whole: the owner pastes his service keys again in Settings › Keys.
const SECRET_FIELDS = new Set(['passwordEnc', 'loginPasswordEnc', 'password', 'appPassword', 'clientIdEnc', 'clientSecretEnc', 'refreshTokenEnc', 'apiKeyEnc', 'webhookSecretEnc']);

function stripSecrets(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (!SECRET_FIELDS.has(k)) out[k] = v;
  return out;
}

async function allKeys() {
  const keys = [];
  let cursor = '0';
  do {
    const [next, batch] = await kv.scan(cursor, { count: 500 });
    cursor = String(next);
    keys.push(...batch);
  } while (cursor !== '0' && keys.length < 200_000);
  return keys.filter((k) => !EXCLUDE.some((re) => re.test(k))).sort();
}

export async function exportAll() {
  const keys = await allKeys();
  const out = [];
  for (let i = 0; i < keys.length; i += 200) {
    const part = keys.slice(i, i + 200);
    const tp = kv.pipeline();
    for (const k of part) tp.type(k);
    const types = await tp.exec();
    const vp = kv.pipeline();
    part.forEach((k, j) => {
      const t = types[j];
      if (t === 'hash') vp.hgetall(k);
      else if (t === 'set') vp.smembers(k);
      else if (t === 'list') vp.lrange(k, 0, -1);
      else if (t === 'zset') vp.zrange(k, 0, -1, { withScores: true });
      else vp.get(k);
    });
    const values = await vp.exec();
    part.forEach((k, j) => {
      const type = types[j];
      let value = values[j];
      if (type === 'hash') {
        value = stripSecrets(value);
        // inbox:{id}:{email} records and any nested JSON with a password field
        for (const [f, v] of Object.entries(value || {})) if (v && typeof v === 'object' && !Array.isArray(v)) value[f] = stripSecrets(v);
      }
      out.push({ key: k, type, value });
    });
  }
  return { exportedAt: new Date().toISOString(), count: out.length, keys: out };
}

/** Restore a snapshot. Overwrites each key it contains; touches nothing else. */
export async function importAll(snapshot) {
  const rows = Array.isArray(snapshot?.keys) ? snapshot.keys : [];
  let restored = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const p = kv.pipeline();
    for (const { key, type, value } of rows.slice(i, i + 100)) {
      if (!key || value == null) continue;
      p.del(key);
      if (type === 'hash' && Object.keys(value).length) p.hset(key, value);
      else if (type === 'set' && value.length) p.sadd(key, ...value);
      else if (type === 'list' && value.length) p.rpush(key, ...value);
      else if (type === 'zset' && value.length) {
        for (let j = 0; j < value.length; j += 2) p.zadd(key, { score: Number(value[j + 1]), member: value[j] });
      } else if (type === 'string') p.set(key, value);
      restored++;
    }
    await p.exec();
  }
  return { restored };
}
