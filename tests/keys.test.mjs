// The keys store (docs/KEYS.md, Settings › Keys): env wins; a pasted key is
// checked with its service before it is stored (encrypted), a refused key is
// never saved, a service that cannot be reached leaves 'not tested yet';
// each provider's check is the cheapest real call and never a dispatch; the
// verifiers, Places and the GitHub dispatch read the hub's keys; the Lead
// Finder job gets them with the profile (token only, never a hub answer or a
// backup) and prefers them over its env. Every service is a fake behind
// io.fetchJson; no value ever appears in an answer.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { __reset, kv } from '@vercel/kv';
import { io } from '@/lib/systems/intake-io';
import { K } from '@/lib/db/keys';
import { decrypt } from '@/lib/crypto';
import { createClient } from '@/lib/db/client';
import { makeSession } from '@/lib/auth/session';
import { exportAll } from '@/lib/systems/backup';
import { hubBoard, hubClient } from '@/lib/systems/hubview';
import { profilePayload } from '@/lib/systems/leadfinder';
import { configuredServices } from '@/lib/systems/verify';
import { placesConfigured } from '@/lib/ext/places';
import { repositoryDispatch, repoName } from '@/lib/ext/github';
import * as quickemail from '@/lib/ext/quickemail';
import { CARDS, FIELDS, secretOf, secretStatus, leadFinderKeys } from '@/lib/secrets';
import {
  saveKey, testKey, keysView, KEYS_TIMING, PLACES_URL, PLACES_TEST_QUERY, QUICKEMAIL_SANDBOX_URL, VERIFALIA_CREDITS_URL,
  REOON_BALANCE_URL, ZEROBOUNCE_CREDITS_URL, HUNTER_ACCOUNT_URL, GITHUB_API,
} from '@/lib/systems/keys';

// ── stubs ──
process.env.ENC_KEY = crypto.randomBytes(32).toString('base64');
process.env.PUBLIC_BASE_URL = 'https://app.test';
process.env.OWNER_INBOX = 'owner@aviance.test:app-pw:Limeth Sith';
delete process.env.CHEAPINBOXES_API_KEY;
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
const clearEnv = () => { for (const f of FIELDS) delete process.env[f]; };

const V = {
  places: 'AIzaSyHUBplaceskey00000000000000000001',
  qev: 'qevhubkey0000000000000001',
  vUser: 'aviance-sid-01',
  vPass: 'verifalia-auth-token-0001',
  reoon: 'reoonhubkey0000000000001',
  zb: 'zbhubkey000000000000000001',
  hunter: 'hunterhubkey00000000000001',
  gh: 'github_pat_HUBTOKEN00000000000001',
};
const SECRETS = Object.values(V);
const leaks = (value) => SECRETS.filter((s) => JSON.stringify(value).includes(s));
const REPO = 'limethsith-create/email-distributor';

