/**
 * The keys store (docs/KEYS.md; the hub's Settings › Keys) — every service
 * key the machine needs, pasted once by the owner in the hub instead of set
 * in Vercel.
 *
 *  - secretOf(name): env wins (process.env[name]), else the owner's value
 *    from the `secrets` hash, ENC_KEY-encrypted (lib/crypto.js) like the
 *    Google and CheapInboxes keys. Never returned by any API and never in a
 *    backup (systems/backup.js leaves the whole hash out).
 *  - setSecret / forgetSecret: what the hub's Save and Forget end in
 *    (systems/keys.js checks a key with the service before it lets setSecret
 *    store it).
 *  - secretStatus(): per key { name, label, set, from: env|hub|null,
 *    testedAt, ok, problem } — never a value.
 *  - GITHUB_REPO is a plain setting (owner/repository), not a secret: stored
 *    as it is and shown in the hub.
 *
 * A warm instance keeps the hash for CFG_MEMO_MS (a minute; 0 in tests), so
 * the verifiers and the Places client do not read Redis on every call, and a
 * caller that checks several keys at once passes one snapshot around.
 *
 * No AI anywhere.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { encrypt, decrypt, hasEncKey } from '@/lib/crypto';
import { logEvent } from '@/lib/db/events';

const SYSTEM = 'keys';
export const DEFAULT_REPO = 'limethsith-create/email-distributor';
const REPO_RE = /^[A-Za-z0-9_.-]{1,80}\/[A-Za-z0-9_.-]{1,100}$/;

/**
 * What the hub shows, one card each. `fields` are the env names behind a card
 * (Verifalia is a login: two). `parts` names the body fields of a save for a
 * two-field card. `needs` lists the fields a check reads (the GitHub check
 * needs both the token and the repository).
 */
export const CARDS = [
  { name: 'PLACES_API_KEY', short: 'Google Places key', label: 'Google Places key — finds businesses, reads reviews and market size', fields: ['PLACES_API_KEY'] },
  { name: 'QUICKEMAILVERIFICATION_API_KEY', short: 'QuickEmailVerification key', label: 'QuickEmailVerification key — checks 100 addresses a day free', fields: ['QUICKEMAILVERIFICATION_API_KEY'] },
  { name: 'VERIFALIA', short: 'Verifalia login', label: 'Verifalia login — 25 a day free', fields: ['VERIFALIA_USERNAME', 'VERIFALIA_PASSWORD'], parts: { username: 'VERIFALIA_USERNAME', password: 'VERIFALIA_PASSWORD' } },
  { name: 'REOON_API_KEY', short: 'Reoon key', label: 'Reoon key — 20 a day free', fields: ['REOON_API_KEY'] },
  { name: 'ZEROBOUNCE_API_KEY', short: 'ZeroBounce key', label: 'ZeroBounce key — 100 a month free', fields: ['ZEROBOUNCE_API_KEY'], optional: true },
  { name: 'HUNTER_API_KEY', short: 'Hunter key', label: 'Hunter key — about 100 checks a month free (optional)', fields: ['HUNTER_API_KEY'], optional: true },
  { name: 'GITHUB_TOKEN', short: 'GitHub token', label: 'GitHub token — starts the lead finder', fields: ['GITHUB_TOKEN'], needs: ['GITHUB_TOKEN', 'GITHUB_REPO'] },
  { name: 'GITHUB_REPO', short: 'GitHub repository', label: 'GitHub repository — where the lead finder runs (leave the default unless it moved)', fields: ['GITHUB_REPO'], needs: ['GITHUB_TOKEN', 'GITHUB_REPO'], secret: false, default: DEFAULT_REPO },
];
/** Every env name the store knows. */
export const FIELDS = CARDS.flatMap((c) => c.fields);

/** The card behind a card name or one of its env names; null for anything else. */
export const cardOf = (name) => CARDS.find((c) => c.name === name || c.fields.includes(String(name || ''))) || null;
const isSecretField = (field) => (cardOf(field) || {}).secret !== false;

// ─── errors in plain words ───────────────────────────────────────────────────

