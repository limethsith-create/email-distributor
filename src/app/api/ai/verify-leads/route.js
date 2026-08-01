/**
 * SCOUT — autonomous lead-verification & quality-scoring agent.
 *
 * Runs on Google Gemini (free tier), independent of Claude. For every new lead
 * it: (1) checks deliverability (MX records, via email-verify), (2) reads the
 * email type + company/industry, and (3) rates the lead 1-10 for how good a
 * prospect it is for a done-for-you cold-email offer. Scores are saved on each
 * lead so only the best (>= threshold) are ever sent.
 *
 * It runs over and over (pinged by the cron) and skips leads it has already
 * scored, so new leads coming in get picked up automatically.
 */

export const runtime = 'nodejs';

import { kv } from '@vercel/kv';
import { verifyEmail } from '@/lib/email-verify';

const LEADS_KEY = 'leads';
export const QUALITY_THRESHOLD = 9; // only leads scored 9-10 are used for sending

// ── free signal helpers (no external API) ──
const FREE_DOMAINS = ['gmail.com','yahoo.com','hotmail.com','outlook.com','live.com','aol.com','icloud.com','mail.com','protonmail.com','gmx.com','yandex.com','me.com','msn.com'];
const DISPOSABLE = ['mailinator.com','guerrillamail.com','10minutemail.com','tempmail.com','trashmail.com','yopmail.com','sharklasers.com'];
const ROLE_LOCALS = ['info','sales','admin','contact','support','hello','team','office','enquiries','enquiry','marketing','hr','careers','jobs','billing','accounts','help','service','mail','general','ask','connect'];

// ICP fit for a "we run cold email and book you sales calls" offer:
// businesses that sell to other businesses and want more clients score highest.
const HIGH_FIT = ['market','advertis','agency','agencies','consult','staffing','recruit','software','saas','it service','web ','web design','design','media','digital','pr ','public relation','b2b','coaching','training','solar','roofing','law','legal','account','financial','insurance','real estate','property','logistics','manufactur','wholesale','distributor'];
const LOW_FIT = ['nonprofit','charity','government','school','university','hospital','clinic','restaurant','cafe','retail','ecommerce','shop','store','personal'];

function emailType(email) {
  const [local = '', domain = ''] = (email || '').toLowerCase().split('@');
  if (DISPOSABLE.includes(domain)) return 'disposable';
  if (FREE_DOMAINS.includes(domain)) return 'free';
  if (ROLE_LOCALS.includes(local) || !/[a-z]/.test(local)) return 'role';
  if (local.includes('.') || local.length >= 3) return 'personal';
  return 'business';
}

function fitScore(company, industry) {
  const t = ((company || '') + ' ' + (industry || '')).toLowerCase();
  if (LOW_FIT.some((k) => t.includes(k)) && !HIGH_FIT.some((k) => t.includes(k))) return 4;
  if (HIGH_FIT.some((k) => t.includes(k))) return 9;
  return 6;
}

function ruleScore({ company, industry, email, mxValid }) {
  if (!mxValid) return { score: 1, reason: 'Domain has no mail server — email would bounce.' };
  const et = emailType(email);
  if (et === 'disposable') return { score: 1, reason: 'Disposable/temporary email domain.' };
  let s = fitScore(company, industry);
  let note = '';
  if (et === 'free') { s -= 3; note = 'personal free-mail address'; }
  else if (et === 'role') { s -= 2; note = 'role-based address (info@/sales@)'; }
  else if (et === 'personal') { s += 1; note = 'personal business email'; }
  s = Math.max(1, Math.min(10, s));
  const fitWord = s >= 9 ? 'strong' : s >= 6 ? 'moderate' : 'weak';
  return { score: s, reason: `${fitWord} fit${note ? ', ' + note : ''}, deliverable domain.` };
}