// ── every service, faked behind io.fetchJson ──
let net;
const reply = (status, json = null) => ({ status, ok: status >= 200 && status < 300, json, text: json ? JSON.stringify(json) : '' });
const gerr = (code, status, message, reason) => reply(code, { error: { code, message, status, details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'googleapis.com' }] } });
function fakeNet(url, opts = {}) {
  const method = opts.method || 'GET';
  const headers = opts.headers || {};
  net.calls.push({ url, method, headers, body: opts.body, timeoutMs: opts.timeoutMs, retry: opts.retry, service: opts.service, usageField: opts.usageField });
  if (net.down) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  const u = new URL(url);
  if (url === PLACES_URL) {
    const key = headers['X-Goog-Api-Key'];
    if (net.places[key]) return net.places[key];
    if (key === V.places) return reply(200, { places: [{ id: 'ChIJ1' }, { id: 'ChIJ2' }] });
    return gerr(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.', 'API_KEY_INVALID');
  }
  if (url.startsWith(QUICKEMAIL_SANDBOX_URL)) {
    return u.searchParams.get('apikey') === V.qev
      ? reply(200, { result: 'valid', reason: 'accepted_email', disposable: 'false', safe_to_send: 'true', success: 'true' })
      : reply(401, { success: 'false', message: 'Authentication failed' });
  }
  if (url === VERIFALIA_CREDITS_URL) {
    const [user, pass] = Buffer.from(String(headers.authorization || '').replace(/^Basic /, ''), 'base64').toString('utf8').split(':');
    return user === V.vUser && pass === V.vPass ? reply(200, { creditPacks: 0, freeCredits: 22, freeCreditsResetIn: '09:12:44' }) : reply(401, null);
  }
  if (url.startsWith(REOON_BALANCE_URL)) {
    return u.searchParams.get('key') === V.reoon && !net.revoked
      ? reply(200, { status: 'success', api_status: 'active', remaining_daily_credits: 18, remaining_instant_credits: 100 })
      : reply(200, { status: 'error', reason: 'Invalid API key' });
  }
  if (url.startsWith(ZEROBOUNCE_CREDITS_URL)) return reply(200, { Credits: u.searchParams.get('api_key') === V.zb ? String(net.zbCredits) : '-1' });
  if (url === HUNTER_ACCOUNT_URL) {
    return headers['X-API-KEY'] === V.hunter && !net.revoked
      ? reply(200, { data: { first_name: 'Limeth', plan_name: 'Free', requests: { searches: { used: 0, available: 25 }, verifications: { used: 3, available: 50 } } } })
      : reply(401, { errors: [{ id: 'authentication_failed', code: 401, details: 'No valid API key was provided.' }] });
  }
  if (url.startsWith(`${GITHUB_API}/repos/`)) {
    if (method !== 'GET') throw new Error(`the keys check must never ${method} GitHub (${url})`);
    const repo = url.slice(`${GITHUB_API}/repos/`.length);
    const token = String(headers.authorization || '').replace(/^Bearer /, '');
    if (token !== V.gh && token !== 'gh-readonly') return reply(401, { message: 'Bad credentials' });
    if (repo !== net.repo) return reply(404, { message: 'Not Found' });
    return reply(200, { full_name: repo, permissions: { admin: false, maintain: false, push: token === V.gh, triage: false, pull: true } });
  }
  throw new Error(`fake net does not know ${method} ${url}`);
}
const callsTo = (prefix) => net.calls.filter((c) => c.url.startsWith(prefix));

beforeEach(() => {
  __reset();
  clearEnv();
  net = { calls: [], down: false, revoked: false, places: {}, repo: REPO, zbCredits: 97 };
  io.fetchJson = async (url, opts) => fakeNet(url, opts);
  io.fetchExt = async (url) => { throw new Error(`unexpected fetchExt ${url}`); };
  io.alertOwner = async () => ({ sent: true });
  globalThis.fetch = async (url) => { throw new Error(`real network call blocked in tests: ${String(url).slice(0, 120)}`); };
});

// ── the hub's route ──
const answers = [];
async function mc(body) {
  const { POST } = await import('@/app/api/mc/keys/route');
  const res = await POST(new Request('https://app.test/api/mc/keys', { method: 'POST', body: JSON.stringify(body) }));
  const out = { status: res.status, body: await res.json() };
  answers.push(out.body);
  return out;
}
async function view() {
  const { GET } = await import('@/app/api/mc/keys/route');
  const body = await (await GET()).json();
  answers.push(body);
  return body;
}
const cardOf = (v, name) => v.keys.find((k) => k.name === name);
const hash = async () => (await kv.hgetall(K.secrets())) || {};

// ─────────────────────────────────────────────────────────────────────────────

test('env wins: a key set on the server is used and shown as `env`; the hub cannot change it, only test it', async () => {
  process.env.REOON_API_KEY = V.reoon;
  assert.equal(await secretOf('REOON_API_KEY'), V.reoon);
  let reoon = cardOf(await view(), 'REOON_API_KEY');
  assert.deepEqual([reoon.set, reoon.from, reoon.ok, reoon.testedAt], [true, 'env', null, null]);
  const save = await mc({ action: 'save', name: 'REOON_API_KEY', value: 'another-key-000000001' });
  assert.equal(save.status, 409);
  assert.match(save.body.error, /set on the server \(REOON_API_KEY\)/);
  assert.deepEqual(await hash(), {}, 'nothing stored');
  const t = await mc({ action: 'test', name: 'REOON_API_KEY' });
  assert.deepEqual([t.status, t.body.tested, t.body.ok, t.body.from, t.body.problem], [200, true, true, 'env', null]);
  assert.equal(t.body.detail, '18 free checks left today, 100 instant credits');
  assert.equal(callsTo(REOON_BALANCE_URL).length, 1);
  // Forget only ever removes the hub's copy; the server's stays.
  const f = await mc({ action: 'forget', name: 'REOON_API_KEY' });
  assert.deepEqual([f.status, f.body.set, f.body.from], [200, true, 'env']);
  reoon = cardOf(await view(), 'REOON_API_KEY');
  assert.equal(reoon.testedAt, null, 'forget also drops the test outcome');
  assert.deepEqual(leaks(answers), [], 'no value in any answer');
});

test('save: the service is asked first (one cheap call), the value is stored encrypted, the status says set / hub / ok — never the value', async () => {
  const before = await view();
  assert.deepEqual(before.keys.map((k) => k.name), CARDS.map((c) => c.name));
  assert.equal(before.encKey, true);
  for (const k of before.keys) {
    assert.deepEqual([k.set, k.from, k.ok], [false, null, null], k.name);
    assert.ok(Array.isArray(k.steps) && k.steps.length >= 1 && k.url, `${k.name} has steps and a page`);
    if (k.secret) assert.ok(!('value' in k), `${k.name}: a secret is never shown`);
  }
  assert.equal(await placesConfigured(), false);

  const r = await mc({ action: 'save', name: 'PLACES_API_KEY', value: V.places });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.saved, true);
  assert.deepEqual([r.body.set, r.body.from, r.body.ok, r.body.problem], [true, 'hub', true, null]);
  assert.equal(r.body.detail, 'Google answered a test search with 2 places');
  assert.ok(r.body.testedAt && r.body.savedAt);
  // The check: ONE IDs-only text search (the free Essentials SKU), no retry, a timeout, counted under places.idsOnly.
  const c = callsTo(PLACES_URL);
  assert.equal(c.length, 1);
  assert.deepEqual([c[0].method, c[0].headers['X-Goog-FieldMask'], c[0].headers['X-Goog-Api-Key'], c[0].retry, c[0].timeoutMs, c[0].service, c[0].usageField], ['POST', 'places.id', V.places, false, KEYS_TIMING.callMs, 'places', 'idsOnly']);
  assert.deepEqual(JSON.parse(c[0].body), { textQuery: PLACES_TEST_QUERY, pageSize: 3 });
  // Stored encrypted, under the hash the backup leaves out.
  const h = await hash();
  assert.match(h.PLACES_API_KEY, /^v1\./);
  assert.equal(decrypt(h.PLACES_API_KEY), V.places);
  assert.deepEqual([h['PLACES_API_KEY:ok'], h['PLACES_API_KEY:problem']], ['1', '']);
  assert.equal(await secretOf('PLACES_API_KEY'), V.places);
  assert.equal(await placesConfigured(), true);
  const after = cardOf(await view(), 'PLACES_API_KEY');
  assert.deepEqual([after.set, after.from, after.ok], [true, 'hub', true]);
  assert.deepEqual(leaks(answers), [], 'no value in any answer');
  assert.deepEqual(leaks(await secretStatus()), []);
});

