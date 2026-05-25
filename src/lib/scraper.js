/**
 * Lead Scraper — Scrapes Sri Lankan business directories
 * Sources: yp.lk, bizdir.lk, Google Maps Places API (optional)
 * Returns: Array of lead objects { company_name, email, industry, city, phone, website, source }
 */

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Industries to scrape — mapped to search terms per source
const TARGET_SEARCHES = [
  { query: 'logistics company', industry: 'logistics' },
  { query: 'transport company', industry: 'transport' },
  { query: 'manufacturing company', industry: 'manufacturing' },
  { query: 'finance company', industry: 'finance' },
  { query: 'insurance company', industry: 'insurance' },
  { query: 'retail store', industry: 'retail' },
  { query: 'hotel', industry: 'hotel' },
  { query: 'restaurant', industry: 'restaurant' },
  { query: 'hospital', industry: 'healthcare' },
  { query: 'clinic', industry: 'clinic' },
  { query: 'law firm', industry: 'legal' },
  { query: 'real estate agency', industry: 'real estate' },
  { query: 'school', industry: 'education' },
];

const CITIES = ['Colombo', 'Kandy', 'Galle', 'Negombo', 'Dehiwela', 'Moratuwa', 'Ja-Ela', 'Kurunegala'];

/**
 * Scrape Yellow Pages Sri Lanka (yp.lk)
 */
async function scrapeYellowPages(query, city) {
  const leads = [];
  try {
    const url = `https://www.yp.lk/search?q=${encodeURIComponent(query)}&location=${encodeURIComponent(city)}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) return leads;
    const html = await response.text();

    // Extract business listings — yp.lk uses structured listing cards
    // Pattern 1: mailto links with business names
    const emailRegex = /href="mailto:([^"]+)"[^>]*>/gi;
    const nameRegex = /<h\d[^>]*class="[^"]*(?:business|company|listing)[^"]*"[^>]*>([^<]+)</gi;
    const phoneRegex = /(?:\+94|0)\s*\d{2}[\s-]?\d{3}[\s-]?\d{4}/g;

    // Collect all emails found
    const emails = [];
    let match;
    while ((match = emailRegex.exec(html)) !== null) {
      emails.push(match[1].toLowerCase().trim());
    }

    // Collect business names
    const names = [];
    while ((match = nameRegex.exec(html)) !== null) {
      names.push(match[1].trim());
    }

    // Collect phones
    const phones = [];
    while ((match = phoneRegex.exec(html)) !== null) {
      phones.push(match[0].trim());
    }

    // Match emails with names (best effort)
    for (let i = 0; i < emails.length; i++) {
      leads.push({
        company_name: names[i] || `Business in ${city}`,
        email: emails[i],
        industry: query.split(' ')[0], // rough industry from query
        city: city,
        phone: phones[i] || '',
        website: '',
        source: 'yp.lk',
        scraped_at: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.log(`[scraper] yp.lk failed for "${query}" in ${city}: ${err.message}`);
  }
  return leads;
}

/**
 * Scrape Bizdir.lk
 */
async function scrapeBizdir(categorySlug) {
  const leads = [];
  try {
    const url = `https://bizdir.lk/category/${categorySlug}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) return leads;
    const html = await response.text();

    // Extract emails and company names from listing pages
    const emailRegex = /href="mailto:([^"]+)"/gi;
    const titleRegex = /class="[^"]*(?:title|name|company)[^"]*"[^>]*>\s*<a[^>]*>([^<]+)</gi;

    const emails = [];
    let match;
    while ((match = emailRegex.exec(html)) !== null) {
      emails.push(match[1].toLowerCase().trim());
    }

    const names = [];
    while ((match = titleRegex.exec(html)) !== null) {
      names.push(match[1].trim());
    }

    for (let i = 0; i < emails.length; i++) {
      leads.push({
        company_name: names[i] || 'Unknown Business',
        email: emails[i],
        industry: categorySlug.replace(/-/g, ' '),
        city: 'Sri Lanka',
        phone: '',
        website: '',
        source: 'bizdir.lk',
        scraped_at: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.log(`[scraper] bizdir.lk failed for "${categorySlug}": ${err.message}`);
  }
  return leads;
}

/**
 * Scrape Google Maps Places API (optional — requires API key)
 */
async function scrapeGoogleMaps(query, city, apiKey) {
  const leads = [];
  if (!apiKey) return leads;

  try {
    const searchQuery = `${query} in ${city} Sri Lanka`;
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(searchQuery)}&key=${apiKey}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });

    if (!response.ok) return leads;
    const data = await response.json();

    if (data.results) {
      for (const place of data.results.slice(0, 10)) {
        // Google Maps doesn't provide email directly — we get name, address, phone
        // Email finding happens via website scraping in a later step
        leads.push({
          company_name: place.name || '',
          email: '', // Will be enriched later
          industry: query.split(' ')[0],
          city: city,
          phone: place.formatted_phone_number || '',
          website: '', // Need Place Details API for this
          address: place.formatted_address || '',
          rating: place.rating || 0,
          source: 'google_maps',
          place_id: place.place_id,
          scraped_at: new Date().toISOString(),
        });
      }
    }
  } catch (err) {
    console.log(`[scraper] Google Maps failed for "${query}" in ${city}: ${err.message}`);
  }
  return leads;
}

