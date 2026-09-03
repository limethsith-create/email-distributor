/**
 * Lead Qualification & Scoring Engine
 * Rule-based scoring — $0 cost, no AI needed.
 *
 * Industries are scored 0-10 in line with `isTargetIndustry` (lib/metrics):
 * target verticals (the B2B service sellers who live on booked calls) score
 * 8-10, everything else scores 6 or below so it can never pass the send gate
 * (SEND_SCORE_THRESHOLD). Email hygiene uses the shared role / free-mail
 * predicates so every importer agrees on what a usable address is.
 */

import { isValidEmail, isRoleEmail, isFreeMailDomain, isTargetIndustry, normalizeEmail } from '@/lib/metrics';

// Ordered: the first key found in the raw industry string wins, so the more
// specific labels come before the broad ones.
const TARGET_SCORES = [
  ['lead gen', 9], ['outbound', 9], ['advertising', 10], ['marketing', 10], ['agency', 10],
  ['professional services', 9], ['consulting', 9], ['consultancy', 9], ['saas', 9], ['software', 9],
  ['managed services', 8], ['msp', 8], ['it services', 8], ['technology', 8], ['fintech', 8],
  ['financial', 8], ['finance', 8], ['logistics', 8], ['revenue', 8], ['growth', 8], ['b2b', 8],
];

const OTHER_SCORES = [
  ['staffing', 6], ['recruiting', 6], ['insurance', 5], ['legal', 5], ['law', 5], ['manufacturing', 5],
  ['real estate', 4], ['property', 4], ['construction', 4], ['retail', 3], ['hotel', 3], ['hospitality', 3],
  ['restaurant', 3], ['food', 3], ['healthcare', 3], ['hospital', 3], ['clinic', 3], ['education', 3],
  ['school', 3], ['government', 1],
];

const TARGET_DEFAULT = 8;   // a target industry we have no finer score for
const OTHER_DEFAULT = 5;    // an unknown / off-target industry
const MAX_OTHER = 6;        // off-target can never reach the send gate

// Government / military / example domains are never prospects.
const EXCLUDE_EMAIL_RE = /(\.gov(\.[a-z]{2})?$|\.mil$|@(example|test)\.(com|org|net)$)/i;
const EXCLUDE_COMPANY_RE = /\b(government|ministry|municipal|police|army|navy)\b/i;

const HONORIFIC_RE = /^(dr|mr|mrs|ms|miss|mx|prof|professor|sir|madam|rev|hon)\.?$/i;

/**
 * Normalize industry string to a scoring category
 */
function normalizeIndustry(raw) {
  if (!raw) return 'other';
  const lower = String(raw).toLowerCase().trim();
  const table = isTargetIndustry({ industry: lower }) ? TARGET_SCORES : OTHER_SCORES;
  for (const [key] of table) {
    if (lower.includes(key)) return key;
  }
  return isTargetIndustry({ industry: lower }) ? 'b2b' : 'other';
}

/**
 * Score for an industry (raw string or category). Target verticals score
 * 8-10, everything else at most 6.
 */
function getIndustryScore(industry) {
  const lower = String(industry || '').toLowerCase().trim();
  if (!lower) return OTHER_DEFAULT;
  if (isTargetIndustry({ industry: lower })) {
    const hit = TARGET_SCORES.find(([key]) => lower.includes(key));
    return hit ? hit[1] : TARGET_DEFAULT;
  }
  const hit = OTHER_SCORES.find(([key]) => lower.includes(key));
  return Math.min(MAX_OTHER, hit ? hit[1] : OTHER_DEFAULT);
}

/**
 * A usable prospect address: well-formed, on a company domain, not a shared inbox.
 */
function isUsableEmail(email) {
  if (!email || typeof email !== 'string') return false;
  if (!isValidEmail(email)) return false;
  if (isFreeMailDomain(email)) return false;
  if (isRoleEmail(email)) return false;
  return true;
}

/**
 * Clean company name for display
 */
function cleanCompanyName(name) {
  if (!name) return '';
  return String(name)
    .replace(/\s*(Pvt\.?\s*Ltd\.?|Ltd\.?|LLC|L\.L\.C\.|PLC|Inc\.?|Corp\.?|Co\.?\s*Ltd\.?|Private\s+Limited|Limited)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract first name from a contact name, skipping honorifics
 * ("Dr. John Smith" → "John").
 */
function extractFirstName(contactName) {
  if (!contactName) return null;
  const tokens = String(contactName).trim().split(/[\s,]+/).filter(Boolean);
  while (tokens.length && HONORIFIC_RE.test(tokens[0])) tokens.shift();
  const first = (tokens[0] || '').replace(/^[^\p{L}]+|[^\p{L}'’-]+$/gu, '');
  return first || null;
}

/**
 * Check if a company should be excluded
 */
function shouldExclude(lead) {
  const name = String(lead.company_name || lead.company || '');
  const email = normalizeEmail(lead.email);
  if (EXCLUDE_COMPANY_RE.test(name)) return true;
  if (EXCLUDE_EMAIL_RE.test(email)) return true;
  return false;
}

/**
 * Qualify and score a batch of leads
 * @param {Array} leads - Raw scraped leads
 * @param {object} options
 * @param {number} options.minScore - Minimum AI score to qualify (default 7)
 * @param {number} options.maxLeads - Max leads to return (default: all of them)
 * @returns {Array} Qualified leads sorted by score (highest first)
 */
export function qualifyLeads(leads, options = {}) {
  const list = Array.isArray(leads) ? leads : [];
  const { minScore = 7, maxLeads = list.length } = options;
  const qualified = [];

  for (const lead of list) {
    if (!lead || typeof lead !== 'object') continue;

    // Skip unusable emails (malformed, free-mail, shared inboxes)
    if (!isUsableEmail(lead.email)) continue;

    // Skip excluded companies
    if (shouldExclude(lead)) continue;

    // Normalize and score
    const rawIndustry = String(lead.industry || '').trim();
    const industry = normalizeIndustry(rawIndustry);
    const aiScore = getIndustryScore(rawIndustry || industry);

    // Only keep high-potential leads
    if (aiScore < minScore) continue;

    qualified.push({
      ...lead,
      company_name: cleanCompanyName(lead.company_name || lead.company),
      email: normalizeEmail(lead.email),
      industry,
      industry_raw: rawIndustry || undefined,
      ai_score: aiScore,
      first_name: extractFirstName(lead.first_name || lead.contact_name || lead.name),
      status: 'qualified',
      qualified_at: new Date().toISOString(),
    });
  }

  // Sort by score descending — best leads first
  qualified.sort((a, b) => b.ai_score - a.ai_score);

  return qualified.slice(0, Math.max(0, Number(maxLeads) || 0));
}

/**
 * Quick score check for a single lead
 */
export function scoreLead(lead) {
  const rawIndustry = String((lead && lead.industry) || '').trim();
  const industry = normalizeIndustry(rawIndustry);
  return {
    industry,
    score: getIndustryScore(rawIndustry || industry),
    valid: isUsableEmail(lead && lead.email),
    excluded: shouldExclude(lead || {}),
  };
}