test('save: a key the service refuses is NOT saved — 400 with the reason in plain words', async () => {
  const bad = await mc({ action: 'save', name: 'PLACES_API_KEY', value: 'AIzaWrongKey0000000000000000000000001' });
  assert.deepEqual([bad.status, bad.body.error], [400, 'Google said the key is invalid']);
  assert.deepEqual(await hash(), {}, 'nothing stored');
  assert.equal(cardOf(await view(), 'PLACES_API_KEY').set, false);

  net.places.AIzaDisabled000000000000000000000001 = gerr(403, 'PERMISSION_DENIED', 'Places API (New) has not been used in project 123 before or it is disabled. Enable it by visiting …', 'SERVICE_DISABLED');
  const off = await mc({ action: 'save', name: 'PLACES_API_KEY', value: 'AIzaDisabled000000000000000000000001' });
  assert.deepEqual([off.status, off.body.error], [400, 'Places API (New) is not enabled for this key — turn it on in Google Cloud']);
  net.places.AIzaBlocked0000000000000000000000001 = gerr(403, 'PERMISSION_DENIED', 'Requests to this API places.googleapis.com method google.maps.places.v1.Places.SearchText are blocked.', 'API_KEY_SERVICE_BLOCKED');
  assert.match((await mc({ action: 'save', name: 'PLACES_API_KEY', value: 'AIzaBlocked0000000000000000000000001' })).body.error, /restrictions do not allow Places API \(New\)/);

  assert.deepEqual((await mc({ action: 'save', name: 'QUICKEMAILVERIFICATION_API_KEY', value: 'wrong-qev-key-0001' })).body, { error: 'QuickEmailVerification said the key is invalid' });
  assert.deepEqual((await mc({ action: 'save', name: 'VERIFALIA', username: V.vUser, password: 'wrong-pass-0001' })).body, { error: 'Verifalia said the login is wrong — check the user name and the password' });
  assert.deepEqual((await mc({ action: 'save', name: 'REOON_API_KEY', value: 'wrong-reoon-key-0001' })).body, { error: 'Reoon said the key is invalid' });
  assert.deepEqual((await mc({ action: 'save', name: 'ZEROBOUNCE_API_KEY', value: 'wrong-zb-key-0001' })).body, { error: 'ZeroBounce said the key is invalid' });
  assert.deepEqual((await mc({ action: 'save', name: 'HUNTER_API_KEY', value: 'wrong-hunter-key-0001' })).body, { error: 'Hunter said the key is invalid' });
  assert.deepEqual((await mc({ action: 'save', name: 'GITHUB_TOKEN', value: 'gh-readonly' })).body, { error: `This token cannot start jobs on ${REPO} — it needs Contents: Read and write on that repository` });
  assert.deepEqual((await mc({ action: 'save', name: 'GITHUB_TOKEN', value: 'github_pat_expired_000001' })).body, { error: 'GitHub said the token is invalid or has expired — make a new one' });
  // Not even sent: a value with a blank in it, an unknown key, a missing Verifalia half.
  const n = net.calls.length;
  assert.deepEqual((await mc({ action: 'save', name: 'REOON_API_KEY', value: 'two words' })).body, { error: 'Paste the whole key, with no spaces or line breaks.' });
  assert.equal((await mc({ action: 'save', name: 'VERIFALIA', username: V.vUser })).status, 400);
  assert.equal((await mc({ action: 'save', name: 'NOT_A_KEY', value: 'x' })).status, 400);
  assert.equal((await mc({ action: 'nope' })).status, 400);
  assert.equal(net.calls.length, n);
  assert.deepEqual(await hash(), {}, 'still nothing stored');
  assert.deepEqual(leaks(answers), []);
});

