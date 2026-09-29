// Ava's tools never let personal data out (src/lib/ava/tools.js): with the
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
import { avaChat, __resetAvaLimits } from '@/lib/ava/chat';
import { runTool, toolContext, TOOL_NAMES } from '@/lib/ava/tools';

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

  const args = {
    hub_summary: {}, client_overview: { name: 'summit roofing' }, calendar_summary: { from: new Date(Date.now() - 70 * 86400e3).toISOString(), to: new Date(Date.now() + 14 * 86400e3).toISOString() },
    team_summary: {}, my_outreach: {}, money_summary: {}, search_kb: { query: 'give access to the client page' },
  };
  const outputs = {};
  for (const role of ['admin', 'employee']) {
    const ctx = toolContext({ role });
    for (const name of TOOL_NAMES) {
      const out = await runTool(name, args[name], ctx);
      const text = JSON.stringify(out);
      outputs[`${role}:${name}`] = out;
      assertClean(`${role} ${name}`, text, names);
      if (role === 'employee') {
        assert.ok(!/amountUsd|receivedAllTime|2,?497|3,?997|8,?497/.test(text), `employee ${name}: money`);
      }
    }
    for (const other of ['Harbor', 'Lakeview']) {
      const o = await runTool('client_overview', { name: other }, ctx);
      assert.equal(o.found, true, other);
      assertClean(`${role} client_overview ${other}`, JSON.stringify(o), names);
    }
  }
  // The tools really say something useful.
  const hub = outputs['admin:hub_summary'];
  assert.ok(hub.totalClients >= 3);
  assert.ok(hub.stages.some((s) => s.clients.some((c) => c.name === 'Summit Roofing Co' && c.testRun)));
  const summit = outputs['admin:client_overview'];
  assert.equal(summit.name, 'Summit Roofing Co');
  assert.ok(summit.numbers.sent > 0 && summit.numbers.replies > 0, JSON.stringify(summit.numbers));
  assert.ok(Object.keys(summit.replyTypes).length > 0);
  assert.ok(outputs['admin:calendar_summary'].meetings.some((m) => /Harbor|Summit|Lakeview/.test(m.company || '')));
  const team = outputs['admin:team_summary'].team.find((p) => p.firstName === 'Nimal');
  assert.deepEqual(team.looksAfter, ['Acme Plumbing']);
  assert.match(team.status, /\[email\]/);
  assert.equal(outputs['employee:money_summary'].error, 'Money is only for the owner.');
  assert.ok(outputs['admin:money_summary'].clients.some((c) => c.name === 'Summit Roofing Co' && c.amountUsd === 3997));
  assert.match(outputs['admin:search_kb'].results[0].title, /access/i);

  // Through the chat: everything the machine sends to the AI service is clean too (apart from what the user typed).
  __resetBrains(); __resetAvaLimits();
  process.env.GROQ_API_KEY = 'test-groq';
  const sent = [];
  AVA_IO.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(init.body);
    const n = sent.length;
    const order = ['hub_summary', 'client_overview', 'calendar_summary'];
    if (n <= 3) return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `c${n}`, type: 'function', function: { name: order[n - 1], arguments: JSON.stringify(args[order[n - 1]]) } }] } }] });
    assert.equal(body.messages.filter((m) => m.role === 'tool').length, 3);
    return Response.json({ choices: [{ message: { role: 'assistant', content: '{"reply":"All good.","actions":[]}' } }] });
  };
  const r = await avaChat({ messages: [{ role: 'user', content: 'How is Summit doing?' }], page: { view: 'client', clientId: 'demo-summit-roofing', tab: 'overview' } }, { id: 'o', name: 'Limeth', role: 'admin' });
  assert.equal(r.reply, 'All good.');
  assert.equal(sent.length, 4);
  for (const [i, s] of sent.entries()) assertClean(`request ${i + 1} to the AI service`, s, names);
});
