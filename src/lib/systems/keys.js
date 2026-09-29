/**
 * Settings › Keys (docs/KEYS.md; docs/HUB-API.md "Keys") — the owner pastes
 * each service key in the hub; the machine checks it with the cheapest real
 * call that proves it works, stores it encrypted (lib/secrets.js) and says
 * in plain words what is wrong when something is.
 *
 *  - keysView(): GET /api/mc/keys — every key's status, the steps to get it
 *    and the page to get it from. Never a secret's value.
 *  - saveKey({ name, value } | { name: 'VERIFALIA', username, password }):
 *    checks first. A key the service refuses is NOT saved (400 with the
 *    reason). When the check itself could not run (the service unreachable)
 *    the key is saved as 'not tested yet'.
 *  - testKey({ name }): the same check on the stored (or env) key; the
 *    outcome is kept as testedAt / ok / problem.
 *  - forgetKey({ name }).
 *
 * Every check is ONE call through io.fetchJson (stubbed in tests), with a
 * timeout and no retry, and never spends a credit or starts anything:
 *   Places      → one IDs-only text search ("coffee in Dallas, TX"; the
 *                 IDs-only field mask is the Essentials SKU, free, unlimited)
 *   QuickEmail  → their sandbox verify (free, no credit)
 *   Verifalia   → GET /credits/balance (HTTP Basic)
 *   Reoon       → GET check-account-balance
 *   ZeroBounce  → GET /v2/getcredits
 *   Hunter      → GET /v2/account
 *   GitHub      → GET /repos/{repo} and `permissions.push` (never a dispatch)
 *   Groq / Cerebras / Gemini / OpenRouter (Ava's brains) → GET {api}/models
 *                 (lists the models; no tokens spent)
 *   Cloudflare  → GET /accounts/{id}/ai/models/search (proves the account id AND the token; no Neurons spent)
 *   Tavily      → GET /usage (no search spent)
 *   Exa         → one 1-result search (a fraction of a cent of the free credit)
 * CheapInboxes and Google Meet have their own settings cards (ext/cheapinboxes.js, ext/google.js).
 *
 * The AI and search keys are only for Ava (lib/ava/); no other system uses AI.
 */

import { logEvent } from '@/lib/db/events';
import { hasEncKey } from '@/lib/crypto';
import { io, asObject } from '@/lib/systems/intake-io';
import {
  CARDS, KeysError, DEFAULT_REPO, cardOf, cleanValue, secretOf, secretsSnapshot, secretStatus, secretStatusOf, setSecret, noteTest, forgetSecret,
} from '@/lib/secrets';

export { KeysError };

const SYSTEM = 'keys';
/** Per check (tests shorten it). */
export const KEYS_TIMING = { callMs: 8000 };

export const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';
export const PLACES_TEST_QUERY = 'coffee in Dallas, TX';
export const QUICKEMAIL_SANDBOX_URL = 'https://api.quickemailverification.com/v1/verify/sandbox';
export const VERIFALIA_CREDITS_URL = 'https://api.verifalia.com/v2.7/credits/balance';
export const REOON_BALANCE_URL = 'https://emailverifier.reoon.com/api/v1/check-account-balance/';
export const ZEROBOUNCE_CREDITS_URL = 'https://api.zerobounce.net/v2/getcredits';
export const HUNTER_ACCOUNT_URL = 'https://api.hunter.io/v2/account';
export const GITHUB_API = 'https://api.github.com';
/** Ava's brains: each one's OpenAI-compatible model list (lib/ava/brains.js has the same bases). */
export const AI_MODELS_URLS = {
  GROQ_API_KEY: 'https://api.groq.com/openai/v1/models',
  CEREBRAS_API_KEY: 'https://api.cerebras.ai/v1/models',
  MISTRAL_API_KEY: 'https://api.mistral.ai/v1/models',
  OLLAMA_API_KEY: 'https://ollama.com/v1/models',
  GEMINI_API_KEY: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
  OPENROUTER_API_KEY: 'https://openrouter.ai/api/v1/key',
};
export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4/accounts';
export const TAVILY_USAGE_URL = 'https://api.tavily.com/usage';
export const EXA_SEARCH_URL = 'https://api.exa.ai/search';
const NOT_TESTED = 'not tested yet';

