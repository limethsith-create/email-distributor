// Ava's brain through the machine (src/lib/ava/, /api/mc/ava/*): the router
// (fastest for short, strongest for long, fallback on 429 / 5xx / timeout,
// cooldown after 429), the tool loop, the JSON fallback, the role rules
// (a team member never gets money), needsKeys, the limits and the change
// requests. Every AI call is a mocked fetch — nothing leaves the test.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, kv } from '@vercel/kv';
import { AVA_IO, AVA_TIMING, __resetBrains, brainsStatus } from '@/lib/ava/brains';
import { avaChat, AvaError, cleanActions, __resetAvaLimits, parseJsonObject, PER_MINUTE } from '@/lib/ava/chat';
import { toolDefs, runTool, toolContext, matchClient, cleanText } from '@/lib/ava/tools';
import { setOverride } from '@/lib/config';
import { employeeMayAccess } from '@/middleware';
import { K } from '@/lib/db/keys';
import { keysView } from '@/lib/systems/keys';

const KEYS = ['GROQ_API_KEY', 'CEREBRAS_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY'];
const HOSTS = { 'api.cerebras.ai': 'cerebras', 'api.groq.com': 'groq', 'generativelanguage.googleapis.com': 'gemini', 'openrouter.ai': 'openrouter' };
const OWNER = { id: 'owner-1', name: 'Limeth', role: 'admin' };
const EMP = { id: 'emp-1', name: 'Nimal', role: 'employee' };

let clockMs = Date.parse('2026-09-29T06:00:00Z');
let calls = [];
/** brain id → (body, n) => Response | 'hang' */
let script = {};