const WORDS = {
  unknown_key: 'That is not a key the machine knows.',
  no_enc_key: 'ENC_KEY is not set on the server, so keys cannot be stored safely yet.',
  bad_value: 'Paste the whole key, with no spaces or line breaks.',
  bad_repo: `The repository must look like owner/repository, for example ${DEFAULT_REPO}.`,
  not_set: 'This key is not set yet — paste it first.',
  timeout: "The service didn't answer in time.",
  network: "The service couldn't be reached.",
};
const HTTP = { unknown_key: 400, no_enc_key: 503, bad_value: 400, bad_repo: 400, env_key: 409, not_set: 409, refused: 400 };

/** A keys problem: `code` for the machine, the message for the owner. */
export class KeysError extends Error {
  constructor(code, message = null) { super(message || WORDS[code] || code); this.code = code; this.status = HTTP[code] || 502; }
}

// ─── the stored hash ─────────────────────────────────────────────────────────

const open = (v) => { try { return v ? decrypt(v) : null; } catch { return null; } };
const envOf = (field) => String(process.env[field] || '').trim() || null;
const str = (v) => (v === null || v === undefined ? null : String(v));

let memo = null;
const memoMs = () => Number(process.env.CFG_MEMO_MS ?? 60_000);
const forgetMemo = () => { memo = null; };

/** The hash as stored (encrypted values + meta). One Redis read per CFG_MEMO_MS. */
export async function secretsSnapshot() {
  const ms = memoMs();
  if (memo && ms > 0 && Date.now() - memo.at < ms) return memo.hash;
  let hash = {};
  try { hash = (await kv.hgetall(K.secrets())) || {}; } catch { hash = {}; }
  memo = { at: Date.now(), hash };
  return hash;
}

/** The hub's value of one field from a snapshot (decrypted), or null. */
function hubValue(field, hash) {
  const raw = hash[field];
  if (raw === undefined || raw === null || raw === '') return null;
  return isSecretField(field) ? open(raw) : String(raw).trim() || null;
}

/**
 * The value to use for one env name: env wins, else the owner's. Null when
 * neither (GITHUB_REPO's default is the caller's business: ext/github.js).
 * `snap` (from secretsSnapshot) saves the Redis read when checking several.
 */
export async function secretOf(field, snap = null) {
  const env = envOf(field);
  if (env) return env;
  if (!FIELDS.includes(field)) return null;
  return hubValue(field, snap || await secretsSnapshot());
}

/** Where a field's value comes from: 'env' | 'hub' | null. */
export function sourceOf(field, hash) {
  if (envOf(field)) return 'env';
  return hubValue(field, hash) ? 'hub' : null;
}

/** One pasted value, checked: no blanks inside, a sane length; a repository must look like owner/name. */
export function cleanValue(field, raw) {
  const v = String(raw ?? '').trim();
  if (field === 'GITHUB_REPO') {
    if (!REPO_RE.test(v)) throw new KeysError('bad_repo');
    return v;
  }
  if (!v || v.length > 500 || /\s/.test(v)) throw new KeysError('bad_value');
  return v;
}

const metaFields = (name) => [`${name}:savedAt`, `${name}:testedAt`, `${name}:ok`, `${name}:problem`, `${name}:detail`];
const okWord = (ok) => (ok === true ? '1' : ok === false ? '0' : '');

/**
 * Store a card's value(s): `value` is the string for a one-field card, or
 * `{ username, password }` for Verifalia. `test` ({ ok, problem, detail },
 * from systems/keys.js) is kept beside it. Throws KeysError (env set, bad
 * value, no ENC_KEY, unknown key). Never logs a value.
 */
export async function setSecret(name, value, { now = new Date(), test = null } = {}) {
  const card = cardOf(name);
  if (!card) throw new KeysError('unknown_key');
  const envField = card.fields.find((f) => envOf(f));
  if (envField) throw new KeysError('env_key', `The ${card.short} is set on the server (${envField}) — change it there.`);
  const values = {};
  if (card.parts) {
    const v = value && typeof value === 'object' ? value : {};
    for (const [part, field] of Object.entries(card.parts)) values[field] = cleanValue(field, v[part]);
  } else {
    values[card.fields[0]] = cleanValue(card.fields[0], value);
  }
  if (card.secret !== false && !hasEncKey()) throw new KeysError('no_enc_key');
  const at = now.toISOString();
  const fields = { [`${card.name}:savedAt`]: at };
  for (const [field, v] of Object.entries(values)) fields[field] = isSecretField(field) ? encrypt(v) : v;
  Object.assign(fields, testFields(card.name, test, at));
  await kv.hset(K.secrets(), fields);
  forgetMemo();
  return secretStatusOf(card.name);
}