test("save: when the service cannot be reached the key is saved as 'not tested yet'; Test later fills the outcome in", async () => {
  net.down = true;
  const r = await mc({ action: 'save', name: 'REOON_API_KEY', value: V.reoon });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.saved, r.body.set, r.body.from, r.body.ok, r.body.problem], [true, true, 'hub', null, 'not tested yet']);
  assert.equal(decrypt((await hash()).REOON_API_KEY), V.reoon);
  net.down = false;
  const t = await mc({ action: 'test', name: 'REOON_API_KEY' });
  assert.deepEqual([t.body.tested, t.body.ok, t.body.problem, t.body.detail], [true, true, null, '18 free checks left today, 100 instant credits']);
  // A key the service stops accepting later: Test says so, the value stays until the owner replaces it.
  net.revoked = true;
  const again = await mc({ action: 'test', name: 'REOON_API_KEY' });
  assert.deepEqual([again.body.ok, again.body.problem, again.body.set], [false, 'Reoon said the key is invalid', true]);
  // Test on a key that is not there at all.
  const none = await mc({ action: 'test', name: 'HUNTER_API_KEY' });
  assert.deepEqual([none.status, none.body.error], [409, 'Hunter key is not set yet — paste it first.']);
  assert.deepEqual(leaks(answers), []);
});