// ─── one call ────────────────────────────────────────────────────────────────

/** One call through io.fetchJson; a timeout or the network → KeysError (the caller turns it into "not tested yet"). */
async function call(url, { method = 'GET', headers = {}, body = undefined, service = null, usageField = 'calls' } = {}) {
  try {
    return await io.fetchJson(url, { method, headers, body, timeoutMs: KEYS_TIMING.callMs, retry: false, ...(service ? { service, usageField } : {}) });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError' || /timed? ?out|aborted/i.test(String(err?.message || ''));
    throw new KeysError(timedOut ? 'timeout' : 'network');
  }
}

const good = (detail) => ({ ok: true, problem: null, detail });
const bad = (problem) => ({ ok: false, problem, detail: null });
/** The key is accepted, but the owner should know something (credits used up). */
const warn = (problem, detail = null) => ({ ok: true, problem, detail });
const yes = (v) => v === true || String(v).toLowerCase() === 'true';
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ─── the checks (one per card) ───────────────────────────────────────────────

async function checkPlaces({ PLACES_API_KEY: key }) {
  const r = await call(PLACES_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.id' },
    body: JSON.stringify({ textQuery: PLACES_TEST_QUERY, pageSize: 3 }),
    service: 'places',
    usageField: 'idsOnly',
  });
  if (r.ok) {
    const n = (r.json?.places || []).filter((p) => p && p.id).length;
    return n ? good(`Google answered a test search with ${plural(n, 'place')}`) : bad('Google answered but found nothing for a test search — try again in a minute');
  }
  const e = asObject(r.json?.error) || {};
  const reason = String((Array.isArray(e.details) ? e.details : []).map((d) => d?.reason).find(Boolean) || '');
  const msg = String(e.message || '');
  if (reason === 'API_KEY_INVALID' || /API key not valid/i.test(msg)) return bad('Google said the key is invalid');
  if (reason === 'SERVICE_DISABLED' || /has not been used in project|is disabled/i.test(msg)) return bad('Places API (New) is not enabled for this key — turn it on in Google Cloud');
  if (reason === 'API_KEY_SERVICE_BLOCKED' || /blocked/i.test(msg)) return bad("This key's restrictions do not allow Places API (New) — edit the key in Google Cloud and allow Places API (New)");
  if (reason === 'BILLING_DISABLED' || /billing/i.test(msg)) return bad('Billing is not turned on for the Google Cloud project — add a card to the project (the free monthly allowance still applies)');
  if (r.status === 429 || e.status === 'RESOURCE_EXHAUSTED') return bad("Google says this key's quota is used up for now — try again later");
  return bad(`Google said ${r.status || 'nothing'}${msg ? `: ${msg.slice(0, 140)}` : ''}`);
}

async function checkQuickEmail({ QUICKEMAILVERIFICATION_API_KEY: key }) {
  const r = await call(`${QUICKEMAIL_SANDBOX_URL}?email=${encodeURIComponent('valid@example.com')}&apikey=${encodeURIComponent(key)}`);
  if (r.status === 401) return bad('QuickEmailVerification said the key is invalid');
  if (r.status === 402) return warn('Out of credits — QuickEmailVerification gives 100 free checks a day; they come back tomorrow');
  if (r.status === 429) return bad('QuickEmailVerification asked us to slow down — try again in a minute');
  if (!r.ok) return bad(`QuickEmailVerification said ${r.status || 'nothing'}`);
  const j = r.json || {};
  if (j.success !== undefined && !yes(j.success)) {
    const m = String(j.message || '');
    if (/key|auth/i.test(m)) return bad('QuickEmailVerification said the key is invalid');
    if (/credit|limit|quota/i.test(m)) return warn('Out of credits — QuickEmailVerification gives 100 free checks a day; they come back tomorrow');
    return bad(`QuickEmailVerification said: ${m.slice(0, 140) || 'no'}`);
  }
  return good('The key works (checked against their free sandbox, no credit spent)');
}

