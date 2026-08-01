// AI personalization agent — runs on Google Gemini (free tier), independent of Claude.
// Reads the CURRENT base offer (editable + saved in KV) and tailors it per company.
export const runtime = 'nodejs';

import { kv } from '@vercel/kv';

const DEFAULT_OFFER = {
  subject: '{{name}} — quick idea for {{company}}',
  body: `Hi {{name}},

Quick one. Most founders are great at the actual work — it's chasing new clients that quietly eats the week.

That's the part we take off your plate: we run cold email for {{company}} and book you sales calls on a plan that fits — 10, 20, even 50 a month. Inboxes, lists, copy, sending — all done for you. You just show up and close.

And it's fully guaranteed: if we don't hit your number, we refund every cent. No risk on your end at all.

Open to seeing how it'd work?

Best,
Limethsith`,
};

async function getOffer() {
  try {
    const saved = await kv.get('base_offer').catch(() => null);
    if (saved && saved.subject && saved.body) return saved;
  } catch {}
  return DEFAULT_OFFER;
}

function firstNameFromEmail(email = '') {
  const local = (email.split('@')[0] || '').split(/[._+\-0-9]/)[0] || '';
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : 'there';
}

function fill(t, name, company) {
  return t.replace(/\{\{\s*name\s*\}\}/g, name).replace(/\{\{\s*company\s*\}\}/g, company);
}

function nounFor(industry) {
  const ind = (industry || '').toLowerCase();
  if (ind.includes('market') || ind.includes('agenc') || ind.includes('advertis')) return 'agency owners';
  if (ind.includes('staff') || ind.includes('recruit')) return 'recruiters';
  if (ind.includes('msp') || ind.includes('it ') || ind.includes('software') || ind.includes('tech')) return 'tech founders';
  if (ind.includes('real estate') || ind.includes('construction')) return 'brokers';
  if (ind.includes('hotel') || ind.includes('travel') || ind.includes('restaurant') || ind.includes('cafe')) return 'owners';
  return 'founders';
}

function ruleFallback(offerBody, name, company, industry) {
  const body = offerBody.replace('Most founders', 'Most ' + nounFor(industry));
  return fill(body, name, company);
}

async function gemini(offerBody, name, company, industry, key) {
  const prompt = `You are a cold-email personalization agent for a done-for-you cold email agency.

BASE EMAIL:
"""
${offerBody}
"""

Tailor it to this company:
- Contact first name: ${name}
- Company: ${company}
- Industry / segment: ${industry || 'unknown'}

Rules:
- Rewrite ONLY the opening pain line and the "we run cold email for..." line so they feel specific to this company and its industry.
- KEEP the money-back guarantee sentence and the plan tiers (10, 20, even 50 a month).
- Use the real first name (${name}) and company (${company}); no {{tokens}} in the output.
- Keep it under 90 words, plain text, no links, warm and human.
- Do NOT invent facts about the company.
- Return ONLY the email body, nothing else.`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.75, maxOutputTokens: 400 } }),
  });
  if (!res.ok) throw new Error('gemini_http_' + res.status);
  const j = await res.json();
  const text = (j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts || []).map((p) => p.text || '').join('');
  if (!text.trim()) throw new Error('gemini_empty');
  return text.trim();
}

async function handle(lead) {
  const offer = await getOffer();
  const email = lead.email || '';
  const company = lead.company_name || lead.company || 'your company';
  const industry = lead.industry || '';
  const name = lead.name || firstNameFromEmail(email);
  const subject = fill(offer.subject, name, company);
  const key = process.env.GEMINI_API_KEY;
  if (key) {
    try {
      const out = await gemini(offer.body, name, company, industry, key);
      return { subject, body: out, engine: 'gemini', personalized: true };
    } catch (e) {
      return { subject, body: ruleFallback(offer.body, name, company, industry), engine: 'fallback', personalized: false, note: String((e && e.message) || e) };
    }
  }
  return { subject, body: ruleFallback(offer.body, name, company, industry), engine: 'base', personalized: false, note: 'No GEMINI_API_KEY set — add it in Vercel to activate the AI agent.' };
}

export async function POST(req) {
  let body = {};
  try { body = await req.json(); } catch (e) {}
  const lead = body.lead || body || {};
  const result = await handle(lead);
  return Response.json(result);
}

export async function GET() {
  return Response.json({ ok: true, hasKey: !!process.env.GEMINI_API_KEY });
}