test("each provider's check: the cheapest real call, its exact shape, credits in plain words; GitHub is only ever read", async () => {
  assert.equal((await mc({ action: 'save', name: 'QUICKEMAILVERIFICATION_API_KEY', value: V.qev })).body.detail, 'The key works (checked against their free sandbox, no credit spent)');
  const q = callsTo(QUICKEMAIL_SANDBOX_URL)[0];
  assert.deepEqual([q.method, new URL(q.url).searchParams.get('email'), new URL(q.url).searchParams.get('apikey'), q.retry], ['GET', 'valid@example.com', V.qev, false]);

  const v = await mc({ action: 'save', name: 'VERIFALIA', username: V.vUser, password: V.vPass });
  assert.deepEqual([v.body.set, v.body.from, v.body.ok, v.body.detail, v.body.parts], [true, 'hub', true, '22 free checks left today', ['username', 'password']]);
  const vc = callsTo(VERIFALIA_CREDITS_URL)[0];
  assert.deepEqual([vc.method, vc.headers.authorization], ['GET', `Basic ${Buffer.from(`${V.vUser}:${V.vPass}`).toString('base64')}`]);
  assert.deepEqual([decrypt((await hash()).VERIFALIA_USERNAME), decrypt((await hash()).VERIFALIA_PASSWORD)], [V.vUser, V.vPass]);

  assert.equal((await mc({ action: 'save', name: 'REOON_API_KEY', value: V.reoon })).body.detail, '18 free checks left today, 100 instant credits');
  const rc = callsTo(REOON_BALANCE_URL)[0];
  assert.deepEqual([rc.method, new URL(rc.url).searchParams.get('key')], ['GET', V.reoon]);

  net.zbCredits = 0;
  const zb = await mc({ action: 'save', name: 'ZEROBOUNCE_API_KEY', value: V.zb });
  assert.deepEqual([zb.body.saved, zb.body.ok, zb.body.problem], [true, true, 'Out of credits — ZeroBounce gives 100 free checks a month'], 'a working key with no credits is saved, and the owner is told');
  assert.deepEqual([callsTo(ZEROBOUNCE_CREDITS_URL)[0].method, new URL(callsTo(ZEROBOUNCE_CREDITS_URL)[0].url).searchParams.get('api_key')], ['GET', V.zb]);
  net.zbCredits = 97;
  assert.deepEqual([(await mc({ action: 'test', name: 'ZEROBOUNCE_API_KEY' })).body.problem, (await mc({ action: 'test', name: 'ZEROBOUNCE_API_KEY' })).body.detail], [null, '97 credits left']);

  assert.equal((await mc({ action: 'save', name: 'HUNTER_API_KEY', value: V.hunter })).body.detail, 'Free plan, 47 checks left this month');
  const hc = callsTo(HUNTER_ACCOUNT_URL)[0];
  assert.deepEqual([hc.method, hc.headers['X-API-KEY']], ['GET', V.hunter]);

  const gh = await mc({ action: 'save', name: 'GITHUB_TOKEN', value: V.gh });
  assert.deepEqual([gh.body.ok, gh.body.detail], [true, `Can start the lead finder on ${REPO}`]);
  const gc = callsTo(`${GITHUB_API}/repos/`);
  assert.equal(gc.length, 1);
  assert.deepEqual([gc[0].method, gc[0].url, gc[0].headers.authorization, gc[0].headers.accept, gc[0].service], ['GET', `${GITHUB_API}/repos/${REPO}`, `Bearer ${V.gh}`, 'application/vnd.github+json', 'github']);
  assert.ok(!net.calls.some((c) => c.url.includes('/dispatches') || c.method === 'POST' && c.url.startsWith(GITHUB_API)), 'a check never starts a job');

  // Every check is one call, with a timeout and no retry.
  assert.ok(net.calls.every((c) => c.timeoutMs === KEYS_TIMING.callMs && c.retry === false));
  // The waterfall now sees every verifier the owner pasted (VERIFY.order, keys from the hub).
  assert.deepEqual(await configuredServices(), ['quickemail', 'verifalia', 'reoon', 'zerobounce', 'hunter']);
  const all = await view();
  for (const name of ['QUICKEMAILVERIFICATION_API_KEY', 'VERIFALIA', 'REOON_API_KEY', 'ZEROBOUNCE_API_KEY', 'HUNTER_API_KEY', 'GITHUB_TOKEN']) assert.deepEqual([cardOf(all, name).set, cardOf(all, name).from], [true, 'hub'], name);
  assert.deepEqual(leaks(answers), [], 'no value in any answer');
});