async function checkVerifalia({ VERIFALIA_USERNAME: user, VERIFALIA_PASSWORD: pass }) {
  const r = await call(VERIFALIA_CREDITS_URL, { headers: { authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`, accept: 'application/json' } });
  if (r.status === 401) return bad('Verifalia said the login is wrong — check the user name and the password');
  if (r.status === 403) return good('The login works (this Verifalia user may not read the credit balance, which is fine)');
  if (!r.ok) return bad(`Verifalia said ${r.status || 'nothing'}`);
  const free = num(r.json?.freeCredits);
  const packs = num(r.json?.creditPacks);
  if (free === null && packs === null) return good('The login works');
  if ((free || 0) + (packs || 0) <= 0) return warn('Out of credits for today — Verifalia gives 25 free checks a day (they come back at midnight GMT)', '0 checks left');
  return good([free !== null ? `${plural(free, 'free check')} left today` : null, packs ? `${packs} paid credits` : null].filter(Boolean).join(', '));
}

async function checkReoon({ REOON_API_KEY: key }) {
  const r = await call(`${REOON_BALANCE_URL}?key=${encodeURIComponent(key)}`);
  if (r.status === 401 || r.status === 403) return bad('Reoon said the key is invalid');
  if (!r.ok) return bad(`Reoon said ${r.status || 'nothing'}`);
  const j = r.json || {};
  if (String(j.status || '').toLowerCase() === 'error' || j.error) {
    const m = String(j.reason || j.message || j.error || '');
    return /key|auth|invalid/i.test(m) ? bad('Reoon said the key is invalid') : bad(`Reoon said: ${m.slice(0, 140) || 'no'}`);
  }
  if (j.api_status && String(j.api_status).toLowerCase() !== 'active') return bad(`Reoon says the API is ${String(j.api_status).slice(0, 40)} on this account`);
  const daily = num(j.remaining_daily_credits);
  const instant = num(j.remaining_instant_credits);
  if (daily === 0 && !(instant > 0)) return warn('Out of credits for today — Reoon gives 20 free checks a day; they come back tomorrow', '0 checks left');
  return good([daily !== null ? `${plural(daily, 'free check')} left today` : null, instant ? `${plural(instant, 'instant credit')}` : null].filter(Boolean).join(', ') || 'The key works');
}

async function checkZeroBounce({ ZEROBOUNCE_API_KEY: key }) {
  const r = await call(`${ZEROBOUNCE_CREDITS_URL}?api_key=${encodeURIComponent(key)}`);
  if (r.status === 401 || r.status === 403) return bad('ZeroBounce said the key is invalid');
  if (!r.ok) return bad(`ZeroBounce said ${r.status || 'nothing'}`);
  const j = r.json || {};
  if (j.error) return bad(`ZeroBounce said: ${String(j.error).slice(0, 140)}`);
  const credits = num(j.Credits);
  if (credits === -1) return bad('ZeroBounce said the key is invalid');
  if (credits === null) return bad('ZeroBounce answered in a way the machine did not understand');
  if (credits <= 0) return warn('Out of credits — ZeroBounce gives 100 free checks a month', '0 credits left');
  return good(`${plural(credits, 'credit')} left`);
}

async function checkHunter({ HUNTER_API_KEY: key }) {
  const r = await call(HUNTER_ACCOUNT_URL, { headers: { 'X-API-KEY': key, accept: 'application/json' } });
  if (r.status === 401) return bad('Hunter said the key is invalid');
  if (r.status === 429) return bad('Hunter asked us to slow down — try again in a minute');
  const data = asObject(r.json?.data);
  if (!r.ok || !data) return bad(`Hunter said ${r.status || 'nothing'}${r.json?.errors?.[0]?.details ? `: ${String(r.json.errors[0].details).slice(0, 140)}` : ''}`);
  const v = asObject(data.requests?.verifications) || {};
  const used = num(v.used);
  const avail = num(v.available);
  const plan = data.plan_name ? `${String(data.plan_name).slice(0, 40)} plan` : null;
  if (used !== null && avail !== null && used >= avail) return warn('Out of credits — Hunter gives 50 free credits a month (about 100 checks); they come back on the reset date', `${used} of ${avail} checks used this month`);
  return good([plan, used !== null && avail !== null ? `${plural(avail - used, 'check')} left this month` : null].filter(Boolean).join(', ') || 'The key works');
}

async function checkGitHub({ GITHUB_TOKEN: token, GITHUB_REPO: repo }) {
  if (!token) return { ok: null, problem: NOT_TESTED, detail: 'Paste the GitHub token to check it' };
  const r = await call(`${GITHUB_API}/repos/${repo}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'aviance-trial-machine' },
    service: 'github',
  });
  if (r.status === 401) return bad('GitHub said the token is invalid or has expired — make a new one');
  if (r.status === 404) return bad(`This token cannot see ${repo} — when making it, choose Repository access: Only select repositories → ${repo}`);
  if (r.status === 403) return bad(`GitHub refused${r.json?.message ? `: ${String(r.json.message).slice(0, 140)}` : ''}`);
  if (!r.ok) return bad(`GitHub said ${r.status || 'nothing'}`);
  const p = asObject(r.json?.permissions);
  if (!p || p.push !== true) return bad(`This token cannot start jobs on ${repo} — it needs Contents: Read and write on that repository`);
  return good(`Can start the lead finder on ${repo}`);
}

