#!/usr/bin/env node
/**
 * Ava's quality check (not part of `npm test`): asks the live machine every
 * question in tests/ava-eval.json and prints the answers, the brain and model
 * that answered, the buttons offered, the follow-ups and the time — for the
 * owner (or a developer) to read after a change.
 *
 *   AVA_URL=https://email-distributor.vercel.app \
 *   AVA_TOKEN=<a hub sign-in token (Supabase access token)> \
 *   node scripts/ava-eval.mjs [--only how,web] [--ids how-1,web-1] [--stream] [--page trials] [--out answers.json]
 *
 *   AVA_COOKIE='<the mc session cookie>' works instead of AVA_TOKEN.
 *   --only    question kinds by prefix of the id (how, num, web, gen, write, act, cal, team, needs, voice)
 *   --stream  use the streaming answer (SSE) and show the time to the first words
 *   --out     also write every answer as JSON
 * Each question is asked on its own (no history), one at a time, with a
 * short pause so the free rate limits hold.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : null; };

const BASE = String(process.env.AVA_URL || 'https://email-distributor.vercel.app').replace(/\/+$/, '');
const TOKEN = process.env.AVA_TOKEN || '';
const COOKIE = process.env.AVA_COOKIE || '';
if (!TOKEN && !COOKIE) {
  console.error('Set AVA_TOKEN (a hub sign-in token) or AVA_COOKIE (the Mission Control session cookie).');
  process.exit(2);
}
const set = JSON.parse(fs.readFileSync(path.join(here, '..', 'tests', 'ava-eval.json'), 'utf8'));
let qs = set.questions;
if (opt('only')) { const kinds = String(opt('only')).split(','); qs = qs.filter((q) => kinds.some((k) => q.id.startsWith(`${k}-`))); }
if (opt('ids')) { const ids = String(opt('ids')).split(','); qs = qs.filter((q) => ids.includes(q.id)); }
const streaming = Boolean(opt('stream'));
const page = { view: typeof opt('page') === 'string' ? opt('page') : 'trials' };
const headers = { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}), ...(COOKIE ? { cookie: COOKIE } : {}), ...(streaming ? { accept: 'text/event-stream' } : {}) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function askOne(q) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/mc/ava/chat${streaming ? '?stream=1' : ''}`, { method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'user', content: q.q }], page, ...(q.voice ? { voice: true } : {}) }) });
  if (!streaming) {
    const j = await res.json().catch(() => ({}));
    return { status: res.status, ms: Date.now() - t0, ...j };
  }
  const out = { status: res.status, reply: '', actions: [], suggestions: [], firstMs: null };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = /^event: (\w+)/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!ev || !data) continue;
      const d = JSON.parse(data);
      if (ev === 'delta') { if (out.firstMs == null) out.firstMs = Date.now() - t0; out.reply += d.text; }
      if (ev === 'actions') { out.actions = d.actions; out.suggestions = d.suggestions; }
      if (ev === 'done') Object.assign(out, d);
      if (ev === 'error') Object.assign(out, d);
    }
  }
  out.ms = Date.now() - t0;
  return out;
}

const results = [];
console.log(`Ava eval — ${qs.length} questions → ${BASE}${streaming ? ' (streaming)' : ''}\n`);
for (const q of qs) {
  let r;
  try { r = await askOne(q); } catch (err) { r = { error: String(err?.message || err) }; }
  results.push({ id: q.id, kind: q.kind, q: q.q, expect: q.expect, ...r });
  console.log(`━━ ${q.id} (${q.kind}) ━━ ${q.q}`);
  if (r.error) console.log(`  ✗ ${r.status || ''} ${r.error}`);
  else {
    console.log(`  ${String(r.reply || '').replace(/\n/g, '\n  ')}`);
    if (r.actions?.length) console.log(`  buttons: ${r.actions.map((a) => a.type === 'navigate' ? `→ ${a.view}${a.tab ? `/${a.tab}` : ''}` : a.type === 'draft' ? `draft "${a.title}"` : `[${a.label}]`).join('  ')}`);
    if (r.suggestions?.length) console.log(`  follow-ups: ${r.suggestions.join(' | ')}`);
    console.log(`  — ${r.brain || '?'} · ${r.model || '?'} · ${r.ms} ms${r.firstMs != null ? ` (first words ${r.firstMs} ms)` : ''}${r.tried?.length > 1 ? ` · tried ${r.tried.map((t) => `${t.brain}:${t.ok ? 'ok' : t.error}`).join(', ')}` : ''}`);
  }
  console.log(`  expect: ${q.expect}\n`);
  await sleep(2500);
}
const failed = results.filter((r) => r.error || !r.reply).length;
console.log(`Done: ${results.length - failed} answered, ${failed} failed.`);
if (opt('out')) { fs.writeFileSync(String(opt('out')), JSON.stringify(results, null, 2)); console.log(`Wrote ${opt('out')}`); }
