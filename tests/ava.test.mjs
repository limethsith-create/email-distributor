// Ava's brain through the machine (src/lib/ava/, /api/mc/ava/*): live model
// discovery (preference list, overrides, a dead model dropped at once), the
// router (Groq fast / smart, fallback to Cloudflare and the paid ones, 429
// cooldowns, timeouts), the tool loop and the JSON fallback, the guide
// retrieval (BM25 + page boost + Business facts), web search (Tavily → Exa,
// no personal data), streaming (SSE), voice replies, the ears (/hear), the
// facts route, the role rules, needsKeys, the limits and the change
// requests. Every outside call is a mocked fetch — nothing leaves the test.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { __reset, kv } from '@vercel/kv';
import { AVA_IO, AVA_TIMING, __resetBrains, brainsStatus, isSmart } from '@/lib/ava/brains';
import { MODELS_IO, __resetModels, rankModels, usableIds, choose, PREFS, DISCOVER_WAIT, modelsFor } from '@/lib/ava/models';
import { planQuestion, guessNav } from '@/lib/ava/plan';
import { __resetFacts } from '@/lib/ava/facts';
import { avaChat, AvaError, cleanActions, __resetAvaLimits, parseJsonObject, PER_MINUTE, StreamFilter, parseFinal, compactHistory } from '@/lib/ava/chat';
import { toolDefs, runTool, toolContext, matchClient, cleanText, TOOL_NAMES } from '@/lib/ava/tools';
import { retrieve, chunkGuide, buildIndex, __resetGuide } from '@/lib/ava/kb';
import { SEARCH_IO, TAVILY_URL, EXA_URL, scrubQuery } from '@/lib/ava/search';
import { HEAR_IO, __resetHear, GROQ_TRANSCRIBE_URL } from '@/lib/ava/hear';
import { setOverride } from '@/lib/config';
import { employeeMayAccess } from '@/middleware';
import { K } from '@/lib/db/keys';
import { keysView, saveKey } from '@/lib/systems/keys';
import { io } from '@/lib/systems/intake-io';