/** Ava's brains: one model-list call (no tokens). OpenRouter's /key also says the credit left. */
function aiCheck(name, who) {
  return async (values) => {
    const r = await call(AI_MODELS_URLS[name], { headers: { authorization: `Bearer ${values[name]}`, accept: 'application/json' } });
    if (r.status === 401 || r.status === 403 || (r.status === 400 && /key/i.test(JSON.stringify(r.json || '')))) return bad(`${who} said the key is invalid`);
    if (r.status === 429) return warn(`${who} says this key is busy or out of free use for now — it comes back by itself`);
    if (!r.ok) return bad(`${who} said ${r.status || 'nothing'}`);
    if (name === 'OPENROUTER_API_KEY') {
      const d = asObject(r.json?.data) || {};
      const left = d.limit_remaining ?? null;
      return good(left !== null ? `The key works · $${Number(left).toFixed(2)} credit left` : 'The key works');
    }
    const n = Array.isArray(r.json?.data) ? r.json.data.length : null;
    return good(n ? `The key works · ${plural(n, 'model')} available` : 'The key works');
  };
}

/** Cloudflare Workers AI: the account id and the token together, one model search (no Neurons). */
async function checkCloudflare({ CLOUDFLARE_ACCOUNT_ID: id, CLOUDFLARE_API_TOKEN: token }) {
  if (!/^[a-f0-9]{32}$/i.test(String(id || ''))) return bad('The account ID is 32 letters and numbers — copy it from the right side of the Cloudflare dashboard (Workers & Pages, or Account home)');
  const r = await call(`${CLOUDFLARE_API}/${id}/ai/models/search?per_page=1`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
  const msg = String(r.json?.errors?.[0]?.message || '');
  if (r.status === 401 || r.status === 403 || /auth/i.test(msg)) return bad('Cloudflare refused the token — make it with the "Workers AI" template (Account › Workers AI › Read and Edit) for this account');
  if (r.status === 404 || /account/i.test(msg)) return bad('Cloudflare does not know that account ID — check it on the dashboard');
  if (r.status === 429) return warn('Cloudflare says to slow down — it comes back by itself');
  if (!r.ok || r.json?.success === false) return bad(`Cloudflare said ${r.status || 'nothing'}${msg ? `: ${msg.slice(0, 140)}` : ''}`);
  return good('The account ID and token work · Workers AI is ready (10,000 free Neurons a day)');
}

/** Tavily: the usage page (no search spent). */
async function checkTavily({ TAVILY_API_KEY: key }) {
  const r = await call(TAVILY_USAGE_URL, { headers: { authorization: `Bearer ${key}`, accept: 'application/json' } });
  if (r.status === 401 || r.status === 403) return bad('Tavily said the key is invalid');
  if (r.status === 429) return warn('Tavily says this key is busy or out of searches for now');
  if (!r.ok) return warn(`Tavily answered ${r.status || 'nothing'} — saved; Ava tries it on her first search`);
  const k = asObject(r.json?.key) || asObject(r.json?.account) || {};
  const used = num(k.usage ?? k.plan_usage); const limit = num(k.limit ?? k.plan_limit);
  const left = used !== null && limit ? Math.max(0, limit - used) : null;
  return good(left !== null ? `The key works · ${left} search${left === 1 ? '' : 'es'} left this month` : 'The key works');
}

/** Exa: one 1-result search (no page text). */
async function checkExa({ EXA_API_KEY: key }) {
  const r = await call(EXA_SEARCH_URL, { method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ query: 'weather', numResults: 1 }) });
  if (r.status === 401 || r.status === 403) return bad('Exa said the key is invalid');
  if (r.status === 402) return warn('Exa says the free credit is used up for now — it comes back next month');
  if (r.status === 429) return warn('Exa says to slow down — it comes back by itself');
  if (!r.ok) return bad(`Exa said ${r.status || 'nothing'}`);
  return good('The key works');
}

