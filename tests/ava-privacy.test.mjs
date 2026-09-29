// Ava's tools never let personal data out (src/lib/ava/tools.js, search.js, kb.js): with the
// Test run loaded (three clients with real-looking prospects, replies,
// conversations, calls and invoices) plus a team member, every tool's output
// — and every request body the machine would send to an AI service — has no
// email address, no prospect name, no contact person's name, and, for a team
// member, no money.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import STATE from './fixtures/demo-state.json';
import { clock, et, installJourney, call } from './journey-world.mjs';
import { AVA_IO, __resetBrains } from '@/lib/ava/brains';
import { MODELS_IO, __resetModels } from '@/lib/ava/models';
import { avaChat, __resetAvaLimits } from '@/lib/ava/chat';
import { runTool, toolContext, TOOL_NAMES } from '@/lib/ava/tools';
import { SEARCH_IO } from '@/lib/ava/search';
import { setFacts } from '@/lib/ava/facts';

/** Every prospect's name (first, last, whole) and every client contact's name in the fixture. */
function namesInFixture() {
  const out = new Set();
  const add = (n) => { const s = String(n || '').trim(); if (!s) return; out.add(s); for (const p of s.split(/\s+/)) if (p.length >= 3) out.add(p); };
  for (const part of STATE.parts) {
    for (const [key, val] of Object.entries(part.keys)) {
      if (/^client:[^:]+$/.test(key)) add(val.v?.contactName);
      if (/^client:[^:]+:leads$/.test(key)) for (const lead of Object.values(val.v || {})) { const l = typeof lead === 'string' ? JSON.parse(lead) : lead; add(l.first_name); add(l.last_name); add(l.name); }
    }
  }
  // Names that are also ordinary words / our own labels would make the check meaningless.
  for (const w of ['Test', 'The', 'Owner']) out.delete(w);
  for (const n of ['Annabel Leeworth', 'Annabel', 'Leeworth']) out.add(n);
  return [...out];
}

function assertClean(label, text, names) {
  assert.ok(!text.includes('@'), `${label}: has an @ — ${text.slice(Math.max(0, text.indexOf('@') - 60), text.indexOf('@') + 40)}`);
  assert.ok(!/\b\d{3}[-. )]+\d{3}[-. ]\d{4}\b/.test(text), `${label}: has a phone number`);
  assert.ok(!/https?:\/\//.test(text), `${label}: has a link`);
  for (const n of names) assert.ok(!new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text), `${label}: has the name "${n}"`);
}