const ok = (message) => new Response(JSON.stringify({ choices: [{ message }] }), { status: 200, headers: { 'content-type': 'application/json' } });
const final = (reply, actions = []) => ok({ role: 'assistant', content: JSON.stringify({ reply, actions }) });
const fail = (status, message = 'x', headers = {}) => new Response(JSON.stringify({ error: { message } }), { status, headers });
const toolCall = (name, args = {}, id = 'c1') => ok({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

function install() {
  AVA_IO.now = () => clockMs;
  AVA_IO.fetch = async (url, init = {}) => {
    const brain = HOSTS[new URL(url).host];
    const body = JSON.parse(init.body);
    calls.push({ brain, url, body, headers: init.headers });
    const n = calls.filter((c) => c.brain === brain).length;
    const r = script[brain] ? script[brain](body, n) : final(`hello from ${brain}`);
    if (r === 'hang') {
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    return r;
  };
}

beforeEach(() => {
  __reset();
  __resetBrains();
  __resetAvaLimits();
  calls = [];
  script = {};
  clockMs += 3600_000;
  for (const k of KEYS) process.env[k] = `test-${k}`;
  AVA_TIMING.callMs = 10_000;
  AVA_TIMING.totalMs = 20_000;
  install();
});

const ask = (text, user = OWNER, page = { view: 'trials' }) => avaChat({ messages: [{ role: 'user', content: text }], page }, user);
const LONG = `Please explain to me in detail how the whole trial works from the first application to the invoice, and what I should do at each step so that nothing is missed along the way ${'really '.repeat(10)}`;

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
  assert.deepEqual(st.map((b) => b.id), ['cerebras', 'groq', 'gemini', 'openrouter']);
  assert.ok(st.every((b) => b.ready === false && /No key yet/.test(b.lastError)));
  assert.equal(calls.length, 0);
  // The keys cards exist (Settings › Keys), with a page to get each one; Gemini says paid only.
  const view = await keysView();
  for (const k of KEYS) assert.ok(view.keys.find((c) => c.name === k)?.url, k);
  assert.match(view.keys.find((c) => c.name === 'GEMINI_API_KEY').label, /paid key only/i);
});

test('router: a short question goes to the fastest brain, a long one to the strongest', async () => {
  const a = await ask('How many trials are running?');
  assert.equal(a.brain, 'cerebras');
  assert.equal(calls[0].brain, 'cerebras');
  assert.equal(calls[0].body.model, 'gpt-oss-120b');
  assert.equal(calls[0].headers.authorization, 'Bearer test-CEREBRAS_API_KEY');
  calls = [];
  const b = await ask(LONG);
  assert.equal(b.brain, 'gemini');
  assert.equal(calls[0].brain, 'gemini');
  // OpenRouter always asks for no-training, no-retention providers.
  delete process.env.GEMINI_API_KEY; delete process.env.CEREBRAS_API_KEY; delete process.env.GROQ_API_KEY;
  calls = [];
  await ask('hi');
  assert.deepEqual(calls[0].body.provider, { data_collection: 'deny', zdr: true });
});

test('fallback on 429 with a cooldown, on 5xx and on a timeout; the status shows it', async () => {
  script.cerebras = () => fail(429, 'rate limited');
  const a = await ask('hi');
  assert.equal(a.brain, 'groq');
  assert.deepEqual(a.tried.map((t) => [t.brain, t.ok]), [['cerebras', false], ['groq', true]]);
  assert.match(a.tried[0].error, /too many/);
  let st = await brainsStatus();
  assert.equal(st.find((b) => b.id === 'cerebras').ready, false);
  assert.match(st.find((b) => b.id === 'cerebras').lastError, /resting/);
  assert.ok(st.find((b) => b.id === 'groq').lastOkAt);

  // Cooling: the next short question starts at groq, not cerebras.
  calls = [];
  const b = await ask('and now?');
  assert.equal(b.tried[0].brain, 'groq');
  assert.ok(!calls.some((c) => c.brain === 'cerebras'));

  // After the cooldown cerebras is first again.
  clockMs += AVA_TIMING.cooldownMs + 1000;
  script.cerebras = null;
  const c = await ask('again');
  assert.equal(c.brain, 'cerebras');

  // 5xx → next.
  script.cerebras = () => fail(503, 'overloaded');
  const d = await ask('5xx?');
  assert.equal(d.brain, 'groq');
  assert.match(d.tried[0].error, /503/);

  // A timeout → next (each call has its own time limit).
  __resetBrains();
  AVA_TIMING.callMs = 40;
  script.cerebras = () => 'hang';
  const e = await ask('slow?');
  assert.equal(e.brain, 'groq');
  assert.equal(e.tried[0].error, 'timed out');
});

test('every brain failing → 502 with what was tried; the total time is bounded', async () => {
  for (const id of ['cerebras', 'groq', 'gemini', 'openrouter']) script[id] = () => fail(500, 'down');
  await assert.rejects(ask('hi'), (e) => e.status === 502 && e.extra.tried.length === 4 && e.extra.tried.every((t) => !t.ok));
  // Total budget: the brains hang, each gets at most what is left.
  __resetBrains();
  AVA_TIMING.callMs = 60; AVA_TIMING.totalMs = 100;
  for (const id of ['cerebras', 'groq', 'gemini', 'openrouter']) script[id] = () => 'hang';
  const realNow = AVA_IO.now;
  const t0 = Date.now();
  AVA_IO.now = () => clockMs + (Date.now() - t0);
  await assert.rejects(ask('hi'), (e) => e.status === 502);
  assert.ok(Date.now() - t0 < 1500);
  AVA_IO.now = realNow;
});

test('tool loop: the brain calls search_kb, gets the guide, answers with actions (cleaned)', async () => {
  script.cerebras = (body, n) => {
    if (n === 1) {
      assert.ok(body.tools.some((t) => t.function.name === 'search_kb'));
      assert.match(body.messages[0].content, /You are Ava/);
      assert.match(body.messages[0].content, /Sri Lanka time/);
      assert.match(body.messages[0].content, /Limeth/);
      assert.match(body.messages[0].content, /never claim you did/);
      return toolCall('search_kb', { query: 'what is warm-up' });
    }
    const tool = body.messages.find((m) => m.role === 'tool');
    assert.ok(tool, 'the tool result went back');
    assert.match(tool.content, /Warm-up/);
    return final('Warm-up takes about two weeks.', [
      { type: 'navigate', view: 'settings', tab: 'warmup' },
      { type: 'navigate', view: 'nowhere' },
      { type: 'confirm', name: 'send_email', label: 'Send it' },
      { type: 'confirm', name: 'add_change_request', label: 'Note it', args: { text: 'Show warm-up days on the list' } },
      { type: 'draft', title: 'Note', text: 'Hi there' },
    ]);
  };
  const r = await ask('what is warm-up?');
  assert.equal(r.reply, 'Warm-up takes about two weeks.');
  assert.deepEqual(r.actions, [
    { type: 'navigate', view: 'settings', tab: 'warmup' },
    { type: 'confirm', label: 'Note it', name: 'add_change_request', args: { text: 'Show warm-up days on the list' } },
    { type: 'draft', title: 'Note', text: 'Hi there' },
  ]);
  assert.equal(calls.length, 2);
});

test('tool loop stops after 4 rounds (the last one has no tools and must answer)', async () => {
  script.cerebras = (body, n) => (body.tools ? toolCall('hub_summary', {}, `c${n}`) : final('Here is where things stand.'));
  const r = await ask('status?');
  assert.equal(r.reply, 'Here is where things stand.');
  assert.equal(calls.length, 4);
  assert.ok(!calls[3].body.tools);
});

test('JSON fallback: a brain that refuses tools gets them described in the prompt instead', async () => {
  delete process.env.CEREBRAS_API_KEY; delete process.env.GEMINI_API_KEY; delete process.env.OPENROUTER_API_KEY;
  script.groq = (body, n) => {
    if (body.tools) return fail(400, 'tools are not supported for this model');
    if (n === 2) { assert.match(body.messages[0].content, /"tool": "name"/); return ok({ role: 'assistant', content: 'Sure: ```json\n{"tool":"search_kb","args":{"query":"invoice"}}\n```' }); }
    assert.ok(body.messages.some((m) => m.role === 'user' && /Result of search_kb/.test(m.content)));
    return ok({ role: 'assistant', content: '{"reply":"Press Mark paid when the money lands.","actions":[]}' });
  };
  const r = await ask('how do invoices work?');
  assert.equal(r.reply, 'Press Mark paid when the money lands.');
  assert.equal(r.brain, 'groq');
  // A plain-text answer (no JSON) is still an answer.
  script.groq = () => ok({ role: 'assistant', content: 'Just words.' });
  assert.equal((await ask('x')).reply, 'Just words.');
  assert.deepEqual(parseJsonObject('noise {"a":"}{","b":{"c":1}} tail'), { a: '}{', b: { c: 1 } });
});

test('a team member: no money tool, no money in answers, only their own actions', async () => {
  assert.ok(!toolDefs('employee').some((t) => t.function.name === 'money_summary'));
  assert.ok(toolDefs('admin').some((t) => t.function.name === 'money_summary'));
  const ctx = toolContext({ role: 'employee' });
  assert.deepEqual(await runTool('money_summary', {}, ctx), { error: 'Money is only for the owner.' });
  // The brain tries anyway: the tool refuses.
  script.cerebras = (body, n) => {
    if (n === 1) { assert.match(body.messages[0].content, /never mention invoices/); return toolCall('money_summary'); }
    const tool = body.messages.find((m) => m.role === 'tool');
    assert.equal(tool.content, JSON.stringify({ error: 'Money is only for the owner.' }));
    return final('That is only for the owner.', [
      { type: 'navigate', view: 'client', id: 'acme', tab: 'money' },
      { type: 'navigate', view: 'activity' },
      { type: 'confirm', name: 'give_access', args: { id: 'acme' } },
      { type: 'confirm', name: 'set_my_status', args: { text: 'Calling Acme' } },
    ]);
  };
  const r = await ask('how much did we make?', EMP);
  assert.deepEqual(r.actions, [
    { type: 'navigate', view: 'client', id: 'acme' },
    { type: 'confirm', label: 'set my status', name: 'set_my_status', args: { text: 'Calling Acme' } },
  ]);
  // The owner gets them.
  assert.equal(cleanActions([{ type: 'confirm', name: 'give_access', args: { id: 'acme', email: 'x@y.com' } }], 'admin')[0].args.email, undefined);
  assert.equal(cleanActions([{ type: 'navigate', view: 'client', id: 'acme', tab: 'money' }], 'admin')[0].tab, 'money');
});

test('money_summary for the owner: totals and per-client paid amounts', async () => {
  await kv.hset(K.client('acme'), { name: 'Acme Plumbing', state: 'converted', plan: 'starter', contactName: 'Ann Lee', contactEmail: 'ann@acme.com', createdAt: '2026-09-01T00:00:00Z' });
  await kv.sadd(K.clients(), 'acme');
  await kv.hset(K.invoice('acme'), { number: 'AV-1', amount: 2497, issuedAt: new Date(clockMs - 86400e3).toISOString(), paidAt: new Date(clockMs - 3600e3).toISOString(), status: 'paid', plan: 'starter' });
  const m = await runTool('money_summary', {}, toolContext({ role: 'admin', now: () => new Date(clockMs) }));
  assert.equal(m.totals.receivedAllTime, 2497);
  assert.equal(m.totals.receivedThisMonth, 2497);
  assert.deepEqual(m.clients.map((c) => [c.name, c.amountUsd, c.status]), [['Acme Plumbing', 2497, 'paid']]);
  assert.ok(!JSON.stringify(m).includes('@') && !JSON.stringify(m).includes('Ann'));
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
  const denied = await post({ action: 'done', id: a.request.id }, 'employee');
  assert.equal(denied.status, 403);
  const done = await (await post({ action: 'done', id: a.request.id }, 'admin')).json();
  assert.equal(done.request.status, 'done');
  const list = await (await GET()).json();
  assert.deepEqual(list.requests.map((r) => [r.id, r.status]), [[a.request.id, 'done']]);
  assert.equal((await post({ action: 'done', id: 'nope' }, 'admin')).status, 404);
  for (let i = 0; i < 205; i++) await post({ action: 'add', text: `r${i}` }, 'admin');
  assert.equal((await (await GET()).json()).requests.length, 200);
});

test('middleware: team members may ask Ava and add requests; status is readable', () => {
  assert.equal(employeeMayAccess('POST', '/api/mc/ava/chat'), true);
  assert.equal(employeeMayAccess('POST', '/api/mc/ava/requests'), true);
  assert.equal(employeeMayAccess('GET', '/api/mc/ava/status'), true);
  assert.equal(employeeMayAccess('GET', '/api/mc/ava/requests'), true);
  assert.equal(employeeMayAccess('POST', '/api/mc/ava/status'), false);
  assert.equal(employeeMayAccess('POST', '/api/mc/keys'), false);
});

test('status route: brains with keys are ready; never a key in the answer', async () => {
  const { GET } = await import('@/app/api/mc/ava/status/route');
  const j = await (await GET()).json();
  assert.equal(j.ready, true);
  assert.deepEqual(j.brains.map((b) => [b.id, b.ready]), [['cerebras', true], ['groq', true], ['gemini', true], ['openrouter', true]]);
  assert.ok(!JSON.stringify(j).includes('test-'));
  for (const b of j.brains) assert.deepEqual(Object.keys(b).sort(), ['id', 'lastError', 'lastOkAt', 'model', 'name', 'ready']);
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
});