const CHECKS = {
  CLOUDFLARE: checkCloudflare,
  TAVILY_API_KEY: checkTavily,
  EXA_API_KEY: checkExa,
  GROQ_API_KEY: aiCheck('GROQ_API_KEY', 'Groq'),
  CEREBRAS_API_KEY: aiCheck('CEREBRAS_API_KEY', 'Cerebras'),
  MISTRAL_API_KEY: aiCheck('MISTRAL_API_KEY', 'Mistral'),
  OLLAMA_API_KEY: aiCheck('OLLAMA_API_KEY', 'Ollama'),
  GEMINI_API_KEY: aiCheck('GEMINI_API_KEY', 'Google'),
  OPENROUTER_API_KEY: aiCheck('OPENROUTER_API_KEY', 'OpenRouter'),
  PLACES_API_KEY: checkPlaces,
  QUICKEMAILVERIFICATION_API_KEY: checkQuickEmail,
  VERIFALIA: checkVerifalia,
  REOON_API_KEY: checkReoon,
  ZEROBOUNCE_API_KEY: checkZeroBounce,
  HUNTER_API_KEY: checkHunter,
  GITHUB_TOKEN: checkGitHub,
  GITHUB_REPO: checkGitHub,
};

/** The values a card's check reads: the pasted ones first, then the store (env or hub), then the repository's default. */
async function valuesFor(card, pasted = {}) {
  const snap = await secretsSnapshot();
  const out = {};
  for (const f of card.needs || card.fields) out[f] = pasted[f] ?? (await secretOf(f, snap)) ?? (f === 'GITHUB_REPO' ? DEFAULT_REPO : null);
  return out;
}

/** Run a card's check; a service that could not be reached → { ok: null, problem: 'not tested yet' }. */
export async function runCheck(card, values) {
  try {
    return await CHECKS[card.name](values);
  } catch (err) {
    if (err instanceof KeysError && (err.code === 'timeout' || err.code === 'network')) return { ok: null, problem: NOT_TESTED, detail: `${card.short.split(' ')[0]}: ${err.message}` };
    throw err;
  }
}

// ─── how to get each key (docs/KEYS.md) ─────────────────────────────────────

