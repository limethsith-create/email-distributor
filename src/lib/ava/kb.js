/**
 * Ava's grounding (docs/HUB-API.md "Ava (AI helper)"): BM25 over the written
 * guide (src/lib/ava/kb.md) cut into chunks, plus the owner's "Business
 * facts" note (lib/ava/facts.js). Each question gets the best 4–6 chunks
 * (≤ ~1,500 tokens) put into the prompt by itself — the brain does not have
 * to ask for them — with chunks about the page the user is on boosted.
 *
 * kb.md: every `## Title` is a section; an optional `<!-- pages: trials, client -->`
 * line under it names the hub views it is about. Long sections are cut into
 * pieces of about 180 words (each keeps its title).
 */

import fs from 'node:fs';
import path from 'node:path';

const STOP = new Set('a an the to of for in on at is are am be do does did i me my we our you your it its this that and or please can could would will should with about what how why when where who which there any some tell show give get let know need needs want as by from so if then than into up out one all has have had was were been ava'.split(' '));
const norm = (s) => String(s || '').toLowerCase().replace(/['’]s\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const stem = (w) => (w.length > 5 && w.endsWith('ing') ? w.slice(0, -3) : w.length > 4 && w.endsWith('ed') ? w.slice(0, -2) : w.length > 3 && w.endsWith('es') && !w.endsWith('ses') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const SYN = [[/\bhow much\b/g, 'price'], [/\bwarm ?up\b/g, 'warmup'], [/\bset ?up\b/g, 'setup'], [/\be ?mails?\b/g, 'email'], [/\bsign ?in\b/g, 'signin'], [/\blog ?in\b/g, 'signin'], [/\bpricing|prices?|costs?\b/g, 'price'], [/\bpaid|payment|pay\b/g, 'pay'], [/\bday ?30\b/g, 'day30'], [/\bday ?1\b/g, 'day1']];
export function tokens(s) {
  let t = norm(s);
  for (const [re, to] of SYN) t = t.replace(re, to);
  return t.split(' ').filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
}

const approxTokens = (s) => Math.ceil(String(s || '').length / 4);

/** kb.md text → chunks [{ id, title, text, pages: [views] }]. */
export function chunkGuide(text, { maxWords = 180 } = {}) {
  const out = [];
  const secs = String(text || '').split(/\n(?=## )/).filter((s) => s.startsWith('## '));
  for (const s of secs) {
    const [head, ...rest] = s.split('\n');
    const title = head.replace(/^##\s*/, '').trim();
    let body = rest.join('\n');
    const pages = [];
    body = body.replace(/<!--\s*pages?:\s*([^>]*?)\s*-->/gi, (_, list) => { for (const p of list.split(/[,\s]+/)) if (p) pages.push(p.trim().toLowerCase()); return ''; }).trim();
    const words = body.split(/\s+/).filter(Boolean);
    if (words.length <= maxWords * 1.3) { out.push({ id: `${out.length}`, title, text: body, pages }); continue; }
    // Cut on paragraph / sentence ends near maxWords.
    const sentences = body.split(/(?<=[.!?])\s+|\n{2,}/);
    let cur = [];
    let n = 0;
    for (const sen of sentences) {
      const w = sen.split(/\s+/).filter(Boolean).length;
      if (n + w > maxWords && cur.length) { out.push({ id: `${out.length}`, title, text: cur.join(' '), pages }); cur = []; n = 0; }
      cur.push(sen.trim()); n += w;
    }
    if (cur.length) out.push({ id: `${out.length}`, title, text: cur.join(' '), pages });
  }
  return out;
}

/** A BM25 index over chunks (title words count double). */
export function buildIndex(chunks, { k1 = 1.4, b = 0.75 } = {}) {
  const docs = chunks.map((c) => {
    const toks = [...tokens(c.title), ...tokens(c.title), ...tokens(c.text)];
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    return { c, tf, len: toks.length };
  });
  const N = docs.length || 1;
  const avg = docs.reduce((n, d) => n + d.len, 0) / N || 1;
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const idf = (t) => { const n = df.get(t) || 0; return Math.log(1 + (N - n + 0.5) / (n + 0.5)); };
  return {
    size: docs.length,
    /** → [{ chunk, score }] best first. `boostPages` = views to favour (×1.6). */
    search(query, { limit = 5, boostPages = [], boostTitles = [] } = {}) {
      const q = [...new Set(tokens(query))];
      if (!q.length) return [];
      const res = [];
      for (const d of docs) {
        let s = 0;
        for (const t of q) {
          const f = d.tf.get(t);
          if (!f) continue;
          s += idf(t) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avg)));
        }
        if (s <= 0) continue;
        if (boostPages.length && d.c.pages.some((p) => boostPages.includes(p))) s *= 1.6;
        if (boostTitles.length && boostTitles.includes(d.c.title)) s *= 1.3;
        res.push({ chunk: d.c, score: s });
      }
      return res.sort((a, b2) => b2.score - a.score).slice(0, limit);
    },
  };
}

let guideCache = null;
/** The guide's chunks (read once per instance). */
export function guideChunks() {
  if (guideCache) return guideCache;
  let text = '';
  try { text = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'ava', 'kb.md'), 'utf8'); } catch { text = ''; }
  guideCache = chunkGuide(text);
  return guideCache;
}
export const __resetGuide = () => { guideCache = null; };

/** The owner's facts note → chunks titled "Business facts" (paragraphs, ~120 words each). */
export function factChunks(facts) {
  const t = String(facts || '').trim();
  if (!t) return [];
  const paras = t.split(/\n{2,}|\n(?=[-*•] )/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  let cur = '';
  for (const p of paras) {
    if (cur && (cur + ' ' + p).split(/\s+/).length > 120) { out.push(cur); cur = p; } else cur = cur ? `${cur}\n${p}` : p;
  }
  if (cur) out.push(cur);
  return out.map((text, i) => ({ id: `facts-${i}`, title: 'Business facts (from the owner)', text, pages: [] }));
}

/**
 * The context for one question: the best chunks from the guide + facts,
 * within `maxTokens`. `page` = { view, tab } of the user (its chunks are
 * boosted). → [{ title, text, score }].
 */
export function retrieve(query, { page = {}, facts = '', limit = 6, maxTokens = 1500, minScore = 0.8 } = {}) {
  const chunks = [...guideChunks(), ...factChunks(facts)];
  const index = buildIndex(chunks);
  const boostPages = [page.view, page.tab, page.view === 'client' ? 'client' : null].filter(Boolean).map((v) => String(v).toLowerCase());
  const hits = index.search(query, { limit: limit + 4, boostPages, boostTitles: ['Business facts (from the owner)'] });
  const top = hits[0]?.score || 0;
  const out = [];
  let used = 0;
  for (const h of hits) {
    if (out.length >= limit) break;
    if (h.score < minScore || h.score < top * 0.25) continue;
    const t = approxTokens(h.chunk.title) + approxTokens(h.chunk.text) + 4;
    if (used + t > maxTokens) continue;
    used += t;
    out.push({ title: h.chunk.title, text: h.chunk.text, score: Math.round(h.score * 100) / 100 });
  }
  return out;
}