test('GITHUB_REPO is a plain setting: the default is shown, a new one is checked with the token, a bad one refused', async () => {
  let repo = cardOf(await view(), 'GITHUB_REPO');
  assert.deepEqual([repo.secret, repo.set, repo.value, repo.default], [false, false, null, REPO]);
  assert.equal(await repoName(), REPO);
  // Without a token the repository cannot be checked — saved as not tested yet.
  net.repo = 'limethsith-create/other-repo';
  const first = await mc({ action: 'save', name: 'GITHUB_REPO', value: 'limethsith-create/other-repo' });
  assert.deepEqual([first.status, first.body.ok, first.body.problem, first.body.value], [200, null, 'not tested yet', 'limethsith-create/other-repo']);
  assert.equal(callsTo(GITHUB_API).length, 0);
  assert.equal((await hash()).GITHUB_REPO, 'limethsith-create/other-repo', 'a setting is stored as it is');
  assert.equal(await repoName(), 'limethsith-create/other-repo');
  // With the token: the check reads THAT repository.
  const tok = await mc({ action: 'save', name: 'GITHUB_TOKEN', value: V.gh });
  assert.equal(tok.body.detail, 'Can start the lead finder on limethsith-create/other-repo');
  assert.equal(callsTo(GITHUB_API)[0].url, `${GITHUB_API}/repos/limethsith-create/other-repo`);
  // A repository the token cannot see is refused; so is a name that is not owner/repository.
  const unseen = await mc({ action: 'save', name: 'GITHUB_REPO', value: 'someone-else/private' });
  assert.deepEqual([unseen.status, unseen.body.error], [400, 'This token cannot see someone-else/private — when making it, choose Repository access: Only select repositories → someone-else/private']);
  assert.equal(await repoName(), 'limethsith-create/other-repo', 'unchanged');
  assert.deepEqual((await mc({ action: 'save', name: 'GITHUB_REPO', value: 'nonsense' })).body, { error: `The repository must look like owner/repository, for example ${REPO}.` });
  // Env wins for the setting too.
  process.env.GITHUB_REPO = 'limethsith-create/from-env';
  repo = cardOf(await view(), 'GITHUB_REPO');
  assert.deepEqual([repo.from, repo.value], ['env', 'limethsith-create/from-env']);
  assert.equal(await repoName(), 'limethsith-create/from-env');
  assert.deepEqual(leaks(answers), []);
});

test('forget: the hub value goes, the card is empty again, the store keeps nothing of it', async () => {
  await mc({ action: 'save', name: 'PLACES_API_KEY', value: V.places });
  await mc({ action: 'save', name: 'VERIFALIA', username: V.vUser, password: V.vPass });
  assert.equal(await placesConfigured(), true);
  const f = await mc({ action: 'forget', name: 'PLACES_API_KEY' });
  assert.deepEqual([f.status, f.body.forgotten, f.body.set, f.body.from, f.body.ok, f.body.testedAt], [200, true, false, null, null, null]);
  const h = await hash();
  assert.ok(!Object.keys(h).some((k) => k.startsWith('PLACES_API_KEY')), 'value and test outcome gone');
  assert.ok(h.VERIFALIA_USERNAME && h.VERIFALIA_PASSWORD, 'the other cards stay');
  assert.equal(await placesConfigured(), false);
  assert.equal(await secretOf('PLACES_API_KEY'), null);
  const v = await mc({ action: 'forget', name: 'VERIFALIA' });
  assert.equal(v.body.set, false);
  assert.deepEqual(await hash(), {});
  assert.equal((await mc({ action: 'forget', name: 'NOT_A_KEY' })).status, 400);
  assert.deepEqual(leaks(answers), []);
});

