/**
 * SCOUT — autonomous lead-verification & quality-scoring agent.
 *
 * Scores every lead 1-10 against Aviance's Ideal Customer Profile (below),
 * on its own, on Google Gemini (free) or a rule-based fallback — no Claude.
 * Only leads at/above the threshold are ever sent. Deliverability is checked
 * first (MX); undeliverable = 1 (would bounce).
 */

export const runtime = 'nodejs';
export const maxDuration = 300;

import { kv } from '@vercel/kv';
import { verifyEmail } from '@/lib/email-verify';

const LEADS_KEY = 'leads';
export const QUALITY_THRESHOLD = 9;

// ─────────────────────────────────────────────────────────────
// IDEAL CUSTOMER PROFILE — the "perfect customer" Scout scores against.
// ─────────────────────────────────────────────────────────────
export const ICP = {
  title: 'US agency owner who needs a steady flow of booked calls',
  summary: 'A US-based founder or owner of a small-to-mid B2B service business — especially marketing, advertising, creative, digital, PR, branding and design agencies — that sells to other businesses, leans on referrals for new clients, and wants a predictable pipeline of booked sales calls.',
  greenFlags: [
    'Decision-maker: Founder, Co-Founder, Owner, CEO, President, Principal, Managing Partner',
    'Marketing / advertising / creative / digital / PR / branding / design agency (or close B2B service)',
    'Small-to-mid, lean team — big enough to afford it, small enough that the owner still owns growth',
    'Based in the United States',
    'Reachable at a real, deliverable, personal business email',
  ],
  redFlags: [
    'Employees who cannot buy (VP, manager, coordinator, associate, analyst, etc.)',
    'Huge enterprises with in-house marketing teams',
    'Off-fit industries: healthcare, retail, restaurants, finance/banking at big firms, government, education, non-profits',
    'Role-based (info@/sales@), free (gmail), or undeliverable email addresses',
  ],
};

// ─── ICP scoring signals ───
const DECISION_RE = /\b(founder|co-?founder|owner|chief executive|ceo|principal|managing partner|managing director|proprietor|president)\b/i;
const VICE_RE = /vice\s*president|\bvp\b|\bsvp\b|\bevp\b/i;
const EMPLOYEE_RE = /\b(assistant|associate|coordinator|analyst|specialist|manager|representative|advisor|agent|realtor|registered|pharmacist|physician|engineer|clerk|staff|intern|attorney|account executive|sales rep|technician|nurse|rn|pastor|teacher|professor|retired|worker|designer|developer|supervisor|director)\b/i;
const NAME_AGENCY_RE = /\b(agency|agencies|media|marketing|creative|design|studio|communications|branding|advertis\w*|productions|promotions|digital|pr|seo|public relations?)\b/i;
const IND_MKT_RE = /\b(marketing|advertising)\b/i;
const B2B_RE = /\b(consult\w*|software|saas|staffing|recruit\w*|it services|coaching)\b/i;
const BAD_RE = /\b(financial|bank\w*|insurance|hospital|health\w*|pharma\w*|religio\w*|church|government|universit\w*|school|construction|manufactur\w*|automotive|real estate|law|legal|retail|restaurant|nonprofit|non-profit)\b/i;
const DISPOSABLE = new Set(['mailinator.com','guerrillamail.com','10minutemail.com','tempmail.com','trashmail.com','yopmail.com','sharklasers.com']);
const FREE = new Set(['gmail.com','yahoo.com','hotmail.com','outlook.com','live.com','aol.com','icloud.com','mail.com','protonmail.com','gmx.com','yandex.com','me.com','msn.com']);
const ROLE = new Set(['info','sales','admin','contact','support','hello','team','office','enquiries','enquiry','marketing','hr','careers','jobs','billing','accounts','help','service','mail','general','ask','connect']);