/**
 * Try to find email from a company website
 * Visits the website and looks for mailto links or common email patterns
 */
async function findEmailFromWebsite(websiteUrl) {
  try {
    const response = await fetch(websiteUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(10000),
      redirect: 'follow',
    });

    if (!response.ok) return null;
    const html = await response.text();

    // Look for mailto links
    const mailtoMatch = html.match(/href="mailto:([^"?]+)/i);
    if (mailtoMatch) return mailtoMatch[1].toLowerCase().trim();

    // Look for email patterns in text
    const emailMatch = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (emailMatch) {
      const email = emailMatch[0].toLowerCase();
      // Skip image filenames and CSS
      if (!email.includes('.png') && !email.includes('.jpg') && !email.includes('.css')) {
        return email;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Generate common email guesses for a domain
 */
function guessEmails(domain) {
  return [
    `info@${domain}`,
    `contact@${domain}`,
    `hello@${domain}`,
    `admin@${domain}`,
  ];
}

/**
 * Main scraping function — runs all sources and returns combined leads
 * @param {object} options
 * @param {string} options.googleMapsApiKey - Optional Google Maps API key
 * @param {number} options.maxLeadsPerRun - Cap total leads (default 200)
 * @param {number} options.delayBetweenRequests - Ms between requests (default 3000)
 * @returns {Promise<Array>} Array of lead objects
 */
export async function scrapeLeads(options = {}) {
  const {
    googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY || '',
    maxLeadsPerRun = 200,
    delayBetweenRequests = 3000,
  } = options;

  const allLeads = [];
  const seenEmails = new Set();

  console.log('[scraper] Starting lead scrape run...');

  // 1. Scrape Yellow Pages
  for (const search of TARGET_SEARCHES) {
    for (const city of CITIES.slice(0, 3)) { // Top 3 cities per run
      if (allLeads.length >= maxLeadsPerRun) break;

      const leads = await scrapeYellowPages(search.query, city);
      for (const lead of leads) {
        if (!seenEmails.has(lead.email)) {
          seenEmails.add(lead.email);
          lead.industry = search.industry; // Normalize
          allLeads.push(lead);
        }
      }

      // Rate limiting
      await new Promise(r => setTimeout(r, delayBetweenRequests));
    }
  }

  console.log(`[scraper] Yellow Pages: ${allLeads.length} leads`);

  // 2. Scrape Bizdir.lk
  const bizdirCategories = [
    'business-services', 'manufacturing', 'hospitality',
    'healthcare', 'finance', 'transport', 'retail',
  ];

  for (const cat of bizdirCategories) {
    if (allLeads.length >= maxLeadsPerRun) break;

    const leads = await scrapeBizdir(cat);
    for (const lead of leads) {
      if (!seenEmails.has(lead.email)) {
        seenEmails.add(lead.email);
        allLeads.push(lead);
      }
    }

    await new Promise(r => setTimeout(r, delayBetweenRequests));
  }

  console.log(`[scraper] After Bizdir: ${allLeads.length} total leads`);

  // 3. Google Maps (optional, if API key provided)
  if (googleMapsApiKey) {
    for (const search of TARGET_SEARCHES.slice(0, 5)) {
      if (allLeads.length >= maxLeadsPerRun) break;

      const leads = await scrapeGoogleMaps(search.query, 'Colombo', googleMapsApiKey);
      for (const lead of leads) {
        // Google Maps leads may not have email — try enrichment later
        if (lead.email && !seenEmails.has(lead.email)) {
          seenEmails.add(lead.email);
          lead.industry = search.industry;
          allLeads.push(lead);
        }
      }

      await new Promise(r => setTimeout(r, 2000));
    }
    console.log(`[scraper] After Google Maps: ${allLeads.length} total leads`);
  }

  console.log(`[scraper] Scrape complete. Total raw leads: ${allLeads.length}`);
  return allLeads.slice(0, maxLeadsPerRun);
}