const KEYS = ['GROQ_API_KEY', 'CEREBRAS_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'MISTRAL_API_KEY', 'OLLAMA_API_KEY'];
const SEARCH_KEYS = ['TAVILY_API_KEY', 'EXA_API_KEY'];
const CF_ACCOUNT = 'a'.repeat(32);
const HOSTS = { 'api.cerebras.ai': 'cerebras', 'api.groq.com': 'groq', 'generativelanguage.googleapis.com': 'gemini', 'openrouter.ai': 'openrouter', 'api.cloudflare.com': 'cloudflare', 'api.mistral.ai': 'mistral', 'ollama.com': 'ollama' };
const OWNER = { id: 'owner-1', name: 'Limeth', role: 'admin' };
const EMP = { id: 'emp-1', name: 'Nimal', role: 'employee' };

const GROQ_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3-32b', 'whisper-large-v3-turbo', 'meta-llama/llama-guard-4-12b', 'groq/compound', 'canopylabs/orpheus-v1-english', 'llama-3.1-8b-instant'];
const CF_MODELS = ['@cf/openai/gpt-oss-120b', '@cf/openai/gpt-oss-20b', '@cf/moonshotai/kimi-k2.6', '@cf/baai/bge-m3', '@cf/zai-org/glm-4.7-flash'];
const MISTRAL_MODELS = ['mistral-small-latest', 'mistral-large-latest', 'mistral-medium-latest', 'mistral-medium-2508', 'mistral-embed', 'mistral-moderation-latest', 'codestral-latest', 'pixtral-large-latest'];
const OLLAMA_MODELS = ['gpt-oss:20b', 'gpt-oss:120b', 'deepseek-v3.1:671b', 'qwen3-coder:480b', 'kimi-k2:1t'];

let clockMs = Date.parse('2026-09-29T06:00:00Z');
let calls = [];
let modelCalls = [];
let logs = [];
/** brain id → (body, n, call) => Response | 'hang' */
let script = {};
let models = {};

const ok = (message) => new Response(JSON.stringify({ choices: [{ message }] }), { status: 200, headers: { 'content-type': 'application/json' } });
const final = (reply) => ok({ role: 'assistant', content: reply });
const fail = (status, message = 'x', headers = {}) => new Response(JSON.stringify({ error: { message } }), { status, headers });
const toolCall = (name, args = {}, id = 'c1') => ok({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
/** An OpenAI-style SSE answer: text pieces, or tool-call pieces. */
function sse(pieces, { toolCalls = null } = {}) {
  const enc = new TextEncoder();
  const lines = [];
  if (toolCalls) toolCalls.forEach((c, i) => {
    lines.push({ choices: [{ delta: { tool_calls: [{ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: '' } }] } }] });
    lines.push({ choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: JSON.stringify(c.args || {}) } }] } }] });
  });
  for (const p of pieces) lines.push({ choices: [{ delta: { content: p } }] });
  const body = new ReadableStream({ start(ctl) { for (const l of lines) ctl.enqueue(enc.encode(`data: ${JSON.stringify(l)}\n\n`)); ctl.enqueue(enc.encode('data: [DONE]\n\n')); ctl.close(); } });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function install() {
  AVA_IO.now = () => clockMs;
  MODELS_IO.now = () => clockMs;
  MODELS_IO.log = (...a) => logs.push(a.join(' '));
  const net = async (url, init = {}) => {
    const u = new URL(url);
    const brain = HOSTS[u.host];
    if ((init.method || 'GET') === 'GET') {
      modelCalls.push({ brain, url, headers: init.headers });
      const list = models[brain];
      if (list === 'fail') return new Response('{}', { status: 500 });
      if (list === 'hang') return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      if (brain === 'cloudflare') return Response.json({ success: true, result: (list || CF_MODELS).map((name) => ({ name, task: { name: 'Text Generation' } })) });
      if (brain === 'mistral') return Response.json({ object: 'list', data: (list || MISTRAL_MODELS).map((id) => ({ id, capabilities: { completion_chat: !/embed|moderation/.test(id), function_calling: !/embed|moderation/.test(id) } })) });
      return Response.json({ data: (list || (brain === 'groq' ? GROQ_MODELS : brain === 'ollama' ? OLLAMA_MODELS : ['gpt-oss-120b', 'zai-glm-4.7', 'qwen-3.8-27b'])).map((id) => ({ id, active: true })) });
    }
    const body = JSON.parse(init.body);
    const call = { brain, url, body, headers: init.headers, model: body.model };
    calls.push(call);
    const n = calls.filter((c) => c.brain === brain).length;
    const r = script[brain] ? script[brain](body, n, call) : final(`hello from ${brain}`);
    if (r === 'hang') {
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    return r;
  };
  AVA_IO.fetch = net;
  MODELS_IO.fetch = net;
}

beforeEach(() => {
  __reset();
  __resetBrains();
  __resetModels();
  __resetAvaLimits();
  __resetGuide();
  __resetHear();
  __resetFacts();
  calls = []; modelCalls = []; logs = [];
  script = {}; models = {};
  clockMs += 3600_000;
  for (const k of KEYS) process.env[k] = `test-${k}`;
  process.env.CLOUDFLARE_ACCOUNT_ID = CF_ACCOUNT;
  for (const k of SEARCH_KEYS) delete process.env[k];
  for (const k of ['AVA_GROQ_MODEL', 'AVA_GROQ_SMART_MODEL', 'AVA_WHISPER_MODEL']) delete process.env[k];
  AVA_TIMING.callMs = 8_000;
  AVA_TIMING.totalMs = 22_000;
  install();
});

const ask = (text, user = OWNER, page = { view: 'trials' }, extra = {}) => avaChat({ messages: [{ role: 'user', content: text }], page, ...extra }, user);
const LONG = `Please explain to me in detail how the whole trial works from the first application to the invoice, and what I should do at each step so that nothing is missed along the way ${'really '.repeat(10)}`;
const sysOf = (c) => c.body.messages[0].content;

test('no key anywhere → needsKeys (503), and the status says what to add; keys never shown', async () => {
  for (const k of KEYS) delete process.env[k];
  await assert.rejects(ask('hi'), (e) => e instanceof AvaError && e.status === 503 && e.extra.needsKeys === true);
  const { POST } = await import('@/app/api/mc/ava/chat/route');
  const res = await POST(new Request('https://m.test/api/mc/ava/chat', { method: 'POST', headers: { 'x-hub-role': 'admin' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], page: {} }) }));
  assert.equal(res.status, 503);
  const j = await res.json();
  assert.equal(j.needsKeys, true);
  assert.match(j.error, /Settings › Keys/);
  const st = await brainsStatus();
  assert.deepEqual(st.map((b) => b.id), ['groq', 'cloudflare', 'mistral', 'ollama', 'cerebras', 'gemini', 'openrouter']);
  assert.ok(st.every((b) => b.ready === false && /No key yet/.test(b.lastError)));
  assert.match(st.find((b) => b.id === 'cloudflare').lastError, /CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN/);
  assert.equal(calls.length + modelCalls.length, 0);
  // The keys cards exist (Settings › Keys), with a page to get each one; Gemini says paid only; Cloudflare is two boxes.
  const view = await keysView();
  for (const k of ['GROQ_API_KEY', 'CEREBRAS_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'CLOUDFLARE', 'MISTRAL_API_KEY', 'OLLAMA_API_KEY', 'TAVILY_API_KEY', 'EXA_API_KEY']) assert.ok(view.keys.find((c) => c.name === k)?.url, k);
  assert.match(view.keys.find((c) => c.name === 'GEMINI_API_KEY').label, /paid key only/i);
  const cf = view.keys.find((c) => c.name === 'CLOUDFLARE');
  assert.deepEqual([cf.parts, cf.fields, cf.partLabels], [['accountId', 'apiToken'], ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'], { accountId: 'Account ID', apiToken: 'API token' }]);
  assert.equal(view.keys.find((c) => c.name === 'TAVILY_API_KEY').url, 'https://app.tavily.com');
});

test('model discovery: the best available model by preference, skipping speech/guard/compound; cached 6 h; logged', async () => {
  // Pure picking.
  assert.deepEqual(usableIds({ data: GROQ_MODELS.map((id) => ({ id })) }, 'groq'), ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3-32b', 'llama-3.1-8b-instant']);
  assert.deepEqual(choose('groq', ['openai/gpt-oss-20b', 'qwen/qwen3-32b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-120b']), { ranked: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'qwen/qwen3-32b', 'openai/gpt-oss-20b'], fast: 'openai/gpt-oss-120b', smart: 'qwen/qwen3.8-27b', quick: 'openai/gpt-oss-20b' });
  assert.deepEqual(choose('groq', ['llama-3.3-70b-versatile', 'openai/gpt-oss-20b']).fast, 'llama-3.3-70b-versatile');
  assert.ok(!usableIds({ result: CF_MODELS.map((name) => ({ name, task: { name: 'Text Generation' } })) }, 'cloudflare').some((m) => /kimi|bge/.test(m)), 'no paid-only or embedding model on Cloudflare');
  assert.deepEqual(rankModels(['x', 'y'], PREFS.groq.fast), []);

  const { GET } = await import('@/app/api/mc/ava/status/route');
  const j = await (await GET()).json();
  const g = j.brains.find((b) => b.id === 'groq');
  assert.equal(g.model, 'openai/gpt-oss-120b');
  assert.deepEqual(g.models, ['openai/gpt-oss-120b', 'qwen/qwen3-32b', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant']);
  const cf = j.brains.find((b) => b.id === 'cloudflare');
  assert.equal(cf.model, '@cf/openai/gpt-oss-120b');
  assert.ok(modelCalls.some((c) => c.url === `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/models/search?task=Text%20Generation&per_page=100`));
  assert.equal(j.brains.find((b) => b.id === 'gemini').model, 'gemini-2.5-flash', 'no list to read → the default');
  assert.ok(logs.some((l) => /groq models: fast=openai\/gpt-oss-120b smart=qwen\/qwen3-32b/.test(l)), logs.join('\n'));
  assert.ok(!JSON.stringify(j).includes('test-'), 'never a key');
  for (const b of j.brains) assert.deepEqual(Object.keys(b).sort(), ['id', 'lastError', 'lastOkAt', 'model', 'models', 'name', 'ready']);
  // Kept in Redis: a new instance (memory gone) does not ask again.
  const n = modelCalls.length;
  __resetModels();
  await ask('hi');
  assert.equal(modelCalls.length, n, 'read from Redis');
  assert.ok(await kv.get(K.avaModels('groq')));
  // After 6 hours it reads the list again.
  clockMs += 6 * 3600e3 + 1000;
  __resetModels(); await kv.del(K.avaModels('groq'));
  await ask('hi again');
  assert.ok(modelCalls.length > n);
});

test('router: a short question → Groq quick model; an everyday one → fast; a why/how/long one → strong; overrides win', async () => {
  const q = await ask('How many trials are running?');
  assert.deepEqual([q.brain, q.model, q.plan.quick], ['groq', 'openai/gpt-oss-20b', true]);
  calls = [];
  const a = await ask('Could you give me the number of trial clients that are running at the moment across everything');
  assert.equal(a.brain, 'groq');
  assert.equal(a.model, 'openai/gpt-oss-120b');
  assert.equal(calls[0].headers.authorization, 'Bearer test-GROQ_API_KEY');
  assert.equal(calls[0].body.reasoning_effort, 'low');
  assert.equal(isSmart([{ role: 'user', content: 'Why did Summit get fewer replies?' }]), true);
  assert.equal(isSmart([{ role: 'user', content: 'open calendar' }]), false);
  calls = [];
  const b = await ask(LONG);
  assert.equal(b.model, 'qwen/qwen3-32b');
  assert.equal(calls[0].body.reasoning_format, 'hidden');
  // Env override wins over the list.
  process.env.AVA_GROQ_MODEL = 'my/forced-model';
  calls = [];
  const c = await ask('hi');
  assert.equal(c.model, 'my/forced-model');
  delete process.env.AVA_GROQ_MODEL;
  // Config override too.
  await setOverride(null, 'AVA_MODELS', { groq: 'openai/gpt-oss-20b' });
  calls = [];
  assert.equal((await ask('hi')).model, 'openai/gpt-oss-20b');
  await setOverride(null, 'AVA_MODELS', {});
});

test('a model the service says is gone is dropped at once and the next one answers; never asked again', async () => {
  script.groq = (body) => (body.model === 'openai/gpt-oss-120b' ? new Response(JSON.stringify({ error: { message: 'The model `openai/gpt-oss-120b` has been decommissioned and is no longer supported.', code: 'model_decommissioned' } }), { status: 400 }) : final(`answer from ${body.model}`));
  const a = await ask('Could you give me the number of trial clients that are running at the moment across everything');
  assert.equal(a.reply, 'answer from qwen/qwen3-32b');
  assert.deepEqual(a.tried.map((t) => [t.brain, t.model, t.ok]), [['groq', 'openai/gpt-oss-120b', false], ['groq', 'qwen/qwen3-32b', true]]);
  assert.match(a.tried[0].error, /not available/);
  assert.ok(logs.some((l) => /model openai\/gpt-oss-120b is gone/.test(l)));
  calls = [];
  const b = await ask('and again');
  assert.ok(!calls.some((c) => c.model === 'openai/gpt-oss-120b'), 'dropped from the list');
  const st = (await brainsStatus()).find((x) => x.id === 'groq');
  assert.ok(!st.models.includes('openai/gpt-oss-120b'));
  assert.equal(b.brain, 'groq');
});

test('fallback: Groq resting (429 on every model) → Cloudflare Workers AI; cooldown per model; 5xx and timeouts too', async () => {
  script.groq = () => fail(429, 'rate limited', { 'retry-after': '30' });
  const a = await ask('hi');
  assert.equal(a.brain, 'cloudflare');
  assert.equal(a.model, '@cf/openai/gpt-oss-20b', 'a short question: the quick model there too');
  const cfCall = calls.find((c) => c.brain === 'cloudflare');
  assert.equal(cfCall.url, `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/v1/chat/completions`);
  assert.equal(cfCall.headers.authorization, 'Bearer test-CLOUDFLARE_API_TOKEN');
  assert.deepEqual(a.tried.map((t) => [t.brain, t.ok]), [['groq', false], ['groq', false], ['groq', false], ['cloudflare', true]]);
  assert.match(a.tried[0].error, /too many/);
  // Cooling: the next question skips Groq's resting models.
  calls = [];
  const b = await ask('and now?');
  assert.equal(b.tried[0].brain, 'cloudflare');
  // After the cooldown (30 s retry-after) Groq is first again.
  clockMs += 31_000;
  script.groq = null;
  assert.equal((await ask('again')).brain, 'groq');
  // 5xx on every Groq model → Cloudflare.
  script.groq = () => fail(503, 'overloaded');
  const d = await ask('5xx?');
  assert.equal(d.brain, 'cloudflare');
  assert.match(d.tried[0].error, /503/);
  // A refused key rests the whole brain.
  __resetBrains();
  script.groq = () => fail(401, 'bad key');
  await ask('key?');
  calls = [];
  script.groq = null;
  assert.equal((await ask('still?')).brain, 'cloudflare');
  // A timeout → next (each call has its own time limit).
  __resetBrains();
  AVA_TIMING.callMs = 40;
  script.groq = () => 'hang';
  const e = await ask('slow?');
  assert.equal(e.brain, 'cloudflare');
  assert.equal(e.tried[0].error, 'timed out');
});

test('every brain failing → 502 with what was tried; the total time is bounded', async () => {
  for (const id of ['cerebras', 'groq', 'gemini', 'openrouter', 'cloudflare', 'mistral', 'ollama']) script[id] = () => fail(500, 'down');
  await assert.rejects(ask('hi'), (e) => e.status === 502 && e.extra.tried.length >= 5 && e.extra.tried.every((t) => !t.ok));
  __resetBrains();
  AVA_TIMING.callMs = 60; AVA_TIMING.totalMs = 100;
  for (const id of Object.keys(script)) script[id] = () => 'hang';
  const realNow = AVA_IO.now;
  const t0 = Date.now();
  AVA_IO.now = () => clockMs + (Date.now() - t0);
  await assert.rejects(ask('hi'), (e) => e.status === 502);
  assert.ok(Date.now() - t0 < 1500);
  AVA_IO.now = realNow;
});

test('the prompt: answers anything, the guide chunks for this question are in it (BM25, page boost), and it stays small', async () => {
  await ask('How do I add a warm-up helper?', OWNER, { view: 'settings', tab: 'warmup' });
  const sys = sysOf(calls[0]);
  assert.match(sys, /Answer ANY question/);
  assert.match(sys, /Never say you can only help with the hub/);
  assert.match(sys, /Sri Lanka time/);
  assert.match(sys, /Limeth/);
  assert.match(sys, /never claim you did/);
  assert.match(sys, /<guide>[\s\S]*## Warm-up helpers \(Settings › Warm-up\)[\s\S]*Test and add[\s\S]*<\/guide>/);
  assert.match(sys, /no web search/i, 'no search key → says it may be out of date');
  assert.equal(calls[0].body.tools, undefined, 'a how-to: answered at once from the guide, no tool round');
  assert.equal(calls.length, 1);
  // A live question gets the tools (and the map of where things are).
  calls = [];
  await ask('Which trials need me today and what is on the calendar?');
  assert.ok(!calls[0].body.tools.some((t) => t.function.name === 'web_search'), 'no web_search without a key');
  assert.deepEqual(calls[0].body.tools.map((t) => t.function.name), ['search_hub', 'get_client', 'list_clients', 'get_numbers', 'get_calendar', 'propose_action']);
  assert.match(sysOf(calls[0]), /Where things are[\s\S]*settings sections/);
  const tokens = Math.ceil(JSON.stringify(calls[0].body.messages).length / 4) + Math.ceil(JSON.stringify(calls[0].body.tools).length / 4);
  assert.ok(tokens <= 3600, `request ≈ ${tokens} tokens`);
  // A general question gets no hub chunks it doesn't need.
  calls = [];
  await ask('What is the capital of Australia?');
  assert.ok(!/<guide>/.test(sysOf(calls[0])) || sysOf(calls[0]).split('## ').length < 4);
});

test('BM25 retrieval: the right chunk wins; the current page is boosted; long sections are cut; facts join in', () => {
  const r = retrieve('how do I give the client access to their own page', {});
  assert.match(r[0].title, /Give access/);
  const inv = retrieve('mark the invoice paid when money arrives', {});
  assert.ok(inv.slice(0, 2).some((x) => /invoice/i.test(x.title)), inv.map((x) => x.title).join(' | '));
  const prices = retrieve('how much is the growth plan', {});
  assert.match(prices[0].title, /Plans and prices/);
  assert.match(prices[0].text, /\$3,997/);
  // Page boost: the same words, a different page first.
  const idx = buildIndex([{ id: '1', title: 'Calls', text: 'calls booked from emails', pages: ['calendar'] }, { id: '2', title: 'Calls', text: 'calls booked from emails', pages: ['client'] }]);
  assert.equal(idx.search('calls booked', { boostPages: ['client'] })[0].chunk.id, '2');
  assert.equal(idx.search('calls booked', { boostPages: ['calendar'] })[0].chunk.id, '1');
  // Long sections are cut into pieces that keep their title.
  const long = chunkGuide(`## Big\n<!-- pages: trials -->\n${'Word one two three four five. '.repeat(120)}`);
  assert.ok(long.length >= 3 && long.every((c) => c.title === 'Big' && c.pages[0] === 'trials'));
  // The owner's facts.
  const f = retrieve('what hours does the owner work', { facts: 'The owner works 6 pm to 2 am Sri Lanka time, Monday to Friday.\n\nWe never promise a fixed number of sales.' });
  assert.match(f[0].title, /Business facts/);
  // The token cap.
  const all = retrieve('trial client calls emails plan invoice warm-up launch onboarding sending replies', { maxTokens: 1500, limit: 6 });
  assert.ok(all.length <= 6 && all.reduce((n, c) => n + (c.text.length + c.title.length) / 4, 0) <= 1500);
});

test('tool loop: get_client + propose_action → the answer with its buttons; suggestions come from the <<next>> line', async () => {
  script.groq = (body, n) => {
    if (n === 1) {
      assert.ok(body.tools.some((t) => t.function.name === 'get_client'));
      return toolCall('get_client', { name: 'nobody here' });
    }
    if (n === 2) {
      const tool = body.messages.filter((m) => m.role === 'tool').pop();
      assert.match(tool.content, /No client by that name/);
      return ok({ role: 'assistant', content: null, tool_calls: [
        { id: 'p1', type: 'function', function: { name: 'propose_action', arguments: JSON.stringify({ name: 'navigate', args: { view: 'settings', tab: 'warmup' } }) } },
        { id: 'p2', type: 'function', function: { name: 'propose_action', arguments: JSON.stringify({ name: 'add_change_request', label: 'Note it', args: { text: 'Show warm-up days on the list' } }) } },
        { id: 'p3', type: 'function', function: { name: 'propose_action', arguments: JSON.stringify({ name: 'send_email', args: {} }) } },
        { id: 'p4', type: 'function', function: { name: 'propose_action', arguments: JSON.stringify({ name: 'draft', args: { title: 'Note', text: 'Hi there' } }) } },
      ] });
    }
    const results = body.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
    assert.equal(results.find((r) => r.error)?.error.includes("can't be offered"), true);
    return final('Warm-up takes about two weeks.\n<<next: How do helpers work? | Which inboxes are ready? | Open Settings>>');
  };
  const r = await ask('which clients need me about warm-up today?');
  assert.equal(r.reply, 'Warm-up takes about two weeks.');
  assert.deepEqual(r.actions, [
    { type: 'navigate', view: 'settings', section: 'warmup' },
    { type: 'confirm', label: 'Note it', name: 'add_change_request', args: { text: 'Show warm-up days on the list' } },
    { type: 'draft', title: 'Note', text: 'Hi there' },
  ]);
  assert.deepEqual(r.suggestions, ['How do helpers work?', 'Which inboxes are ready?', 'Open Settings']);
  assert.equal(r.model, 'openai/gpt-oss-20b');
  // Without a <<next>> line: three sensible follow-ups anyway.
  script.groq = () => final('Sure.');
  const s = await ask('ok');
  assert.equal(s.suggestions.length, 3);
  // Old JSON answers still work.
  script.groq = () => final('{"reply":"From JSON.","actions":[{"type":"navigate","view":"calendar"}]}');
  const j = await ask('x');
  assert.deepEqual([j.reply, j.actions], ['From JSON.', [{ type: 'navigate', view: 'calendar' }]]);
});

test('tool loop stops after 4 rounds (the last one has no tools and must answer)', async () => {
  script.groq = (body, n) => (body.tools ? toolCall('list_clients', { filter: 'all' }, `c${n}`) : final('Here is where things stand.'));
  const r = await ask('status?');
  assert.equal(r.reply, 'Here is where things stand.');
  assert.equal(calls.length, 4);
  assert.ok(!calls[3].body.tools);
  assert.match(sysOf(calls[3]), /no more tools/);
});

test('JSON fallback: a brain that refuses tools gets them described in the prompt instead (old tool names still work)', async () => {
  delete process.env.CLOUDFLARE_API_TOKEN; delete process.env.CEREBRAS_API_KEY; delete process.env.GEMINI_API_KEY; delete process.env.OPENROUTER_API_KEY;
  script.groq = (body, n) => {
    if (body.tools) return fail(400, 'tools are not supported for this model');
    if (n === 2) { assert.match(sysOf({ body }), /"tool": "name"/); return ok({ role: 'assistant', content: '```json\n{"tool":"search_kb","args":{"query":"invoice"}}\n```' }); }
    const res = body.messages.find((m) => m.role === 'user' && /Result of search_kb/.test(m.content));
    assert.ok(res && /invoice/i.test(res.content));
    return ok({ role: 'assistant', content: 'Press Mark paid when the money lands.' });
  };
  const r = await ask('how many invoices are unpaid right now?');
  assert.equal(r.reply, 'Press Mark paid when the money lands.');
  assert.equal(r.brain, 'groq');
  script.groq = () => ok({ role: 'assistant', content: 'Just words.' });
  assert.equal((await ask('x')).reply, 'Just words.');
  assert.deepEqual(parseJsonObject('noise {"a":"}{","b":{"c":1}} tail'), { a: '}{', b: { c: 1 } });
  // A model that writes a broken tool call (Groq's tool_use_failed) is not a "no tools" brain: the next model answers.
  __resetBrains();
  script.groq = (body) => (body.model === 'openai/gpt-oss-120b' ? new Response(JSON.stringify({ error: { message: 'Failed to call a function. Please adjust your prompt.', code: 'tool_use_failed' } }), { status: 400 }) : final('next model'));
  const tf = await ask('How many trial clients do we have running right now across the whole hub today?');
  assert.equal(tf.reply, 'next model');
  assert.ok(calls[calls.length - 1].body.tools, 'still offered tools');
  // A brain that refuses the reasoning setting gets asked again without it.
  __resetBrains();
  script.groq = (body) => (body.reasoning_effort ? fail(400, 'reasoning_effort is not supported') : final('fine'));
  assert.equal((await ask('reasoning?')).reply, 'fine');
});

test('a team member: no money scope, no money in answers, only their own actions', async () => {
  const empDefs = toolDefs('employee');
  assert.deepEqual(empDefs.find((t) => t.function.name === 'get_numbers').function.parameters.properties.scope.enum, ['my_outreach', 'all_clients']);
  assert.ok(toolDefs('admin').find((t) => t.function.name === 'get_numbers').function.parameters.properties.scope.enum.includes('money'));
  const ctx = toolContext({ role: 'employee' });
  assert.deepEqual(await runTool('get_numbers', { scope: 'money' }, ctx), { error: 'Money is only for the owner.' });
  assert.deepEqual(await runTool('money_summary', {}, ctx), { error: 'Money is only for the owner.' });
  script.groq = (body, n) => {
    if (n === 1) { assert.match(sysOf({ body }), /never mention invoices/); return toolCall('get_numbers', { scope: 'money' }); }
    const tool = body.messages.filter((m) => m.role === 'tool').pop();
    assert.equal(tool.content, JSON.stringify({ error: 'Money is only for the owner.' }));
    return final('{"reply":"That is only for the owner.","actions":[{"type":"navigate","view":"client","id":"acme","tab":"money"},{"type":"navigate","view":"activity"},{"type":"confirm","name":"give_access","args":{"id":"acme"}},{"type":"confirm","name":"set_my_status","args":{"text":"Calling Acme"}}]}');
  };
  const r = await ask('how much did we make?', EMP);
  assert.deepEqual(r.actions, [
    { type: 'navigate', view: 'client', id: 'acme' },
    { type: 'confirm', label: 'set my status', name: 'set_my_status', args: { text: 'Calling Acme' } },
  ]);
  assert.equal(cleanActions([{ type: 'confirm', name: 'give_access', args: { id: 'acme', email: 'x@y.com' } }], 'admin')[0].args.email, undefined);
  assert.equal(cleanActions([{ type: 'navigate', view: 'client', id: 'acme', tab: 'money' }], 'admin')[0].tab, 'money');
  assert.equal(cleanActions([{ type: 'navigate', view: 'settings', tab: 'ava' }], 'admin')[0].section, 'ava', 'an old answer with the section in `tab`');
  // The role comes from the verified request, never the body.
  const { POST } = await import('@/app/api/mc/ava/chat/route');
  script.groq = (body) => { assert.match(sysOf({ body }), /a team member/); return final('ok'); };
  const res = await POST(new Request('https://m.test/api/mc/ava/chat', { method: 'POST', headers: { 'x-hub-role': 'employee' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], page: { view: 'client', clientId: 'acme', clientName: 'Acme Plumbing' }, user: { firstName: 'Nimal', role: 'admin' } }) }));
  assert.equal(res.status, 200);
  assert.match(sysOf(calls[calls.length - 1]), /Nimal[\s\S]*\(Acme Plumbing\)/);
});

test('money for the owner (get_numbers money) and get_client with calls and money', async () => {
  await kv.hset(K.client('acme'), { name: 'Acme Plumbing', state: 'converted', plan: 'starter', contactName: 'Ann Lee', contactEmail: 'ann@acme.com', createdAt: '2026-09-01T00:00:00Z' });
  await kv.sadd(K.clients(), 'acme');
  await kv.hset(K.invoice('acme'), { number: 'AV-1', amount: 2497, issuedAt: new Date(clockMs - 86400e3).toISOString(), paidAt: new Date(clockMs - 3600e3).toISOString(), status: 'paid', plan: 'starter' });
  const ctx = toolContext({ role: 'admin', now: () => new Date(clockMs) });
  const m = await runTool('get_numbers', { scope: 'money' }, ctx);
  assert.equal(m.totals.receivedAllTime, 2497);
  assert.equal(m.totals.receivedThisMonth, 2497);
  assert.deepEqual(m.clients.map((c) => [c.name, c.amountUsd, c.status]), [['Acme Plumbing', 2497, 'paid']]);
  assert.deepEqual(m.prices.growth, { priceUsdPerMonth: 3997, callsIncluded: 20, reach: 4000 });
  assert.ok(!JSON.stringify(m).includes('@') && !JSON.stringify(m).includes('Ann'));
  const c = await runTool('get_client', { name: 'acme' }, ctx);
  assert.equal(c.found, true);
  assert.deepEqual(c.money, { plan: 'starter', amountUsd: 2497, status: 'paid', issued: m.clients[0].issued, paid: m.clients[0].paid });
  assert.ok(c.calls && typeof c.calls.total === 'number');
  const ce = await runTool('get_client', { name: 'acme' }, toolContext({ role: 'employee', now: () => new Date(clockMs) }));
  assert.equal(ce.money, undefined);
  // No name → the client on screen.
  const here = await runTool('get_client', {}, toolContext({ role: 'admin', page: { clientId: 'acme' } }));
  assert.equal(here.name, 'Acme Plumbing');
  const l = await runTool('list_clients', { filter: 'paying' }, ctx);
  assert.deepEqual(l.clients.map((x) => x.name), ['Acme Plumbing']);
  const s = await runTool('search_hub', { query: 'acme' }, ctx);
  assert.equal(s.clients[0].name, 'Acme Plumbing');
  assert.ok(!JSON.stringify(s).includes('Ann'));
});

test('web_search: Tavily first, Exa when Tavily fails; only the question words go out (no emails, phones, contact names)', async () => {
  await kv.hset(K.client('acme'), { name: 'Acme Plumbing', state: 'onboarding', plan: 'trial', contactName: 'Annabel Leeworth', contactEmail: 'annabel@acme.example', createdAt: '2026-09-01T00:00:00Z' });
  await kv.sadd(K.clients(), 'acme');
  process.env.TAVILY_API_KEY = 'tvly-test'; process.env.EXA_API_KEY = 'exa-test';
  const sent = [];
  let tavilyDown = false;
  SEARCH_IO.fetch = async (url, init) => {
    sent.push({ url, init, body: JSON.parse(init.body) });
    if (url === TAVILY_URL) return tavilyDown ? new Response('{}', { status: 500 }) : Response.json({ answer: 'CAN-SPAM needs a postal address.', results: [{ title: 'CAN-SPAM Act guide', url: 'https://www.ftc.gov/business-guidance/can-spam', content: 'Every commercial email must include a valid physical postal address…' }] });
    if (url === EXA_URL) return Response.json({ results: [{ title: 'Exa result', url: 'https://example.org/x', text: 'From Exa.' }] });
    throw new Error(`unexpected ${url}`);
  };
  const ctx = toolContext({ role: 'admin' });
  const q = 'CAN-SPAM rules for Annabel Leeworth annabel@acme.example +1 (704) 555-0101 https://acme.example/x';
  const r = await runTool('web_search', { query: q }, ctx);
  assert.equal(r.via, 'tavily');
  assert.deepEqual(r.results[0], { title: 'CAN-SPAM Act guide', site: 'ftc.gov', snippet: 'Every commercial email must include a valid physical postal address…', date: null });
  assert.equal(sent[0].body.query, 'CAN-SPAM rules for');
  assert.equal(sent[0].init.headers.authorization, 'Bearer tvly-test');
  for (const s of sent) assert.ok(!/Annabel|Leeworth|@|555|https?:/.test(JSON.stringify(s.body)), JSON.stringify(s.body));
  assert.ok(!/https?:\/\//.test(JSON.stringify(r)), 'no links in the tool output');
  tavilyDown = true; sent.length = 0;
  const e = await runTool('web_search', { query: 'weather in Colombo today' }, ctx);
  assert.equal(e.via, 'exa');
  assert.deepEqual(sent.map((s) => s.url), [TAVILY_URL, EXA_URL]);
  assert.equal(sent[1].init.headers['x-api-key'], 'exa-test');
  assert.equal(scrubQuery('call me on 077 123 4567 about x@y.com'), 'call me on about');
  // With a key the tool is offered and the prompt says to search for current things.
  script.groq = (body, n) => (n === 1 ? toolCall('web_search', { query: 'latest Gmail sender rules' }) : final('Gmail wants one-click unsubscribe (ftc.gov).'));
  tavilyDown = false;
  const a = await ask('What are the latest Gmail rules for bulk senders?');
  assert.ok(calls[0].body.tools.some((t) => t.function.name === 'web_search'));
  assert.match(sysOf(calls[0]), /call web_search first/);
  assert.match(a.reply, /one-click/);
  // No key → the tool says so.
  delete process.env.TAVILY_API_KEY; delete process.env.EXA_API_KEY;
  assert.equal((await runTool('web_search', { query: 'news' }, ctx)).noKey, true);
});

test('streaming (SSE): delta pieces, then actions, then done; tool rounds first; <<next>> and <think> never shown', async () => {
  script.groq = (body, n) => {
    assert.equal(body.stream, true);
    if (n === 1) return sse([], { toolCalls: [{ id: 't1', name: 'propose_action', args: { name: 'navigate', args: { view: 'calendar' } } }] });
    return sse(['<think>hmm</think>You have ', 'two calls ', 'tomorrow.', '\n<', '<next: What time? | Who with? | Open the calendar>>']);
  };
  const { POST } = await import('@/app/api/mc/ava/chat/route');
  const res = await POST(new Request('https://m.test/api/mc/ava/chat?stream=1', { method: 'POST', headers: { 'x-hub-role': 'admin' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'What calls do I have tomorrow?' }], page: { view: 'calendar' } }) }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'no-cache, no-transform');
  assert.equal(res.headers.get('x-accel-buffering'), 'no');
  const text = await res.text();
  const events = [...text.matchAll(/event: (\w+)\ndata: (.*)\n\n/g)].map((m) => [m[1], JSON.parse(m[2])]);
  const names = events.map((e) => e[0]);
  assert.ok(names.filter((n) => n === 'delta').length >= 2, names.join(','));
  assert.deepEqual(names.filter((n) => n !== 'delta'), ['actions', 'done']);
  assert.ok(names.lastIndexOf('delta') < names.indexOf('actions'));
  const said = events.filter((e) => e[0] === 'delta').map((e) => e[1].text).join('');
  assert.equal(said.trim(), 'You have two calls tomorrow.');
  const actions = events.find((e) => e[0] === 'actions')[1];
  assert.deepEqual(actions, { actions: [{ type: 'navigate', view: 'calendar' }], suggestions: ['What time?', 'Who with?', 'Open the calendar'] });
  const done = events.find((e) => e[0] === 'done')[1];
  assert.deepEqual([done.brain, done.model, typeof done.ms, Array.isArray(done.tried)], ['groq', 'openai/gpt-oss-20b', 'number', true]);
  assert.deepEqual(Object.keys(done.timing).sort(), ['firstTokenMs', 'modelMs', 'toolMs', 'totalMs']);
  assert.deepEqual(done.plan.prefetch, ['get_calendar']);
  // accept: text/event-stream also streams; a failure is an error event.
  for (const k of KEYS) delete process.env[k];
  const bad = await POST(new Request('https://m.test/api/mc/ava/chat', { method: 'POST', headers: { 'x-hub-role': 'admin', accept: 'text/event-stream' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) }));
  const bt = await bad.text();
  assert.match(bt, /event: error\ndata: \{"error":"Ava has no AI key yet[^\n]*"needsKeys":true,"status":503\}/);
  // The filter on its own: a JSON-shaped answer is held back and sent whole at the end.
  const got = [];
  const f = new StreamFilter((t) => got.push(t));
  for (const p of ['{"reply":', '"Hi"}']) f.push(p);
  f.end();
  assert.deepEqual(got, []);
  assert.deepEqual(parseFinal('{"reply":"Hi"}', 'admin').reply, 'Hi');
  const g2 = [];
  const f2 = new StreamFilter((t) => g2.push(t));
  for (const p of ['a << b ', 'c']) f2.push(p);
  f2.end();
  assert.equal(g2.join(''), 'a << b c');
});

test('streaming a JSON-shaped (old style) answer: the reply is sent as one delta', async () => {
  script.groq = () => sse(['{"reply":"All ', 'good.","actions":[]}']);
  const { POST } = await import('@/app/api/mc/ava/chat/route');
  const res = await POST(new Request('https://m.test/api/mc/ava/chat', { method: 'POST', headers: { 'x-hub-role': 'admin' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true }) }));
  const text = await res.text();
  const deltas = [...text.matchAll(/event: delta\ndata: (.*)\n\n/g)].map((m) => JSON.parse(m[1]).text);
  assert.deepEqual(deltas, ['All good.']);
});

test('voice: 1–3 short spoken sentences, no markdown, a smaller answer', async () => {
  await ask('How is Summit doing?', OWNER, { view: 'trials' }, { voice: true });
  assert.match(sysOf(calls[0]), /SPOKEN\. Answer in 1–3 short, natural sentences\. No lists, no markdown/);
  assert.equal(calls[0].body.max_tokens, 250);
  calls = [];
  await ask('How is Summit doing?');
  assert.doesNotMatch(sysOf(calls[0]), /SPOKEN/);
  assert.equal(calls[0].body.max_tokens, 900);
});

test('a long talk: older turns become a short running summary; the request stays small', async () => {
  const messages = [];
  for (let i = 0; i < 14; i++) { messages.push({ role: 'user', content: `Question ${i} about Summit ${'x'.repeat(600)}` }); messages.push({ role: 'assistant', content: `Answer ${i} ${'y'.repeat(900)}` }); }
  messages.push({ role: 'user', content: 'And the last one?' });
  const r = await avaChat({ messages, page: {} }, OWNER);
  assert.ok(r.reply);
  const body = calls[0].body;
  assert.match(sysOf(calls[0]), /Earlier in this conversation \(summary\): they asked "Question 0/);
  assert.ok(body.messages.length <= 1 + 8, `messages: ${body.messages.length}`);
  assert.equal(body.messages[1].role, 'user');
  assert.equal(body.messages[body.messages.length - 1].content, 'And the last one?');
  const tokens = Math.ceil(JSON.stringify(body.messages).length / 4);
  assert.ok(tokens <= 2600, `≈ ${tokens} tokens`);
  const c = compactHistory([{ role: 'user', content: 'a' }]);
  assert.deepEqual(c, { talk: [{ role: 'user', content: 'a' }], summary: '' });
});

test('/hear: Groq whisper (model from the list), raw audio or form-data; 404 with no Groq key; size and type checks', async () => {
  const { POST } = await import('@/app/api/mc/ava/hear/route');
  const sentTo = [];
  HEAR_IO.fetch = async (url, init = {}) => {
    sentTo.push({ url, init });
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'whisper-large-v3' }, { id: 'whisper-large-v3-turbo' }, { id: 'openai/gpt-oss-120b' }] });
    if (url === GROQ_TRANSCRIBE_URL) {
      const f = init.body;
      assert.equal(f.get('model'), 'whisper-large-v3-turbo');
      assert.equal(f.get('file').type, 'audio/webm');
      assert.ok(f.get('prompt').includes('Aviance'));
      return Response.json({ text: ' How is Summit doing? ' });
    }
    throw new Error(url);
  };
  const audio = crypto.randomBytes(2000);
  const r = await POST(new Request('https://m.test/api/mc/ava/hear', { method: 'POST', headers: { 'content-type': 'audio/webm;codecs=opus', 'x-hub-role': 'employee' }, body: audio }));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual([j.text, j.model], ['How is Summit doing?', 'whisper-large-v3-turbo']);
  assert.equal(sentTo.find((s) => s.url === GROQ_TRANSCRIBE_URL).init.headers.authorization, 'Bearer test-GROQ_API_KEY');
  // Form-data works too.
  const fd = new FormData();
  fd.append('file', new Blob([audio], { type: 'audio/webm' }), 'a.webm');
  assert.equal((await POST(new Request('https://m.test/api/mc/ava/hear', { method: 'POST', body: fd }))).status, 200);
  // Too big, not audio, empty.
  assert.equal((await POST(new Request('https://m.test/api/mc/ava/hear', { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: crypto.randomBytes(2 * 1024 * 1024 + 10) }))).status, 413);
  assert.equal((await POST(new Request('https://m.test/api/mc/ava/hear', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hello' }))).status, 415);
  assert.equal((await POST(new Request('https://m.test/api/mc/ava/hear', { method: 'POST', headers: { 'content-type': 'audio/ogg' }, body: new Uint8Array(0) }))).status, 400);
  delete process.env.GROQ_API_KEY;
  const none = await POST(new Request('https://m.test/api/mc/ava/hear', { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: audio }));
  assert.equal(none.status, 404);
  assert.equal((await none.json()).needsKey, true);
});

test('/facts: everyone reads, only the owner writes (≤ 4 KB); the facts reach the prompt when they fit the question', async () => {
  const { GET, POST } = await import('@/app/api/mc/ava/facts/route');
  const post = (body, role) => POST(new Request('https://m.test/api/mc/ava/facts', { method: 'POST', headers: { 'x-hub-role': role }, body: JSON.stringify(body) }));
  assert.equal((await post({ text: 'x' }, 'employee')).status, 403);
  assert.equal((await post({ text: 'x'.repeat(4097) }, 'admin')).status, 400);
  const saved = await (await post({ text: 'We always offer a free 30-day trial first. Our office hours are 6 pm to 2 am Sri Lanka time.' }, 'admin')).json();
  assert.equal(saved.ok, true);
  const got = await (await GET(new Request('https://m.test/api/mc/ava/facts', { headers: { 'x-hub-role': 'employee' } }))).json();
  assert.match(got.text, /office hours/);
  assert.equal(got.maxBytes, 4096);
  await ask('What are our office hours?');
  assert.match(sysOf(calls[0]), /Business facts \(from the owner\)[\s\S]*6 pm to 2 am/);
});

test('limits: 20 a minute per person, and the daily cap for everyone', async () => {
  for (let i = 0; i < PER_MINUTE; i++) await ask(`q${i}`);
  await assert.rejects(ask('one more'), (e) => e.status === 429);
  assert.ok((await ask('someone else', EMP)).reply);
  clockMs += 61_000;
  assert.ok((await ask('later')).reply);
  await setOverride(null, 'AVA_DAILY_CAP', 1);
  clockMs += 86400e3;
  await ask('first today');
  await assert.rejects(ask('second today', EMP), (e) => e.status === 429 && /today/.test(e.message));
});

test('change requests: anyone adds, only the owner marks done; capped at 200', async () => {
  const { GET, POST } = await import('@/app/api/mc/ava/requests/route');
  const post = (body, role) => POST(new Request('https://m.test/api/mc/ava/requests', { method: 'POST', headers: { 'x-hub-role': role, 'x-hub-user': 'x@aviance.store' }, body: JSON.stringify(body) }));
  const a = await (await post({ action: 'add', text: '  Show the warm-up day on the list ' }, 'employee')).json();
  assert.equal(a.ok, true);
  assert.equal(a.request.text, 'Show the warm-up day on the list');
  assert.equal(a.request.status, 'open');
  assert.equal((await post({ action: 'add', text: '' }, 'employee')).status, 400);
  assert.equal((await post({ action: 'done', id: a.request.id }, 'employee')).status, 403);
  const done = await (await post({ action: 'done', id: a.request.id }, 'admin')).json();
  assert.equal(done.request.status, 'done');
  const list = await (await GET()).json();
  assert.deepEqual(list.requests.map((r) => [r.id, r.status]), [[a.request.id, 'done']]);
  assert.equal((await post({ action: 'done', id: 'nope' }, 'admin')).status, 404);
  for (let i = 0; i < 205; i++) await post({ action: 'add', text: `r${i}` }, 'admin');
  assert.equal((await (await GET()).json()).requests.length, 200);
});

test('middleware: team members may ask Ava, send audio, read the facts and status, add requests; never write the facts', () => {
  assert.equal(employeeMayAccess('POST', '/api/mc/ava/chat'), true);
  assert.equal(employeeMayAccess('POST', '/api/mc/ava/hear'), true);
  assert.equal(employeeMayAccess('POST', '/api/mc/ava/requests'), true);
  assert.equal(employeeMayAccess('GET', '/api/mc/ava/status'), true);
  assert.equal(employeeMayAccess('GET', '/api/mc/ava/facts'), true);
  assert.equal(employeeMayAccess('POST', '/api/mc/ava/facts'), false);
  assert.equal(employeeMayAccess('GET', '/api/mc/ava/requests'), true);
  assert.equal(employeeMayAccess('POST', '/api/mc/ava/status'), false);
  assert.equal(employeeMayAccess('POST', '/api/mc/keys'), false);
});

test('Keys: the Cloudflare card saves the account ID and token together after one check; Tavily and Exa are checked', async () => {
  process.env.ENC_KEY = process.env.ENC_KEY || crypto.randomBytes(32).toString('base64');
  delete process.env.CLOUDFLARE_ACCOUNT_ID; delete process.env.CLOUDFLARE_API_TOKEN;
  const seen = [];
  const realFetchJson = io.fetchJson;
  io.fetchJson = async (url, opts = {}) => {
    seen.push({ url, opts });
    if (url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/models/search`)) return opts.headers.authorization === 'Bearer cf-good-token' ? { ok: true, status: 200, json: { success: true, result: [] } } : { ok: false, status: 401, json: { success: false, errors: [{ message: 'Authentication error' }] } };
    if (url === 'https://api.tavily.com/usage') return { ok: true, status: 200, json: { key: { usage: 10, limit: 1000 } } };
    if (url === 'https://api.exa.ai/search') return opts.headers['x-api-key'] === 'exa-good' ? { ok: true, status: 200, json: { results: [] } } : { ok: false, status: 401, json: {} };
    return { ok: false, status: 404, json: {} };
  };
  try {
    await assert.rejects(saveKey({ name: 'CLOUDFLARE', accountId: CF_ACCOUNT, apiToken: 'cf-bad-token' }), /refused the token/);
    await assert.rejects(saveKey({ name: 'CLOUDFLARE', accountId: 'nope', apiToken: 'x' }), /32 letters/);
    await assert.rejects(saveKey({ name: 'CLOUDFLARE', accountId: CF_ACCOUNT }), /Paste both the account id and the api token/);
    const st = await saveKey({ name: 'CLOUDFLARE', accountId: CF_ACCOUNT, apiToken: 'cf-good-token' });
    assert.deepEqual([st.set, st.from, st.ok], [true, 'hub', true]);
    // The hub's older two-box form (username / password) works too.
    assert.equal((await saveKey({ name: 'CLOUDFLARE', username: CF_ACCOUNT, password: 'cf-good-token' })).ok, true);
    assert.equal((await saveKey({ name: 'TAVILY_API_KEY', value: 'tvly-good' })).detail, 'The key works · 990 searches left this month');
    await assert.rejects(saveKey({ name: 'EXA_API_KEY', value: 'exa-bad' }), /Exa said the key is invalid/);
    // Ava now sees the Cloudflare brain from the store.
    const brains = await brainsStatus();
    assert.equal(brains.find((b) => b.id === 'cloudflare').ready, true);
    assert.ok(!JSON.stringify(await keysView()).includes('cf-good-token'));
  } finally {
    io.fetchJson = realFetchJson;
  }
});

test('fuzzy client match and the text net', () => {
  const cs = [{ id: 'ridgeline-it', name: 'Ridgeline IT' }, { id: 'demo-lakeview-pt', name: 'Lakeview Physical Therapy' }, { id: 'acme', name: 'Acme Plumbing' }];
  assert.equal(matchClient("lakevew's", cs).id, 'demo-lakeview-pt');
  assert.equal(matchClient('ridge line', cs).id, 'ridgeline-it');
  assert.equal(matchClient('Acme', cs).id, 'acme');
  assert.equal(matchClient('zzz', cs), null);
  assert.equal(cleanText('Write to dana@ridgelineit.com or call +1 (704) 555-0101 — Dana Whitfield said so. See https://x.test/c/abc', ['Dana Whitfield', 'Dana', 'Whitfield']),
    'Write to [email] or call [phone] — the client said so. See [link]');
  assert.equal(cleanText('Day 12 of 30 · 2026-10-06T13:00:00.000Z · 91%'), 'Day 12 of 30 · 2026-10-06T13:00:00.000Z · 91%');
  assert.deepEqual(TOOL_NAMES, ['search_hub', 'get_client', 'list_clients', 'get_numbers', 'get_calendar', 'web_search', 'propose_action']);
});

// ─── Mistral and Ollama Cloud; opening any tab and reading it; a faster first word ───

test('Mistral and Ollama Cloud: model discovery, key cards, and the fallback order Groq → Cloudflare → Mistral → Ollama → paid', async () => {
  const mis = usableIds({ data: MISTRAL_MODELS.map((id) => ({ id, capabilities: { completion_chat: !/embed|moderation/.test(id), function_calling: !/embed|moderation/.test(id) } })) }, 'mistral');
  assert.deepEqual(mis, ['mistral-small-latest', 'mistral-large-latest', 'mistral-medium-latest', 'mistral-medium-2508']);
  assert.deepEqual([choose('mistral', mis).fast, choose('mistral', mis).smart], ['mistral-medium-latest', 'mistral-large-latest']);
  assert.equal(choose('mistral', ['mistral-small-latest', 'mistral-small-2506']).fast, 'mistral-small-latest');
  const oll = usableIds({ data: OLLAMA_MODELS.map((id) => ({ id })) }, 'ollama');
  assert.ok(!oll.includes('qwen3-coder:480b'));
  assert.equal(choose('ollama', oll).fast, 'gpt-oss:120b');
  assert.equal(choose('ollama', ['gpt-oss:20b', 'deepseek-v3.1:671b', 'gemma3:27b']).fast, 'deepseek-v3.1:671b', 'no gpt-oss:120b → the biggest');

  const st = await brainsStatus();
  assert.deepEqual(st.map((b) => b.id), ['groq', 'cloudflare', 'mistral', 'ollama', 'cerebras', 'gemini', 'openrouter']);
  assert.equal(st.find((b) => b.id === 'mistral').model, 'mistral-medium-latest');
  assert.equal(st.find((b) => b.id === 'ollama').model, 'gpt-oss:120b');
  assert.deepEqual(modelCalls.filter((c) => /mistral|ollama/.test(c.brain)).map((c) => [c.url, c.headers.authorization]).sort(), [
    ['https://api.mistral.ai/v1/models', 'Bearer test-MISTRAL_API_KEY'],
    ['https://ollama.com/v1/models', 'Bearer test-OLLAMA_API_KEY'],
  ]);

  // Groq resting and Cloudflare down → Mistral; Mistral down too → Ollama.
  script.groq = () => fail(429, 'rate limited');
  script.cloudflare = () => fail(503, 'down');
  const long = 'Could you give me the number of trial clients that are running at the moment across everything';
  const a = await ask(long);
  assert.deepEqual([a.brain, a.model], ['mistral', 'mistral-medium-latest']);
  assert.deepEqual(a.tried.map((t) => t.brain), ['groq', 'groq', 'groq', 'cloudflare', 'cloudflare', 'mistral']);
  const mc = calls.find((c) => c.brain === 'mistral');
  assert.equal(mc.url, 'https://api.mistral.ai/v1/chat/completions');
  assert.equal(mc.headers.authorization, 'Bearer test-MISTRAL_API_KEY');
  assert.equal(mc.body.reasoning_effort, undefined);
  assert.ok(mc.body.tools, 'Mistral gets the tools');
  // Mistral only takes 9-letter tool-call ids: the look-ups made before the first call use them.
  for (const m of mc.body.messages) for (const c of m.tool_calls || []) assert.match(c.id, /^[A-Za-z0-9]{9}$/);
  for (const m of mc.body.messages.filter((x) => x.role === 'tool')) assert.match(m.tool_call_id, /^[A-Za-z0-9]{9}$/);
  __resetBrains();
  script.mistral = () => fail(500, 'down');
  const b = await ask(long);
  assert.deepEqual([b.brain, b.model], ['ollama', 'gpt-oss:120b']);
  assert.equal(calls.find((c) => c.brain === 'ollama').url, 'https://ollama.com/v1/chat/completions');
  assert.equal(calls.find((c) => c.brain === 'ollama').headers.authorization, 'Bearer test-OLLAMA_API_KEY');

  // The key cards: Mistral says to switch training off first (and where); Ollama keeps nothing.
  const view = await keysView();
  const mk = view.keys.find((c) => c.name === 'MISTRAL_API_KEY');
  assert.match(mk.label, /free — only after you switch off training/);
  assert.equal(mk.url, 'https://console.mistral.ai/api-keys');
  assert.ok(mk.steps.some((x) => /Privacy/.test(x) && /Anonymous improvement data/.test(x) && /OFF/.test(x)));
  const ok2 = view.keys.find((c) => c.name === 'OLLAMA_API_KEY');
  assert.equal(ok2.url, 'https://ollama.com/settings/keys');
  // Their checks are one model-list call each.
  process.env.ENC_KEY = process.env.ENC_KEY || crypto.randomBytes(32).toString('base64');
  delete process.env.MISTRAL_API_KEY; delete process.env.OLLAMA_API_KEY;
  const realFetchJson = io.fetchJson;
  const seen = [];
  io.fetchJson = async (url, opts = {}) => {
    seen.push(url);
    if (url === 'https://api.mistral.ai/v1/models') return opts.headers.authorization === 'Bearer mis-good' ? { ok: true, status: 200, json: { data: [{ id: 'a' }, { id: 'b' }] } } : { ok: false, status: 401, json: {} };
    if (url === 'https://ollama.com/v1/models') return { ok: true, status: 200, json: { data: [{ id: 'gpt-oss:120b' }] } };
    return { ok: false, status: 404, json: {} };
  };
  try {
    await assert.rejects(saveKey({ name: 'MISTRAL_API_KEY', value: 'mis-bad' }), /Mistral said the key is invalid/);
    assert.equal((await saveKey({ name: 'MISTRAL_API_KEY', value: 'mis-good' })).detail, 'The key works · 2 models available');
    assert.equal((await saveKey({ name: 'OLLAMA_API_KEY', value: 'oll-good' })).ok, true);
    assert.deepEqual([...new Set(seen)], ['https://api.mistral.ai/v1/models', 'https://ollama.com/v1/models']);
  } finally {
    io.fetchJson = realFetchJson;
  }
});

test('navigate: every view, client tab and Settings section is checked (old names mapped, wrong ones dropped); read comes last', () => {
  const nav = (a, role = 'admin') => cleanActions([{ type: 'navigate', ...a }], role)[0] || null;
  for (const v of ['trials', 'paying', 'calendar', 'team', 'mystats', 'activity', 'inquiries', 'behind', 'settings']) assert.deepEqual(nav({ view: v }), { type: 'navigate', view: v });
  for (const t of ['overview', 'conversations', 'sent', 'calls', 'messages', 'money', 'health', 'leads', 'setup']) assert.equal(nav({ view: 'client', id: 'acme', tab: t }).tab, t);
  for (const s of ['alerts', 'phone', 'details', 'keys', 'ava', 'google', 'inboxes', 'warmup', 'replybot', 'demo', 'status', 'behind', 'advanced', 'look', 'account']) assert.deepEqual(nav({ view: 'settings', section: s }), { type: 'navigate', view: 'settings', section: s });
  assert.equal(nav({ view: 'client', id: 'acme', tab: 'emails' }).tab, 'sent');
  assert.equal(nav({ view: 'client', id: 'acme', tab: 'history' }).tab, 'setup');
  assert.equal(nav({ view: 'client', id: 'acme', tab: 'deliverability' }).tab, 'health');
  assert.deepEqual(nav({ view: 'client', id: 'acme', tab: 'nonsense' }), { type: 'navigate', view: 'client', id: 'acme' }, 'a wrong tab is dropped');
  assert.deepEqual(nav({ view: 'settings', section: 'nope' }), { type: 'navigate', view: 'settings' }, 'a wrong section is dropped');
  assert.equal(nav({ view: 'settings', section: 'theme' }).section, 'look');
  assert.equal(nav({ view: 'settings', tab: 'warm-up' }).section, 'warmup');
  assert.deepEqual(nav({ view: 'calendar', id: 'acme', tab: 'money', section: 'keys' }), { type: 'navigate', view: 'calendar' });
  assert.equal(nav({ view: 'client' }), null, 'a client needs an id');
  assert.equal(nav({ view: 'client', id: 'bad id!' }), null);
  assert.equal(nav({ view: 'nowhere' }), null);
  // A team member: no owner-only views, no Settings (any section), no "Only you" tabs.
  for (const v of ['activity', 'settings']) assert.equal(nav({ view: v, section: 'keys' }, 'employee'), null);
  for (const t of ['money', 'health', 'leads', 'setup']) assert.deepEqual(nav({ view: 'client', id: 'acme', tab: t }, 'employee'), { type: 'navigate', view: 'client', id: 'acme' });
  assert.equal(nav({ view: 'client', id: 'acme', tab: 'calls' }, 'employee').tab, 'calls');
  // read: only {what:'page'}, once, after the navigate.
  assert.deepEqual(cleanActions([{ type: 'read', what: 'page' }, { type: 'navigate', view: 'mystats' }, { type: 'read' }], 'employee'), [{ type: 'navigate', view: 'mystats' }, { type: 'read', what: 'page' }]);
  assert.deepEqual(cleanActions([{ type: 'read', what: 'passwords' }], 'admin'), []);
});

test('the planner (no AI call): general → direct; live data → tools with the look-ups named; navigation and "read it" placed', () => {
  const clients = [{ id: 'lakeview-pt', name: 'Lakeview Physical Therapy' }, { id: 'summit', name: 'Summit Roofing Co' }, { id: 'aviance', name: 'Aviance' }];
  const P = (t, o = {}) => planQuestion(t, { role: 'admin', clients, ...o });
  for (const t of ['hi', 'Thanks!', 'What is a bounce?', 'How do I add a warm-up helper?', 'What does qualified call mean?', 'Write me a short follow-up email', 'What is the capital of Australia?', 'explain the day-30 decision']) {
    const p = P(t);
    assert.equal(p.mode, 'direct', t);
    assert.deepEqual(p.prefetch, [], t);
  }
  const cases = [
    ['How many trials are running?', [['list_clients', { filter: 'trials' }]]],
    ['What needs me today?', [['list_clients', { filter: 'needs_you' }]]],
    ['What calls do I have tomorrow?', [['get_calendar', {}]]],
    ['How much did we make this month?', [['get_numbers', { scope: 'money' }]]],
    ['How is Lakeveiw doing?', [['get_client', { id: 'lakeview-pt' }]]],
    ["Who's online in the team right now?", [['search_hub', { query: 'team' }]]],
    ['How are my stats this week?', [['get_numbers', { scope: 'my_outreach' }]]],
    ['How is Summit doing and what calls are on the calendar tomorrow?', [['get_client', { id: 'summit' }]]],
  ];
  for (const [t, want] of cases) {
    const p = P(t);
    assert.equal(p.mode, 'tools', t);
    assert.deepEqual(p.prefetch.map((x) => [x.name, x.args]), want, t);
  }
  assert.deepEqual(P('How much did we make this month?', { role: 'employee' }).prefetch.map((x) => x.name), ['list_clients'], 'no money look-up for a team member');
  // On a client's page, "they / this client" is that client.
  assert.deepEqual(P('How many replies have they had?', { page: { view: 'client', clientId: 'summit' } }).prefetch, [{ name: 'get_client', args: { id: 'summit' } }]);
  // Navigation.
  const nav = (t, o) => { const p = P(t, o); return [p.mode, p.nav, p.read]; };
  assert.deepEqual(nav("open Lakeview's money"), ['tools', { view: 'client', id: 'lakeview-pt', tab: 'money' }, false]);
  assert.deepEqual(nav('take me to the keys'), ['direct', { view: 'settings', section: 'keys' }, false]);
  assert.deepEqual(nav('show the warm-up settings'), ['direct', { view: 'settings', section: 'warmup' }, false]);
  assert.deepEqual(nav('open my stats and read it'), ['direct', { view: 'mystats' }, true]);
  assert.deepEqual(P('open my stats and read it').prefetch, [{ name: 'get_numbers', args: { scope: 'my_outreach' } }]);
  assert.deepEqual(nav('open the calendar'), ['direct', { view: 'calendar' }, false]);
  assert.deepEqual(nav('go to plan call requests'), ['direct', { view: 'inquiries' }, false]);
  assert.deepEqual(nav('open Summit and read me the conversations'), ['tools', { view: 'client', id: 'summit', tab: 'conversations' }, true]);
  assert.deepEqual(nav('show the light or dark setting'), ['direct', { view: 'settings', section: 'look' }, false]);
  assert.equal(P("what's on this tab?", { page: { view: 'client', clientId: 'summit', tab: 'calls' } }).read, true);
  assert.deepEqual(guessNav('open their health tab', { page: { view: 'client', clientId: 'summit' } }), { view: 'client', id: 'summit', tab: 'health' });
  assert.equal(P('open the thing I was looking at').mode, 'tools', 'a place it cannot place → the model finds it');
  // Quick: short or spoken, not smart, and nothing left for the model to look up.
  assert.equal(P('hi').quick, true);
  assert.equal(P('hi', { smart: true }).quick, false);
  assert.equal(P('open the thing I was looking at').quick, false);
});

test('"open X and read it": one call, no tool round; navigate + read for the hub; a team member never reaches owner-only places', async () => {
  await kv.hset(K.client('lakeview-pt'), { name: 'Lakeview Physical Therapy', state: 'converted', plan: 'starter', createdAt: '2026-09-01T00:00:00Z' });
  await kv.sadd(K.clients(), 'lakeview-pt');
  script.groq = () => final('Opening Lakeview’s money now.');
  const r = await ask("open Lakeview's money and read it", OWNER, { view: 'trials' });
  // It names Lakeview, so its whole picture is looked up first (tools mode) — the model can answer at once.
  assert.deepEqual(r.actions, [{ type: 'navigate', view: 'client', id: 'lakeview-pt', tab: 'money' }, { type: 'read', what: 'page' }]);
  calls = [];
  script.groq = (body) => { assert.equal(body.tools, undefined); assert.match(sysOf({ body }), /opening My stats/); return final('Here are your stats.'); };
  const s = await ask('open my stats and read it');
  assert.equal(calls.length, 1, 'no tool round');
  assert.deepEqual(s.actions, [{ type: 'navigate', view: 'mystats' }, { type: 'read', what: 'page' }]);
  assert.ok(calls[0].body.messages.some((m) => /Result of get_numbers/.test(m.content || '')), 'the numbers (no names) came with the question');
  const k = await ask('take me to the keys');
  assert.deepEqual(k.actions, [{ type: 'navigate', view: 'settings', section: 'keys' }]);
  const w = await ask('show the warm-up settings');
  assert.deepEqual(w.actions, [{ type: 'navigate', view: 'settings', section: 'warmup' }]);
  // The model's own navigate (from propose_action) wins over the planner's guess.
  script.groq = (body, n) => (n === 1 && body.tools ? toolCall('propose_action', { name: 'navigate', args: { view: 'client', id: 'lakeview-pt', tab: 'calls' } }) : final('Here.'));
  calls = [];
  const m = await ask('open the thing with the Lakeview calls please');
  assert.deepEqual(m.actions[0], { type: 'navigate', view: 'client', id: 'lakeview-pt', tab: 'calls' });
  // A team member: no Settings, no money tab (the client's overview instead), read still works.
  script.groq = () => final('Sure.');
  assert.deepEqual((await ask('take me to the keys', EMP)).actions, []);
  assert.deepEqual((await ask("open Lakeview's money and read it", EMP)).actions, [{ type: 'navigate', view: 'client', id: 'lakeview-pt' }, { type: 'read', what: 'page' }]);
  script.groq = () => final('{"reply":"ok","actions":[{"type":"navigate","view":"activity"},{"type":"navigate","view":"settings","section":"keys"}]}');
  assert.deepEqual((await ask('hmm', EMP)).actions, []);
});

test('faster first word: a general question streams from the first call (no tools); live look-ups run before it, side by side; timing is reported', async () => {
  await kv.hset(K.client('summit'), { name: 'Summit Roofing Co', state: 'sending', plan: 'trial', createdAt: '2026-09-01T00:00:00Z' });
  await kv.sadd(K.clients(), 'summit');
  script.groq = (body) => { assert.equal(body.tools, undefined); assert.equal(body.stream, true); return sse(['Warm-up ', 'takes two weeks.']); };
  const { POST } = await import('@/app/api/mc/ava/chat/route');
  const res = await POST(new Request('https://m.test/api/mc/ava/chat?stream=1', { method: 'POST', headers: { 'x-hub-role': 'admin' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'What is warm-up?' }], page: { view: 'trials' }, voice: true }) }));
  const text = await res.text();
  const done = JSON.parse(text.match(/event: done\ndata: (.*)\n/)[1]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'openai/gpt-oss-20b', 'short and spoken → the quick model');
  assert.equal(calls[0].body.max_tokens, 250);
  assert.ok((sysOf(calls[0]).match(/^## /gm) || []).length <= 4, 'voice: at most 4 guide chunks');
  assert.deepEqual(done.plan, { mode: 'direct', why: 'general', prefetch: [], quick: true });
  const t = done.timing;
  assert.deepEqual(Object.keys(t).sort(), ['firstTokenMs', 'modelMs', 'toolMs', 'totalMs']);
  assert.equal(t.toolMs, 0);
  assert.ok(t.firstTokenMs <= t.totalMs && t.modelMs <= t.totalMs + 1);
  // Live: the client and the calendar are looked up side by side and come WITH the first call; the model answers at once.
  calls = [];
  script.groq = (body) => final(`seen ${body.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id).join(',')}`);
  const r = await ask('How is Summit doing and what calls are on the calendar tomorrow?');
  assert.equal(calls.length, 1, 'no tool round');
  const first = calls[0].body.messages;
  const asked = first.find((m) => m.role === 'assistant' && m.tool_calls);
  assert.deepEqual(asked.tool_calls.map((c) => c.function.name), ['get_client']);
  assert.match(first.find((m) => m.role === 'tool').content, /Summit Roofing Co/);
  assert.match(r.reply, /^seen pf/);
  assert.equal(typeof r.timing.toolMs, 'number');
  // Several look-ups at once: all their results are in the first call.
  calls = [];
  const n = await ask('What needs me today and how much money came in?');
  assert.deepEqual(n.plan.prefetch.sort(), ['get_numbers', 'list_clients']);
  assert.equal(calls[0].body.messages.filter((m) => m.role === 'tool').length, 2);
  // A long complex question still gets the strong model.
  calls = [];
  await ask(LONG);
  assert.equal(calls[0].model, 'qwen/qwen3-32b');
});

test('model lists never hold a question up: a stale list is used at once (read again behind), a first read waits ≤ DISCOVER_WAIT; /warm loads it', async () => {
  // A list from 7 hours ago in Redis: used at once, and read again in the background.
  await kv.set(K.avaModels('groq'), JSON.stringify({ at: clockMs - 7 * 3600e3, available: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'] }));
  models.groq = 'hang';
  AVA_TIMING.callMs = 8_000;
  const t0 = Date.now();
  const a = await ask('hi');
  assert.equal(a.model, 'openai/gpt-oss-20b');
  assert.ok(Date.now() - t0 < 500, 'did not wait for the list');
  assert.ok(modelCalls.some((c) => c.brain === 'groq'), 'the list is being read again behind');
  // Nothing anywhere + a list that never comes: the defaults after DISCOVER_WAIT.
  __resetModels(); await kv.del(K.avaModels('groq'));
  DISCOVER_WAIT.ms = 50;
  const t1 = Date.now();
  const b = await ask('hello again');
  assert.ok(Date.now() - t1 < 1500);
  assert.equal(b.brain, 'groq');
  assert.equal((await modelsFor({ id: 'groq', apiKey: 'k', modelsUrl: 'https://api.groq.com/openai/v1/models' })).source, 'default');
  DISCOVER_WAIT.ms = 800;
  // GET /api/mc/ava/warm: model lists, the guide index, no AI call; team members may call it.
  __resetModels(); models.groq = null;
  const { GET } = await import('@/app/api/mc/ava/warm/route');
  calls = [];
  const w = await (await GET()).json();
  assert.equal(w.ok, true);
  assert.equal(w.ready, true);
  assert.ok(w.guide > 10);
  assert.deepEqual(w.brains.find((x) => x.id === 'groq'), { id: 'groq', model: 'openai/gpt-oss-120b', quick: 'openai/gpt-oss-20b', source: 'live' });
  assert.equal(w.brains.find((x) => x.id === 'mistral').model, 'mistral-medium-latest');
  assert.equal(calls.length, 0, 'no AI call');
  assert.ok(!JSON.stringify(w).includes('test-'));
  assert.equal(employeeMayAccess('GET', '/api/mc/ava/warm'), true);
});