const CHECKED = 'Steps checked against their own help pages on 2026-09-26.';
const UNCHECKED = 'Their menus may have moved — check on their site.';
export const GUIDES = {
  PLACES_API_KEY: {
    url: 'https://console.cloud.google.com/',
    free: 'The market count is free (IDs only); the lead finder\'s searches have 1,000 free a month. Google needs a card on the project but nothing is charged for the trial\'s use.',
    steps: [
      'Go to console.cloud.google.com and sign in with your Google account.',
      'At the top, open the project picker → New project. Name it "Aviance" and create it. Make sure it is the selected project.',
      'Billing → Link a billing account → add your card. Google asks for one on every project; the free monthly allowance covers what the trial uses.',
      'In the search bar type "Places API (New)", open it and press Enable.',
      'APIs & Services → Credentials → Create credentials → API key.',
      'Click the new key\'s name → API restrictions → Restrict key → tick "Places API (New)" → Save.',
      'Copy the key (it starts with AIza) and paste it here.',
    ],
    note: CHECKED,
  },
  QUICKEMAILVERIFICATION_API_KEY: {
    url: 'https://quickemailverification.com/',
    free: '100 checks a day (sign up with a work email address, not Gmail).',
    steps: [
      'Sign up at quickemailverification.com with your work email address and confirm it.',
      'Sign in → API Settings → Add API Key → give it a name (for example "Aviance") → Add.',
      'Copy the key and paste it here.',
    ],
    note: CHECKED,
  },
  VERIFALIA: {
    url: 'https://verifalia.com/',
    free: '25 checks a day (one free account per organisation), reset at midnight GMT.',
    steps: [
      'Sign up at verifalia.com and confirm your email.',
      'In the client area open Account → Users → Create a user. Give it a user name (Verifalia calls it the SID) and a password (Verifalia calls it the auth token). On the Permissions tab tick email validations and the credit balance.',
      'Paste that user name and password here. (Your own account email and password work too, but a separate user is safer.)',
    ],
    note: CHECKED,
  },
  REOON_API_KEY: {
    url: 'https://emailverifier.reoon.com/',
    free: '20 checks a day (up to 600 a month) plus 100 on signup; paid packs never expire.',
    steps: [
      'Sign up at emailverifier.reoon.com and confirm your email.',
      'Sign in → API Settings → Create API Key → give it a name → Create.',
      'Copy the key and paste it here.',
    ],
    note: UNCHECKED,
  },
  ZEROBOUNCE_API_KEY: {
    url: 'https://www.zerobounce.net/',
    free: '100 checks a month (sign up with a business email address).',
    steps: [
      'Sign up at zerobounce.net with your business email address and confirm it.',
      'Sign in → API → API Keys (their docs say the key is "found in your account").',
      'Copy the key and paste it here.',
    ],
    note: UNCHECKED,
  },
  HUNTER_API_KEY: {
    url: 'https://hunter.io/api-keys',
    free: '50 credits a month; a check costs half a credit, so about 100 checks. Hunter allows one account per person.',
    steps: [
      'Sign up at hunter.io and confirm your email.',
      'Open hunter.io/api-keys (Dashboard → API) and copy the key.',
      'Paste it here.',
    ],
    note: CHECKED,
  },
  GITHUB_TOKEN: {
    url: 'https://github.com/settings/personal-access-tokens/new',
    free: 'Free. The token only lets the machine start the lead finder job in your repository.',
    steps: [
      'On github.com click your profile picture → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.',
      'Token name: "Aviance lead finder". Expiration: the longest you are offered (you paste a new one when it runs out).',
      `Repository access: Only select repositories → ${DEFAULT_REPO}.`,
      'Permissions → Repository permissions: Contents = Read and write. Metadata = Read is set by itself.',
      'Generate token → copy it (GitHub shows it once) → paste it here.',
    ],
    note: CHECKED,
  },
  GROQ_API_KEY: {
    url: 'https://console.groq.com/keys',
    free: 'Free, no card: each model allows about 30 questions a minute and 1,000 a day, and Ava uses several models. It also turns speech into text for Ava. Groq\'s terms say it does not train on what is sent to the API.',
    steps: [
      'Go to console.groq.com and sign up (Google, GitHub or email).',
      'Left menu → API Keys → Create API Key → name it "Aviance Ava" → Submit.',
      'Copy the key (it starts with gsk_) and paste it here.',
      'Recommended: Settings → Data controls → turn Zero Data Retention on, so nothing is kept even for a day.',
    ],
    note: UNCHECKED,
  },
  CLOUDFLARE: {
    url: 'https://dash.cloudflare.com/profile/api-tokens',
    free: 'Free: 10,000 "Neurons" a day (roughly 150,000–300,000 words of answers), reset at midnight UTC; no card. Cloudflare\'s terms say it does not use your content to train any AI model.',
    steps: [
      'Go to dash.cloudflare.com and sign up (free plan).',
      'Copy your Account ID: on Account home (or Workers & Pages) it is on the right side, under "Account ID". Paste it in the first box.',
      'Top right: your profile → My Profile → API Tokens → Create Token → use the "Workers AI" template → Continue to summary → Create Token.',
      'Copy the token (Cloudflare shows it once) and paste it in the second box.',
    ],
    note: UNCHECKED,
  },
  TAVILY_API_KEY: {
    url: 'https://app.tavily.com',
    free: 'Free: 1,000 searches a month, no card. Ava only sends the words of the question (never names, emails or phone numbers). Tavily says it does not keep what is searched.',
    steps: [
      'Go to app.tavily.com and sign up (Google, GitHub or email).',
      'On the Overview page your API key is shown (it starts with tvly-) — press copy.',
      'Paste it here.',
    ],
    note: UNCHECKED,
  },
  EXA_API_KEY: {
    url: 'https://dashboard.exa.ai/api-keys',
    free: 'Free monthly credit (about 1,000 searches). Used only when Tavily is missing or fails. Only the words of the question are sent.',
    steps: [
      'Go to dashboard.exa.ai and sign up.',
      'Left menu → API Keys → Create key (or copy the default one).',
      'Paste it here.',
    ],
    note: UNCHECKED,
  },
  MISTRAL_API_KEY: {
    url: 'https://console.mistral.ai/api-keys',
    free: 'Free — only after you switch off training. The free "Experiment" plan lets Mistral use what is sent to the API to train its models UNLESS you turn that off, so do step 3 before you paste the key. No card needed (a phone number check). Mistral still keeps requests for 30 days to catch abuse. Roughly 1 question a second — a backup brain for when Groq and Cloudflare are busy.',
    steps: [
      'Go to console.mistral.ai and sign up (email, Google or Microsoft). Choose the free "Experiment" plan and confirm your phone number.',
      'API Keys (console.mistral.ai/api-keys) → Create new key → name it "Aviance Ava" → copy it (Mistral shows it once).',
      'Switch off training FIRST: open Admin (the admin console, admin.mistral.ai) → Privacy in the left menu → under "Anonymous improvement data" turn the switch OFF for the API. (The Vibe switch is separate — turning one off does not turn off the other.)',
      'Paste the key here.',
    ],
    note: UNCHECKED,
  },
  OLLAMA_API_KEY: {
    url: 'https://ollama.com/settings/keys',
    free: 'Free plan: a small allowance of cloud use each month and one question at a time — a last backup brain. Ollama says it never logs or trains on prompts and answers sent to its cloud. No card needed.',
    steps: [
      'Go to ollama.com and sign up (free).',
      'Top right: your profile → Settings → Keys (ollama.com/settings/keys) → Add API key → name it "Aviance Ava".',
      'Copy the key and paste it here.',
    ],
    note: UNCHECKED,
  },
  CEREBRAS_API_KEY: {
    url: 'https://cloud.cerebras.ai/',
    free: 'No longer free: new accounts get a small one-time credit and need a card. Optional — Groq and Cloudflare are enough. Cerebras says it does not keep or train on API inputs and outputs.',
    steps: [
      'Go to cloud.cerebras.ai and sign up.',
      'Open API Keys in the left menu → Generate API key (or copy the one made for you).',
      'Copy the key (it starts with csk-) and paste it here.',
    ],
    note: UNCHECKED,
  },
  GEMINI_API_KEY: {
    url: 'https://aistudio.google.com/apikey',
    free: 'PAID KEY ONLY. A free Gemini key (no billing) lets Google use what is sent to improve its products, with people reading it — do not paste one. With billing on it is pay-as-you-go (Flash costs cents) and nothing is used for training.',
    steps: [
      'Go to aistudio.google.com/apikey → Create API key, in a Google Cloud project.',
      'Turn on billing for that project: console.cloud.google.com/billing → link a billing account. Without billing the key is a free key and must not be used.',
      'Copy the key (it starts with AIza) and paste it here.',
    ],
    note: UNCHECKED,
  },
  OPENROUTER_API_KEY: {
    url: 'https://openrouter.ai/settings/keys',
    free: 'Paid credits (a few dollars last a long time). Ava asks OpenRouter on every question for providers that neither train on nor keep the data, so its free models (which train) are never used.',
    steps: [
      'Sign in at openrouter.ai → Settings › Privacy: turn OFF every "may train on inputs" / "may publish prompts" switch.',
      'Credits → add a few dollars.',
      'Settings › API Keys → Create key → copy it (it starts with sk-or-) and paste it here.',
    ],
    note: UNCHECKED,
  },
  GITHUB_REPO: {
    url: 'https://github.com/limethsith-create/email-distributor',
    free: 'A plain setting, not a key. Leave the default unless the repository moved.',
    steps: [
      'Only change this if the code moved to another repository: paste it as owner/repository.',
    ],
    note: CHECKED,
  },
};

