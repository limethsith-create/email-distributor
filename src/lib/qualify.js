/**
 * Lead Qualification & Scoring Engine
 * Rule-based scoring — $0 cost, no AI needed
 * Scores industries 0-10 based on AI automation potential
 */

// Industry AI-readiness scores (0-10)
const INDUSTRY_SCORES = {
  logistics: 9,
  transport: 9,
  manufacturing: 9,
  finance: 9,
  banking: 9,
  insurance: 8,
  retail: 8,
  hotel: 8,
  hospitality: 8,
  healthcare: 8,
  hospital: 8,
  legal: 8,
  law: 8,
  clinic: 7,
  'real estate': 7,
  property: 7,
  restaurant: 7,
  food: 7,
  education: 7,
  school: 6,
  'it services': 6,
  technology: 5,
};

// Skip these email patterns (low reply rate)
const SKIP_EMAIL_PATTERNS = [
  'noreply@', 'no-reply@', 'donotreply@',
  'postmaster@', 'mailer@', 'bounce@',
  'spam@', 'abuse@', 'security@',
  'webmaster@', 'hostmaster@', 'root@',
];

// Skip personal email domains (we want business emails)
const SKIP_DOMAINS = [
  'gmail.com', 'yahoo.com', 'hotmail.com',
  'outlook.com', 'live.com', 'aol.com',
  'icloud.com', 'mail.com', 'protonmail.com',
];

// Skip known enterprise/gov domains
const SKIP_COMPANY_PATTERNS = [
  'government', 'gov.lk', 'police', 'army',
  'ceylon petroleum', 'ceylon electricity',
];

/**
 * Normalize industry string to a scoring category
 */
function normalizeIndustry(raw) {
  if (!raw) return 'other';
  const lower = raw.toLowerCase().trim();
  for (const key of Object.keys(INDUSTRY_SCORES)) {
    if (lower.includes(key)) return key;
  }
  return 'other';
}

/**
 * Get AI-readiness score for an industry
 */
function getIndustryScore(industry) {
  return INDUSTRY_SCORES[industry] || 5;
}

/**
 * Validate an email address
 */
function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  if (!email.includes('@')) return false;
  if (email.length < 5 || email.length > 254) return false;

  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain || !domain.includes('.')) return false;

  // Skip personal emails
  if (SKIP_DOMAINS.includes(domain)) return false;

  // Skip system/noreply emails
  const localPart = email.split('@')[0].toLowerCase();
  if (SKIP_EMAIL_PATTERNS.some(p => localPart.startsWith(p.replace('@', '')))) return false;

  // Basic format check
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return emailRegex.test(email);
}

/**
 * Clean company name for display
 */
function cleanCompanyName(name) {
  if (!name) return '';
  return name
    .replace(/\s*(Pvt\.?\s*Ltd\.?|Ltd\.?|LLC|PLC|Inc\.?|Co\.?\s*Ltd\.?|Private\s+Limited)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract first name from a contact name
 */
function extractFirstName(contactName) {
  if (!contactName) return null;
  return contactName.split(/[\s,]/)[0].trim();
}

/**
 * Check if a company should be excluded
 */
function shouldExclude(lead) {
  const name = (lead.company_name || '').toLowerCase();
  const email = (lead.email || '').toLowerCase();

  // Exclude government/SOE
  if (SKIP_COMPANY_PATTERNS.some(p => name.includes(p) || email.includes(p))) {
    return true;
  }

  // Exclude if email is clearly an example
  if (email.includes('example.com') || email.includes('test.com')) {
    return true;
  }

  return false;
}

/**
 * Qualify and score a batch of leads
 * @param {Array} leads - Raw scraped leads
 * @param {object} options
 * @param {number} options.minScore - Minimum AI score to qualify (default 7)
 * @param {number} options.maxLeads - Max leads to return (default 50)
 * @returns {Array} Qualified leads sorted by score (highest first)
 */
export function qualifyLeads(leads, options = {}) {
  const { minScore = 7, maxLeads = 50 } = options;
  const qualified = [];

  for (const lead of leads) {
    // Skip invalid emails
    if (!isValidEmail(lead.email)) continue;

    // Skip excluded companies
    if (shouldExclude(lead)) continue;

    // Normalize and score
    const industry = normalizeIndustry(lead.industry);
    const aiScore = getIndustryScore(industry);

    // Only keep high-potential leads
    if (aiScore < minScore) continue;

    qualified.push({
      ...lead,
      company_name: cleanCompanyName(lead.company_name),
      email: lead.email.toLowerCase().trim(),
      industry,
      ai_score: aiScore,
      first_name: extractFirstName(lead.contact_name),
      status: 'qualified',
      qualified_at: new Date().toISOString(),
    });
  }

  // Sort by score descending — best leads first
  qualified.sort((a, b) => b.ai_score - a.ai_score);

  return qualified.slice(0, maxLeads);
}

/**
 * Quick score check for a single lead
 */
export function scoreLead(lead) {
  const industry = normalizeIndustry(lead.industry);
  return {
    industry,
    score: getIndustryScore(industry),
    valid: isValidEmail(lead.email),
    excluded: shouldExclude(lead),
  };
}