test('the machine reads the hub keys: the verifiers, Places and the GitHub dispatch use them when env has none', async () => {
  await saveKey({ name: 'QUICKEMAILVERIFICATION_API_KEY', value: V.qev });
  await saveKey({ name: 'GITHUB_TOKEN', value: V.gh });
  await saveKey({ name: 'PLACES_API_KEY', value: V.places });
  // The verifier's own call carries the hub key (their API takes it as a query parameter).
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), init });
    if (String(url).includes('quickemailverification.com/v1/verify?')) return new Response(JSON.stringify({ success: 'true', result: 'valid', safe_to_send: 'true' }), { status: 200, headers: { 'x-qev-remaining-credits': '99' } });
    if (String(url) === `https://api.github.com/repos/${REPO}/dispatches`) return new Response(null, { status: 204 });
    if (String(url).includes('places.googleapis.com')) return new Response(JSON.stringify({ places: [{ id: 'p1' }] }), { status: 200 });
    throw new Error(`unexpected ${url}`);
  };
  const r = await quickemail.verify('ann@acme.com');
  assert.deepEqual([r.status, r.remaining], ['valid', 99]);
  assert.equal(new URL(seen[0].url).searchParams.get('apikey'), V.qev);
  // The dispatch: the hub's token, the repository from the store's default.
  const d = await repositoryDispatch('leadfinder', { clientId: 'acme', need: 10, mode: 'initial' });
  assert.deepEqual(d, { ok: true, status: 204 });
  const gh = seen.find((s) => s.url.endsWith('/dispatches'));
  assert.equal(gh.init.headers.authorization, `Bearer ${V.gh}`);
  assert.equal(JSON.parse(gh.init.body).event_type, 'leadfinder');
  // Places (the Market Counter / research client).
  const { textSearchIds } = await import('@/lib/ext/places');
  assert.deepEqual((await textSearchIds('coffee in Dallas, TX')).ids, ['p1']);
  assert.equal(seen.at(-1).init.headers['X-Goog-Api-Key'], V.places);
  // Env still wins over the hub.
  process.env.QUICKEMAILVERIFICATION_API_KEY = 'env-qev-key-0001';
  await quickemail.verify('bob@acme.com');
  assert.equal(new URL(seen.at(-1).url).searchParams.get('apikey'), 'env-qev-key-0001');
  // Without any token the dispatch says where to paste one.
  delete process.env.GITHUB_TOKEN;
  await kv.hdel(K.secrets(), 'GITHUB_TOKEN');
  assert.match((await repositoryDispatch('leadfinder', {})).error, /Settings › Keys/);
});