test('every tool, owner and team member, with the Test run loaded: no personal data; no money for the team', { timeout: 180_000 }, async () => {
  installJourney({ seed: 7 });
  process.env.ENC_KEY = process.env.ENC_KEY || Buffer.alloc(32, 7).toString('base64');
  clock.set(et('2026-12-09', '10:00'));
  const loaded = await call('api/mc/demo/route', 'POST', { path: '/api/mc/demo', body: { action: 'load' } });
  assert.equal(loaded.status, 200, JSON.stringify(loaded.json));
  // A real client too (the Test run's clients are left out of some views), and a team member who looks after it.
  await kv.hset(K.client('acme'), { name: 'Acme Plumbing', state: 'onboarding', plan: 'trial', contactName: 'Annabel Leeworth', contactEmail: 'annabel@acmeplumbing.example', createdAt: '2026-12-01T12:00:00Z' });
  await kv.sadd(K.clients(), 'acme');
  await kv.hset(K.hubPerson('emp-1'), { uid: 'emp-1', email: 'nimal@aviance.store', name: 'Nimal Perera', role: 'employee', lastSeen: clock.iso(), firstSeen: clock.iso() });
  await kv.sadd(K.hubPeople(), 'emp-1').catch(async () => kv.zadd(K.hubPeople(), { member: 'emp-1', score: Date.now() }));
  await kv.hset(K.hubStatus('emp-1'), { text: 'Checking Summit Roofing replies — reach me at nimal@aviance.store', at: clock.iso() });
  await kv.hset(K.hubClientOwners(), { acme: JSON.stringify(['emp-1']) });

  const names = namesInFixture();
  assert.ok(names.length > 50, `prospect names found: ${names.length}`);
  assert.ok(names.includes('Megan') && names.includes('Alan'), 'the check knows the contact and prospect names');

  // Web search: Tavily (mocked) — what goes out is recorded and checked too.
  process.env.TAVILY_API_KEY = 'tvly-test';
  const searches = [];
  SEARCH_IO.fetch = async (url, init) => {
    searches.push(init.body);
    return Response.json({ answer: 'Cold email rules: add a postal address.', results: [{ title: 'CAN-SPAM guide', url: 'https://www.ftc.gov/x', content: 'Write to help@ftc.example or call 202-555-0199.' }] });
  };
  const args = {
    search_hub: { query: 'summit roofing calls team' },
    get_client: { name: 'summit roofing' },
    list_clients: { filter: 'all' },
    get_numbers: { scope: 'all_clients' },
    get_calendar: { from: new Date(Date.now() - 70 * 86400e3).toISOString(), to: new Date(Date.now() + 14 * 86400e3).toISOString() },
    web_search: { query: 'CAN-SPAM rules for Megan and Alan at alan@lighthouseplastics.example 704-555-0101' },
    propose_action: { name: 'draft', args: { title: 'Note', text: 'Thanks for the call today.' } },
  };
  const extra = [['get_numbers', { scope: 'my_outreach' }], ['get_numbers', { scope: 'money' }], ['list_clients', { filter: 'needs_you' }], ['search_hub', { query: 'give access to the client page' }], ['search_hub', { query: 'Megan' }]];
  const outputs = {};
  for (const role of ['admin', 'employee']) {
    const ctx = toolContext({ role });
    for (const [name, a] of [...TOOL_NAMES.map((n) => [n, args[n]]), ...extra]) {
      const out = await runTool(name, a, ctx);
      const text = JSON.stringify(out);
      outputs[`${role}:${name}:${JSON.stringify(a).slice(0, 40)}`] = out;
      outputs[`${role}:${name}`] ||= out;
      assertClean(`${role} ${name} ${JSON.stringify(a).slice(0, 40)}`, text, names);
      if (role === 'employee') {
        assert.ok(!/amountUsd|receivedAllTime|priceUsdPerMonth|2,?497|3,?997|8,?497/.test(text), `employee ${name}: money`);
      }
    }
    for (const other of ['Harbor', 'Lakeview']) {
      const o = await runTool('get_client', { name: other }, ctx);
      assert.equal(o.found, true, other);
      assertClean(`${role} get_client ${other}`, JSON.stringify(o), names);
      if (role === 'employee') assert.equal(o.money, undefined);
    }
  }
  assert.ok(searches.length >= 2);
  for (const b of searches) assertClean('web search request', b, names);
  // The tools really say something useful.
  const hub = outputs['admin:list_clients'];
  assert.ok(hub.totalClients >= 3);
  assert.ok(hub.clients.some((c) => c.name === 'Summit Roofing Co' && c.testRun));
  const summit = outputs['admin:get_client'];
  assert.equal(summit.name, 'Summit Roofing Co');
  assert.ok(summit.emails.sent > 0 && summit.emails.replies > 0, JSON.stringify(summit.emails));
  assert.ok(Object.keys(summit.replyTypes).length > 0);
  assert.ok(summit.calls.total > 0, JSON.stringify(summit.calls));
  assert.ok(outputs['admin:get_calendar'].meetings.some((m) => /Harbor|Summit|Lakeview/.test(m.company || '')));
  const found = outputs['admin:search_hub'];
  assert.equal(found.clients[0].name, 'Summit Roofing Co');
  const team = found.team.find((p) => p.firstName === 'Nimal');
  assert.deepEqual(team.looksAfter, ['Acme Plumbing']);
  assert.match(team.status, /\[email\]/);
  assert.equal(outputs['admin:web_search'].via, 'tavily');
  assert.equal(outputs['admin:propose_action'].action.type, 'draft');
  const money = Object.entries(outputs).find(([k]) => k.startsWith('admin:get_numbers:{"scope":"money"'))[1];
  assert.ok(money.clients.some((c) => c.name === 'Summit Roofing Co' && c.amountUsd === 3997));
  assert.equal(Object.entries(outputs).find(([k]) => k.startsWith('employee:get_numbers:{"scope":"money"'))[1].error, 'Money is only for the owner.');
  assert.match(Object.entries(outputs).find(([k]) => k.startsWith('admin:search_hub:{"query":"give access'))[1].guide[0].title, /access/i);

  // The owner's facts (with an address and a phone in them) never reach the AI service as they are.
  await setFacts('Office line 704-555-0188, write to owner@aviance.example. Megan from Summit likes short emails.');

  // Through the chat: everything the machine sends to the AI service is clean too (apart from what the user typed).
  __resetBrains(); __resetAvaLimits(); __resetModels();
  process.env.GROQ_API_KEY = 'test-groq';
  const sent = [];
  const net = async (url, init = {}) => {
    if ((init.method || 'GET') === 'GET') return Response.json({ data: [{ id: 'openai/gpt-oss-120b' }] });
    const body = JSON.parse(init.body);
    sent.push(init.body);
    const n = sent.length;
    const order = [['list_clients', args.list_clients], ['get_client', args.get_client], ['search_hub', { query: 'what does Megan think about the office line' }]];
    if (n <= 3) return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `c${n}`, type: 'function', function: { name: order[n - 1][0], arguments: JSON.stringify(order[n - 1][1]) } }] } }] });
    assert.equal(body.messages.filter((m) => m.role === 'tool').length, 4, 'the look-up done before the first call (get_client for Summit) + 3');
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'All good.' } }] });
  };
  AVA_IO.fetch = net; MODELS_IO.fetch = net;
  const r = await avaChat({ messages: [{ role: 'user', content: 'How is Summit doing? What are the office hours and the office line?' }], page: { view: 'client', clientId: 'demo-summit-roofing', tab: 'overview' } }, { id: 'o', name: 'Limeth', role: 'admin' });
  assert.equal(r.reply, 'All good.');
  assert.equal(sent.length, 4);
  for (const [i, s] of sent.entries()) {
    // The user's own words are theirs; everything else must be clean.
    const b = JSON.parse(s);
    const machineText = JSON.stringify({ system: b.messages[0], rest: b.messages.slice(1).filter((m) => m.role !== 'user') });
    assertClean(`request ${i + 1} to the AI service`, machineText, names);
  }
  assert.match(JSON.parse(sent[0]).messages[0].content, /Business facts \(from the owner\)[\s\S]*\[phone\][\s\S]*\[email\]/);
  delete process.env.TAVILY_API_KEY;
});