function emailType(email) {
  const [local = '', dom = ''] = (email || '').toLowerCase().split('@');
  if (DISPOSABLE.has(dom)) return 'disposable';
  if (FREE.has(dom)) return 'free';
  if (ROLE.has(local) || !/[a-z]/.test(local)) return 'role';
  if (local.includes('.') || local.length >= 3) return 'personal';
  return 'business';
}
function titlerank(t) {
  t = t || '';
  if (VICE_RE.test(t) || (EMPLOYEE_RE.test(t) && !DECISION_RE.test(t))) return 'employee';
  if (DECISION_RE.test(t)) return 'decision';
  return 'other';
}
function primaryMkt(ind) {
  const first = String(ind || '').replace('USA - ', '').split(',')[0].trim().toLowerCase();
  return first.includes('marketing') || first.includes('advertis');
}
function icpRuleScore({ company, industry, title, etype, mx }) {
  if (!mx) return { score: 1, reason: 'Domain has no mail server — would bounce.' };
  if (etype === 'disposable') return { score: 1, reason: 'Disposable/temporary email domain.' };
  const comp = company || '', ind = industry || '', both = comp + ' ' + ind;
  const tr = titlerank(title);
  const nameAg = NAME_AGENCY_RE.test(comp);
  const indMkt = IND_MKT_RE.test(ind);
  const bad = BAD_RE.test(both) && !nameAg;
  const svc = B2B_RE.test(both);
  const strong = nameAg || primaryMkt(ind) || (indMkt && tr === 'decision');
  let s = 5; const notes = [];
  if (strong) { s += 3; notes.push('agency/marketing fit'); }
  else if (bad) { s -= 3; notes.push('off-ICP industry'); }
  else if (svc || indMkt) { s += 1; notes.push('B2B service fit'); }
  if (tr === 'decision') { s += 2; notes.push('decision-maker'); }
  else if (tr === 'employee') { s -= 3; notes.push('not a decision-maker'); }
  if (etype === 'free') { s -= 3; notes.push('free-mail'); }
  else if (etype === 'role') { s -= 2; notes.push('role-based email'); }
  else if (etype === 'personal') s += 1;
  if (bad) s = Math.min(s, 5);
  s = Math.max(2, Math.min(10, s));
  return { score: s, reason: (notes.join('; ') || 'neutral') + '.' };
}

let WORKING_MODEL = null;
const GEMINI_MODELS = ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-flash-latest', 'gemini-1.5-flash'];

async function geminiScore({ company, industry, title, region, etype, mx }, key) {
  const prompt = `You are Scout, a lead-qualification agent for Aviance, a done-for-you cold-email agency that books guaranteed sales calls for clients.

IDEAL CUSTOMER PROFILE (score high only if it matches):
${ICP.summary}
GREEN FLAGS: ${ICP.greenFlags.join(' | ')}
RED FLAGS (score low): ${ICP.redFlags.join(' | ')}

Rate this lead 1-10 (10 = perfect ICP match, buy-ready; 1 = poor fit or unreachable):
- Company: ${company || 'unknown'}
- Industry: ${industry || 'unknown'}
- Title: ${title || 'unknown'}
- Region: ${region}
- Email type: ${etype}
- Deliverable: ${mx ? 'yes' : 'no'}
If not deliverable, score 1. Employees who can't buy and off-fit industries score low. Return ONLY JSON: {"score": <1-10 int>, "reason": "<max 12 words>"}.`;
  const body = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 120 } });
  const models = WORKING_MODEL ? [WORKING_MODEL, ...GEMINI_MODELS.filter((mm) => mm !== WORKING_MODEL)] : GEMINI_MODELS;
  let lastStatus = 0;
  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (res.ok) {
      WORKING_MODEL = model;
      const j = await res.json();
      const text = (j?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('gemini_no_json');
      const p = JSON.parse(m[0]); let score = parseInt(p.score);
      if (!(score >= 1 && score <= 10)) throw new Error('gemini_bad_score');
      return { score, reason: String(p.reason || '').slice(0, 90) };
    }
    lastStatus = res.status;
    if (res.status !== 404) throw new Error('gemini_http_' + res.status);
  }
  throw new Error('gemini_http_' + lastStatus + '_all_models');
}