test('the Lead Finder job gets the keys with the profile — with the LEADFINDER_TOKEN only; never in a hub answer or a backup', async () => {
  process.env.LEADFINDER_TOKEN = 'lf-token-for-tests';
  process.env.ADMIN_SECRET = 'admin-secret-for-tests';
  await createClient('acme', { state: 'warming', name: 'Acme IT', contactName: 'Pat', contactEmail: 'pat@acme.com' });
  await kv.hset(K.profile('acme'), { industry: 'dentist', titles: 'owner', cities: 'Dallas, TX', states: 'TX', defaultNiche: 'managed IT' });
  await saveKey({ name: 'PLACES_API_KEY', value: V.places });
  await saveKey({ name: 'QUICKEMAILVERIFICATION_API_KEY', value: V.qev });
  await saveKey({ name: 'VERIFALIA', username: V.vUser, password: V.vPass });
  await saveKey({ name: 'REOON_API_KEY', value: V.reoon });
  process.env.HUNTER_API_KEY = V.hunter; // env keys travel too

  assert.deepEqual(await leadFinderKeys(), { places: V.places, quickEmailVerification: V.qev, verifalia: { username: V.vUser, password: V.vPass }, reoon: V.reoon, zeroBounce: null, hunter: V.hunter });
  assert.ok(!('keys' in await profilePayload('acme')), 'the payload carries no keys unless asked');
  const forJob = await profilePayload('acme', new Date(), { keys: true });
  assert.equal(forJob.keys.places, V.places);

  const { GET } = await import('@/app/api/clients/[id]/profile/route');
  const get = (headers) => GET(new Request('https://app.test/api/clients/acme/profile', { headers }), { params: { id: 'acme' } });
  const job = await get({ authorization: 'Bearer lf-token-for-tests' });
  assert.equal(job.status, 200);
  assert.deepEqual((await job.json()).keys, await leadFinderKeys(), 'the job gets the keys');
  const admin = await get({ cookie: `av_session=${await makeSession()}` });
  assert.equal(admin.status, 200);
  const adminBody = await admin.json();
  assert.ok(!('keys' in adminBody) && leaks(adminBody).length === 0, 'a browser session sees the profile without the keys');
  assert.equal((await get({ authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await get({})).status, 401);

  // No hub answer and no backup ever carries a value.
  assert.deepEqual(leaks(await hubBoard()), []);
  assert.deepEqual(leaks(await hubClient('acme')), []);
  assert.deepEqual(leaks(await view()), []);
  const backup = await exportAll();
  assert.deepEqual(leaks(backup), []);
  assert.ok(!backup.keys.some((k) => k.key === K.secrets()), 'the keys store is left out of the backup whole');
  assert.ok(!JSON.stringify(backup).includes('v1.'), 'no encrypted blob of it either');
  assert.deepEqual(leaks(answers), []);
});

test('the Lead Finder script prefers the keys in the profile over its own env', async () => {
  const { run } = await import('../scripts/leadfinder/index.mjs');
  const seen = [];
  const fetchImpl = (keys) => async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/profile')) return new Response(JSON.stringify({ need: 5, profile: { industry: ['dentist'], cities: ['Dallas, TX'], states: ['TX'] }, blocklist: {}, budget: { placesUsed: 0, placesLimit: 1000, placesStopRatio: 0.8 }, keys }), { status: 200 });
    if (u.endsWith('/webhooks/leadfinder')) return new Response(JSON.stringify({ taken: [], ok: true }), { status: 200 });
    if (u.includes('places.googleapis.com')) {
      seen.push(init.headers['X-Goog-Api-Key']);
      // Enough results that the job never falls back to OpenStreetMap (which paces itself with a 5 s gap).
      return new Response(JSON.stringify({ places: Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, displayName: { text: `Dentist ${i}` }, formattedAddress: '1 Main St, Dallas, TX 75201, USA', websiteUri: `https://dentist${i}.example/` })) }), { status: 200 });
    }
    if (u.includes('overpass')) return new Response(JSON.stringify({ elements: [] }), { status: 200 });
    return new Response('', { status: 404 });
  };
  const env = { APP_URL: 'https://app.test', LEADFINDER_TOKEN: 't', PLACES_API_KEY: 'env-places-key', CLIENT_PAYLOAD: JSON.stringify({ clientId: 'acme', need: 5 }), GITHUB_RUN_ID: '9' };
  await run({ env, fetchImpl: fetchImpl({ places: V.places, reoon: V.reoon }), resolveMx: async () => [], log: () => {}, crawl: { delayMs: 0 } });
  assert.ok(seen.length >= 1 && seen.every((k) => k === V.places), 'the profile key, not the env one');
  seen.length = 0;
  await run({ env, fetchImpl: fetchImpl({ places: null }), resolveMx: async () => [], log: () => {}, crawl: { delayMs: 0 } });
  assert.ok(seen.length >= 1 && seen.every((k) => k === 'env-places-key'), 'env is the fallback when the store has none');
  seen.length = 0;
  await run({ env: { ...env, PLACES_API_KEY: '' }, fetchImpl: fetchImpl({}), resolveMx: async () => [], log: () => {}, crawl: { delayMs: 0 } });
  assert.equal(seen.length, 0, 'no key anywhere: no Places call (OpenStreetMap instead)');
});

test('the check on the hub: testKey and saveKey without the route, and the guide text is plain', async () => {
  const st = await saveKey({ name: 'HUNTER_API_KEY', value: V.hunter });
  assert.deepEqual([st.name, st.set, st.from, st.ok], ['HUNTER_API_KEY', true, 'hub', true]);
  net.revoked = true;
  assert.deepEqual([(await testKey({ name: 'HUNTER_API_KEY' })).ok, (await testKey({ name: 'HUNTER_API_KEY' })).problem], [false, 'Hunter said the key is invalid']);
  const v = await keysView();
  for (const k of v.keys) {
    assert.ok(k.label && !/[A-Z_]{6,}/.test(k.label.replace(/GitHub|QuickEmailVerification|ZeroBounce/g, '')), `${k.name}: a plain label, not an env name`);
    assert.ok(k.free && k.note, `${k.name}: what is free + whether the steps were checked`);
  }
  assert.match(cardOf(v, 'PLACES_API_KEY').steps.join(' '), /Places API \(New\)/);
  assert.match(cardOf(v, 'GITHUB_TOKEN').steps.join(' '), /Contents = Read and write/);
  assert.match(cardOf(v, 'VERIFALIA').steps.join(' '), /Users/);
  assert.deepEqual(leaks(v), []);
});