function testFields(name, test, at) {
  if (!test) return { [`${name}:testedAt`]: '', [`${name}:ok`]: '', [`${name}:problem`]: '', [`${name}:detail`]: '' };
  return { [`${name}:testedAt`]: at, [`${name}:ok`]: okWord(test.ok), [`${name}:problem`]: String(test.problem || '').slice(0, 300), [`${name}:detail`]: String(test.detail || '').slice(0, 300) };
}

/** Keep a test's outcome for a card (the value stays as it is; works for env keys too). */
export async function noteTest(name, test, { now = new Date() } = {}) {
  const card = cardOf(name);
  if (!card) throw new KeysError('unknown_key');
  await kv.hset(K.secrets(), testFields(card.name, test, now.toISOString()));
  forgetMemo();
  return secretStatusOf(card.name);
}

/** Forget a card's hub value(s) and their test. An env value is untouched (status keeps saying `env`). */
export async function forgetSecret(name) {
  const card = cardOf(name);
  if (!card) throw new KeysError('unknown_key');
  await kv.hdel(K.secrets(), ...card.fields, ...metaFields(card.name));
  forgetMemo();
  await logEvent(null, SYSTEM, 'key_forgotten', { name: card.name });
  return secretStatusOf(card.name);
}

// ─── status (never a value) ──────────────────────────────────────────────────

function statusFrom(card, hash) {
  const sources = card.fields.map((f) => sourceOf(f, hash));
  const set = sources.every(Boolean);
  const ok = str(hash[`${card.name}:ok`]);
  return {
    name: card.name,
    label: card.label,
    short: card.short,
    optional: Boolean(card.optional),
    secret: card.secret !== false,
    fields: card.fields,
    ...(card.parts ? { parts: Object.keys(card.parts) } : {}),
    set,
    from: !set ? (sources.find(Boolean) || null) : sources.every((s) => s === 'env') ? 'env' : sources.every((s) => s === 'hub') ? 'hub' : 'env',
    savedAt: str(hash[`${card.name}:savedAt`]) || null,
    testedAt: str(hash[`${card.name}:testedAt`]) || null,
    ok: ok === '1' ? true : ok === '0' ? false : null,
    problem: str(hash[`${card.name}:problem`]) || null,
    detail: str(hash[`${card.name}:detail`]) || null,
    // A plain setting is shown; a secret never is.
    ...(card.secret === false ? { value: envOf(card.fields[0]) || hubValue(card.fields[0], hash) || null, default: card.default || null } : {}),
  };
}

/** Every card: { name, label, set, from, testedAt, ok, problem, … } — never a secret's value. */
export async function secretStatus() {
  const hash = await secretsSnapshot();
  return CARDS.map((c) => statusFrom(c, hash));
}

/** One card's status. */
export async function secretStatusOf(name) {
  const card = cardOf(name);
  if (!card) throw new KeysError('unknown_key');
  return statusFrom(card, await secretsSnapshot());
}

/**
 * What the Lead Finder job gets with the profile (GET /api/clients/{id}/profile,
 * LEADFINDER_TOKEN only): the keys it may need, from the store. Null where
 * nothing is set.
 */
export async function leadFinderKeys() {
  const snap = await secretsSnapshot();
  const v = (f) => secretOf(f, snap);
  return {
    places: await v('PLACES_API_KEY'),
    quickEmailVerification: await v('QUICKEMAILVERIFICATION_API_KEY'),
    verifalia: { username: await v('VERIFALIA_USERNAME'), password: await v('VERIFALIA_PASSWORD') },
    reoon: await v('REOON_API_KEY'),
    zeroBounce: await v('ZEROBOUNCE_API_KEY'),
    hunter: await v('HUNTER_API_KEY'),
  };
}

/** Test-only: drop the memo (tests set CFG_MEMO_MS=0 anyway). */
export const __resetSecretsMemo = forgetMemo;