function isUSA(l) {
  const ind = (l.industry || '').trim();
  if (/^USA\s*-/i.test(ind) || /marketing & advertising/i.test(ind)) return true;
  return /united states/i.test(l.country || '');
}

async function scoreOne(lead, key) {
  const email = lead.email || '';
  const company = lead.company_name || lead.company || '';
  const industry = lead.industry || '';
  const title = lead.title || '';
  const region = isUSA(lead) ? 'USA' : 'Other';
  let mx = true;
  try { const v = await verifyEmail(email); mx = !!v.valid; } catch { mx = true; }
  const etype = emailType(email);
  if (key && mx && etype !== 'disposable') {
    try {
      const g = await geminiScore({ company, industry, title, region, etype, mx }, key);
      return { score: g.score, reason: g.reason, engine: 'icp-gemini' };
    } catch (e) {
      return { ...icpRuleScore({ company, industry, title, etype, mx }), engine: 'icp-rules', note: String(e.message || e) };
    }
  }
  return { ...icpRuleScore({ company, industry, title, etype, mx }), engine: 'icp-rules' };
}

function needsScore(l, force) {
  if (force) return true;
  if (l.quality_score == null) return true;
  return !String(l.quality_engine || '').startsWith('icp'); // re-score legacy (non-ICP) ratings
}

async function runBatch(limit, force) {
  const all = (await kv.hgetall(LEADS_KEY)) || {};
  const key = process.env.GEMINI_API_KEY;
  const candidates = Object.values(all).filter((l) => {
    const s = (l.status || '').toLowerCase();
    const sendable = (s === 'pending' || s === 'new') && !l.account_used && !l.sent_at && l.email;
    return sendable && needsScore(l, force);
  }).slice(0, limit);
  const results = [];
  for (const lead of candidates) {
    const r = await scoreOne(lead, key);
    const existing = await kv.hget(LEADS_KEY, lead.email.toLowerCase());
    await kv.hset(LEADS_KEY, { [lead.email.toLowerCase()]: {
      ...existing, email: lead.email.toLowerCase(),
      quality_score: r.score, quality_reason: r.reason, quality_engine: r.engine,
      verified_at: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } });
    results.push({ email: lead.email.toLowerCase(), company: existing?.company_name, score: r.score, reason: r.reason, engine: r.engine, note: r.note || null });
  }
  const qualified = results.filter((r) => r.score >= QUALITY_THRESHOLD).length;
  return { scored: results.length, qualified, threshold: QUALITY_THRESHOLD, hasKey: !!key, results };
}

async function status() {
  const all = (await kv.hgetall(LEADS_KEY)) || {};
  let scored = 0, qualified = 0, unscored = 0, pending = 0;
  for (const l of Object.values(all)) {
    const s = (l.status || '').toLowerCase();
    if (!((s === 'pending' || s === 'new') && !l.account_used && !l.sent_at)) continue;
    pending++;
    if (l.quality_score == null) unscored++;
    else { scored++; if (l.quality_score >= QUALITY_THRESHOLD) qualified++; }
  }
  return { name: 'Scout', threshold: QUALITY_THRESHOLD, hasKey: !!process.env.GEMINI_API_KEY, icp: ICP, pending, scored, unscored, qualified };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  if (searchParams.get('run') === '1') {
    const limit = Math.min(parseInt(searchParams.get('limit') || '15', 10) || 15, 50);
    return Response.json(await runBatch(limit, searchParams.get('force') === '1'));
  }
  return Response.json(await status());
}
export async function POST(request) {
  let body = {};
  try { body = await request.json(); } catch {}
  const limit = Math.min(parseInt(body.limit || 15, 10) || 15, 50);
  return Response.json(await runBatch(limit, !!body.force));
}