async function geminiScore({ company, industry, email, region, mxValid, etype }, key) {
  const prompt = `You are Scout, a lead-qualification agent for a done-for-you cold-email agency. The agency runs cold email for its clients and books them sales calls, guaranteed. The BEST prospects are B2B businesses that sell to other businesses and want more clients — agencies, consultancies, software/SaaS, staffing/recruiting, professional services, B2B service providers.

Rate this lead from 1 to 10 on how good a prospect it is (10 = ideal, buy-ready fit; 1 = poor fit or unreachable).

Lead:
- Company: ${company || 'unknown'}
- Industry: ${industry || 'unknown'}
- Email: ${email}
- Email type: ${etype}
- Region: ${region}
- Deliverable (valid mail server): ${mxValid ? 'yes' : 'no'}

Scoring guidance:
- If not deliverable, score 1-2.
- Personal business email (john@company.com) is best; role-based (info@, sales@) is weaker; free/personal domains (gmail) are weak.
- Strong ICP fit (B2B service businesses that want clients) scores high; consumer/retail/nonprofit/government score lower.
Return ONLY compact JSON: {"score": <1-10 integer>, "reason": "<max 12 words>"}.`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 120 } }),
  });
  if (!res.ok) throw new Error('gemini_http_' + res.status);
  const j = await res.json();
  const text = (j?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('gemini_no_json');
  const parsed = JSON.parse(m[0]);
  let score = parseInt(parsed.score);
  if (!(score >= 1 && score <= 10)) throw new Error('gemini_bad_score');
  return { score, reason: String(parsed.reason || '').slice(0, 90) };
}

function isUSA(lead) {
  const ind = (lead.industry || '').trim();
  return /^USA\s*-/i.test(ind) || /marketing & advertising/i.test(ind);
}

async function scoreOne(lead, key) {
  const email = lead.email || '';
  const company = lead.company_name || lead.company || '';
  const industry = lead.industry || '';
  const region = isUSA(lead) ? 'USA' : 'Other';
  let mxValid = true;
  try { const v = await verifyEmail(email); mxValid = !!v.valid; } catch { mxValid = true; }
  const etype = emailType(email);

  if (key) {
    try {
      const g = await geminiScore({ company, industry, email, region, mxValid, etype }, key);
      // deliverability hard cap
      const score = mxValid ? g.score : Math.min(g.score, 2);
      return { score, reason: g.reason, engine: 'gemini' };
    } catch (e) {
      const r = ruleScore({ company, industry, email, mxValid });
      return { ...r, engine: 'rules', note: String(e.message || e) };
    }
  }
  return { ...ruleScore({ company, industry, email, mxValid }), engine: 'rules' };
}

async function runBatch(limit, force) {
  const all = (await kv.hgetall(LEADS_KEY)) || {};
  const key = process.env.GEMINI_API_KEY;
  // candidates: real, not-yet-sent leads that are unscored (or force re-score)
  const candidates = Object.values(all).filter((l) => {
    const s = (l.status || '').toLowerCase();
    const sendable = (s === 'pending' || s === 'new') && !l.account_used && !l.sent_at;
    const needsScore = force || l.quality_score == null;
    return l.email && sendable && needsScore;
  }).slice(0, limit);

  const results = [];
  for (const lead of candidates) {
    const r = await scoreOne(lead, key);
    const existing = await kv.hget(LEADS_KEY, lead.email.toLowerCase());
    const updated = {
      ...existing,
      email: lead.email.toLowerCase(),
      quality_score: r.score,
      quality_reason: r.reason,
      quality_engine: r.engine,
      verified_at: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await kv.hset(LEADS_KEY, { [lead.email.toLowerCase()]: updated });
    results.push({ email: updated.email, company: existing?.company_name, score: r.score, reason: r.reason, engine: r.engine });
  }
  const qualified = results.filter((r) => r.score >= QUALITY_THRESHOLD).length;
  return { scored: results.length, qualified, threshold: QUALITY_THRESHOLD, hasKey: !!key, results };
}

async function status() {
  const all = (await kv.hgetall(LEADS_KEY)) || {};
  let scored = 0, qualified = 0, unscored = 0, pending = 0;
  for (const l of Object.values(all)) {
    const s = (l.status || '').toLowerCase();
    const sendable = (s === 'pending' || s === 'new') && !l.account_used && !l.sent_at;
    if (!sendable) continue;
    pending++;
    if (l.quality_score == null) unscored++;
    else { scored++; if (l.quality_score >= QUALITY_THRESHOLD) qualified++; }
  }
  return { name: 'Scout', threshold: QUALITY_THRESHOLD, hasKey: !!process.env.GEMINI_API_KEY, pending, scored, unscored, qualified };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  if (searchParams.get('run') === '1') {
    const limit = Math.min(parseInt(searchParams.get('limit') || '15', 10) || 15, 40);
    const force = searchParams.get('force') === '1';
    return Response.json(await runBatch(limit, force));
  }
  return Response.json(await status());
}

export async function POST(request) {
  let body = {};
  try { body = await request.json(); } catch {}
  const limit = Math.min(parseInt(body.limit || 15, 10) || 15, 40);
  const force = !!body.force;
  return Response.json(await runBatch(limit, force));
}