// ─── the owner's buttons ─────────────────────────────────────────────────────

/** GET /api/mc/keys → { keys: [ …status + url, free, steps, note ], encKey }. Never a secret's value. */
export async function keysView() {
  const status = await secretStatus();
  return { keys: status.map((s) => ({ ...s, ...(GUIDES[s.name] || { url: null, free: null, steps: [], note: UNCHECKED }) })), encKey: hasEncKey() };
}

const card = (name) => { const c = cardOf(name); if (!c) throw new KeysError('unknown_key'); return c; };

/**
 * POST { action: 'save', name, value } (Verifalia: { name: 'VERIFALIA',
 * username, password }): check the key with the service, then store it
 * encrypted. A key the service refuses is not saved (KeysError 'refused',
 * 400, the reason in plain words). A check that could not run → saved as
 * 'not tested yet'.
 */
export async function saveKey(body = {}, { now = io.now() } = {}) {
  const { name, value } = body;
  const c = card(name);
  const envField = c.fields.find((f) => String(process.env[f] || '').trim());
  if (envField) throw new KeysError('env_key', `The ${c.short} is set on the server (${envField}) — change it there.`);
  // A two-box card: each box by its part name ({ accountId, apiToken }); `username` / `password` stand for the first / second box.
  const partNames = c.parts ? Object.keys(c.parts) : [];
  const partValue = (part, i) => String(body[part] ?? (i === 0 ? body.username : body.password) ?? '').trim();
  if (c.parts && !partNames.every((p, i) => partValue(p, i))) {
    throw new KeysError('bad_value', c.partLabels ? `Paste both the ${Object.values(c.partLabels).map((l) => l.toLowerCase()).join(' and the ')}.` : 'Paste both the user name and the password.');
  }
  const pasted = c.parts
    ? Object.fromEntries(partNames.map((part, i) => [c.parts[part], cleanValue(c.parts[part], partValue(part, i))]))
    : { [c.fields[0]]: cleanValue(c.fields[0], value) };
  if (c.secret !== false && !hasEncKey()) throw new KeysError('no_enc_key');
  const result = await runCheck(c, await valuesFor(c, pasted));
  if (result.ok === false) throw new KeysError('refused', result.problem);
  const status = await setSecret(c.name, c.parts ? Object.fromEntries(partNames.map((part) => [part, pasted[c.parts[part]]])) : pasted[c.fields[0]], { now, test: result });
  await logEvent(null, SYSTEM, 'key_saved', { name: c.name, tested: result.ok });
  return status;
}

/** POST { action: 'test', name }: the check on the stored (or env) key → the status with testedAt / ok / problem. */
export async function testKey({ name } = {}, { now = io.now() } = {}) {
  const c = card(name);
  const values = await valuesFor(c);
  if (!c.fields.every((f) => values[f])) throw new KeysError('not_set', `${c.short} is not set yet — paste it first.`);
  const result = await runCheck(c, values);
  const status = await noteTest(c.name, result, { now });
  await logEvent(null, SYSTEM, 'key_tested', { name: c.name, ok: result.ok });
  return status;
}

/** POST { action: 'forget', name }: the hub's value goes; an env value stays (and the status still says `env`). */
export async function forgetKey({ name } = {}) {
  return forgetSecret(card(name).name);
}

/** The status of one card (the route's answers carry it). */
export const keyStatus = (name) => secretStatusOf(card(name).name);

export { CARDS };
