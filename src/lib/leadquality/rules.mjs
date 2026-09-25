// Lead quality rules shared by the Lead Finder job (scripts/leadfinder, plain
// Node 20) and the app (grader, verifier, sanity check). Pure data + pure
// functions, no imports, so both sides apply exactly the same rules.
//
//   role addresses      never kept (info@, sales@, office@ …) — the owner's
//                       last campaign bounced 43 % partly on role accounts
//   free-mail domains   gmail.com & co.: kept only when the local part is the
//                       person's own name
//   disposable domains  a short built-in list (the big public list is not
//                       needed for addresses found on company websites)
//   franchises          brand names and the "independently owned and
//                       operated" disclaimer
//   titles              decision-maker tiers (owner … office manager)
//   names               first-name list + stop words for extraction
//   patterns            email pattern inference from a known address

// ── US geography ─────────────────────────────────────────────────────────────

export const US_STATE_CODES = 'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' ');
const US_SET = new Set(US_STATE_CODES);
export const STATE_NAMES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY',
  louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO',
  montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC',
};

/** 'tx' / 'Texas' / ' TX ' → 'TX'; anything else → ''. */
export function normState(s) {
  const v = String(s || '').trim();
  if (!v) return '';
  if (US_SET.has(v.toUpperCase())) return v.toUpperCase();
  return STATE_NAMES[v.toLowerCase()] || '';
}

// Country-code TLDs that are never a US business (the last campaign sent 28 %
// of its mail to .lk addresses). .us/.co/.io/.ai/.me stay allowed.
const NON_US_TLDS = new Set(['ca', 'uk', 'au', 'nz', 'in', 'lk', 'ie', 'de', 'fr', 'es', 'it', 'nl', 'be', 'ch', 'at', 'se', 'no', 'dk', 'fi', 'pl', 'pt', 'br', 'mx', 'ar', 'cl', 'za', 'ng', 'ke', 'gh', 'ph', 'pk', 'bd', 'sg', 'my', 'id', 'th', 'vn', 'ae', 'sa', 'qa', 'cn', 'jp', 'kr', 'hk', 'tw', 'ru', 'ua', 'tr', 'il', 'eg', 'gr', 'ro', 'cz', 'hu', 'sk', 'bg', 'hr', 'rs', 'lt', 'lv', 'ee', 'is']);
/** true when the host ends in a non-US country TLD (acme.co.uk, acme.lk). */
export function isNonUsHost(host) {
  const parts = String(host || '').toLowerCase().split('.').filter(Boolean);
  return parts.length > 1 && NON_US_TLDS.has(parts[parts.length - 1]);
}

// ── role, free-mail and disposable addresses ────────────────────────────────

const ROLE_WORDS = [
  'info', 'information', 'hello', 'hi', 'hey', 'howdy', 'contact', 'contactus', 'office', 'admin', 'administrator', 'sales', 'support',
  'team', 'mail', 'email', 'enquiries', 'enquiry', 'inquiries', 'inquiry', 'help', 'helpdesk', 'service', 'services', 'customerservice',
  'customercare', 'care', 'reception', 'frontdesk', 'front', 'billing', 'accounts', 'accountspayable', 'accountsreceivable', 'ap', 'ar',
  'invoices', 'invoice', 'payments', 'payroll', 'careers', 'career', 'jobs', 'job', 'hr', 'hiring', 'recruiting', 'marketing', 'media',
  'press', 'pr', 'news', 'newsletter', 'webmaster', 'web', 'website', 'postmaster', 'hostmaster', 'abuse', 'noreply', 'donotreply',
  'bookings', 'booking', 'book', 'appointments', 'appointment', 'appts', 'schedule', 'scheduling', 'estimates', 'estimate', 'quotes',
  'quote', 'dispatch', 'orders', 'order', 'shop', 'store', 'legal', 'compliance', 'privacy', 'security', 'it', 'tech', 'events',
  'general', 'main', 'mailbox', 'inbox', 'staff', 'all', 'everyone', 'owner', 'owners', 'manager', 'management', 'operations', 'ops',
  'finance', 'accounting', 'bookkeeping', 'claims', 'intake', 'leads', 'lead', 'partners', 'partner', 'vendors', 'purchasing',
  'reservations', 'rsvp', 'feedback', 'reviews', 'social', 'welcome', 'mybusiness', 'business', 'company', 'hq', 'headquarters',
  'receptionist', 'officemanager', 'frontoffice', 'service-desk', 'servicedesk', 'emergency', 'repairs', 'repair', 'install', 'warranty',
];
const ROLE_SET = new Set(ROLE_WORDS);
// Prefixes that are never the start of a person's name ("info.dallas",
// "sales2", "servicedept"). Ambiguous words (care → Carey, staff → Stafford,
// press → Pressley, book → Booker) only count as the whole local part.
const ROLE_PREFIXES = ['info', 'sales', 'support', 'admin', 'office', 'contact', 'service', 'services', 'billing', 'accounts', 'careers',
  'marketing', 'hello', 'enquiries', 'inquiries', 'enquiry', 'inquiry', 'reception', 'frontdesk', 'dispatch', 'booking', 'bookings',
  'appointments', 'appointment', 'scheduling', 'schedule', 'estimates', 'quotes', 'webmaster', 'customerservice', 'customercare',
  'helpdesk', 'noreply', 'donotreply', 'payments', 'invoices', 'recruiting', 'hiring', 'orders', 'warranty'];
const ROLE_PREFIX_RE = new RegExp(`^(?:${ROLE_PREFIXES.sort((a, b) => b.length - a.length).join('|')})(?:[._-]?[a-z]{0,12})?\\d*$`);
const ROLE_SUFFIX_RE = /^[a-z]{2,20}[._-]?(?:office|info|sales|support|admin|service|desk)\d*$/;

/**
 * A shared mailbox, not a person: info@, sales2@, info.dallas@, dallasoffice@,
 * no-reply@ … (local part only is looked at).
 */
export function isRoleLocal(local) {
  const l = String(local || '').toLowerCase().replace(/\+.*$/, '');
  if (!l) return true;
  const bare = l.replace(/[._-]/g, '');
  if (ROLE_SET.has(l) || ROLE_SET.has(bare)) return true;
  if (/^(no-?reply|do-?not-?reply|mailer-daemon)/.test(l)) return true;
  if (FIRST_NAMES.has(l)) return false;
  if (ROLE_PREFIX_RE.test(l)) return true;
  if (ROLE_SUFFIX_RE.test(l)) return true;
  return false;
}

export function isRoleAddress(email) {
  return isRoleLocal(String(email || '').split('@')[0]);
}

export const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'rocketmail.com', 'aol.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'comcast.net', 'att.net', 'sbcglobal.net', 'bellsouth.net', 'verizon.net', 'cox.net', 'charter.net',
  'earthlink.net', 'juno.com', 'netzero.net', 'protonmail.com', 'proton.me', 'zoho.com', 'gmx.com', 'mail.com', 'frontier.com',
  'windstream.net', 'centurylink.net', 'optonline.net', 'roadrunner.com', 'twc.com', 'rr.com', 'embarqmail.com', 'q.com', 'aim.com',
]);
export const isFreemail = (emailOrHost) => FREEMAIL_DOMAINS.has(String(emailOrHost || '').toLowerCase().split('@').pop());

// A short built-in list of throwaway-mail domains. Company websites almost
// never publish one; this only guards against junk that slipped in.
export const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'sharklasers.com', 'grr.la', '10minutemail.com',
  '10minutemail.net', 'tempmail.com', 'temp-mail.org', 'temp-mail.io', 'tempmail.net', 'tempmailo.com', 'tempail.com', 'yopmail.com',
  'yopmail.net', 'trashmail.com', 'trashmail.de', 'getnada.com', 'nada.email', 'dispostable.com', 'maildrop.cc', 'throwawaymail.com',
  'fakeinbox.com', 'mohmal.com', 'emailondeck.com', 'mintemail.com', 'spamgourmet.com', 'mytemp.email', 'burnermail.io', 'mailnesia.com',
  'mailcatch.com', 'spambox.us', 'getairmail.com', 'discard.email', 'discardmail.com', 'moakt.com', 'tmail.ws', 'tmpmail.org',
  'tmpmail.net', 'emailfake.com', 'fakemail.net', 'mailpoof.com', 'inboxkitten.com', 'mail.tm', 'mailsac.com', 'spam4.me',
  'guerrillamailblock.com', 'pokemail.net', 'mailexpire.com', 'tempinbox.com', 'mailforspam.com', 'jetable.org', 'mvrht.net',
  'harakirimail.com', 'anonbox.net', 'mt2015.com', 'boun.cr', 'deadaddress.com', 'emailtemporanea.net', 'incognitomail.com',
  'mailmoat.com', 'mailnull.com', 'meltmail.com', 'nowmymail.com', 'owlpic.com', 'rcpt.at', 'spamfree24.org', 'spaml.com',
  'tempemail.net', 'tempomail.fr', 'temporaryemail.net', 'thankyou2010.com', 'trash2009.com', 'trashymail.com', 'wegwerfmail.de',
  'wh4f.org', 'zippymail.info', 'mailtothis.com', 'dropmail.me', '1secmail.com', '1secmail.net', '1secmail.org', 'emltmp.com',
  'linshiyouxiang.net', 'byom.de', 'cuvox.de', 'dayrep.com', 'einrot.com', 'fleckens.hu', 'gustr.com', 'jourrapide.com', 'rhyta.com',
  'superrito.com', 'teleworm.us', 'armyspy.com',
]);
export const isDisposable = (emailOrHost) => DISPOSABLE_DOMAINS.has(String(emailOrHost || '').toLowerCase().split('@').pop());

/** Syntax only (RFC-ish, the shapes a business address takes). */
export function syntaxOk(email) {
  const e = String(email || '').trim().toLowerCase();
  if (e.length > 254 || e.length < 6) return false;
  if (!/^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,24}$/.test(e)) return false;
  return !/\.\.|\.@|@\./.test(e);
}

// ── franchises and chains ────────────────────────────────────────────────────

// Distinctive brand names of US franchise / chain systems in the niches trial
// clients sell to. Matched against the normalised company name (whole words).
export const FRANCHISE_BRANDS = [
  // plumbing, HVAC, electrical, handyman
  'roto rooter', 'mr rooter', 'benjamin franklin plumbing', 'ars rescue rooter', 'rescue rooter', 'one hour heating', 'aire serv',
  'mr electric', 'mister sparky', 'mr handyman', 'handyman connection', 'ace handyman', 'rooter man', 'zoom drain', 'bluefrog plumbing',
  '1 800 plumber', 'service experts', 'goettl', 'frontdoor', 'mosquito joe', 'mosquito squad', 'drain doctor',
  // restoration, cleaning, janitorial
  'servpro', 'servicemaster', 'paul davis', 'belfor', 'puroclean', '911 restoration', 'rainbow restoration', 'rytech', 'dryzone',
  'molly maid', 'merry maids', 'the maids', 'maidpro', 'two maids', 'jan pro', 'coverall', 'jani king', 'vanguard cleaning',
  'city wide facility', 'anago', 'stratus building solutions', 'office pride', 'chem dry', 'stanley steemer', 'zerorez', 'heaven s best',
  // lawn, pest, painting, home
  'the grounds guys', 'weed man', 'lawn doctor', 'trugreen', 'spring green', 'us lawns', 'brightview', 'orkin', 'terminix', 'truly nolen',
  'aptive', 'rentokil', 'ehrlich', 'certapro', 'five star painting', 'fresh coat', 'window world', 'renewal by andersen', 'glass doctor',
  'mr rekey', 'pop a lock', 'precision garage door', 'overhead door company', 'budget blinds', 'bath fitter', 're bath', 'kitchen tune up',
  'dreammaker', 'floor coverings international', 'mighty dog roofing', 'roof maxx', 'storm guard', 'pillar to post', 'hometeam inspection',
  'amerispec', 'win home inspection', 'national property inspections', '1 800 got junk', 'junk king', 'college hunks', 'junkluggers',
  'two men and a truck', 'fish window cleaning', 'men in kilts', 'window genie', 'shack shine', 'the joint chiropractic',
  // IT, phone, print, signs, shipping
  'cmit solutions', 'computer troubleshooters', 'experimac', 'cpr cell phone repair', 'ubreakifix', 'asurion', 'geek squad', 'nerds on call',
  'fastsigns', 'signarama', 'image360', 'speedpro', 'minuteman press', 'allegra', 'sir speedy', 'alphagraphics', 'kwik kopy', 'proforma',
  'the ups store', 'postal annex', 'pak mail', 'goin postal', 'unishippers', 'staples', 'office depot',
  // staffing, tax, accounting, business services
  'express employment', 'spherion', 'adecco', 'manpower', 'kelly services', 'robert half', 'randstad', 'aerotek', 'snelling',
  'labor finders', 'pridestaff', 'h r block', 'jackson hewitt', 'liberty tax', 'padgett', 'fiducial', 'paychex', 'adp',
  // real estate, insurance, finance
  'keller williams', 're max', 'remax', 'coldwell banker', 'century 21', 'berkshire hathaway homeservices', 'exp realty', 'sotheby s',
  'better homes and gardens real estate', 'era real estate', 'weichert', 'howard hanna', 'state farm', 'allstate', 'farmers insurance',
  'american family insurance', 'nationwide', 'goosehead insurance', 'brightway insurance', 'estrella insurance', 'edward jones',
  'ameriprise', 'primerica', 'northwestern mutual', 'new york life', 'mass mutual', 'massmutual', 'wells fargo', 'bank of america', 'chase',
  // fitness, beauty, health, dental
  'planet fitness', 'anytime fitness', 'orangetheory', 'f45', 'snap fitness', 'gold s gym', 'la fitness', 'crunch fitness', '24 hour fitness',
  'club pilates', 'pure barre', 'burn boot camp', '9round', 'title boxing', 'great clips', 'supercuts', 'sport clips', 'fantastic sams',
  'cost cutters', 'hair cuttery', 'european wax center', 'massage envy', 'hand and stone', 'the lash lounge', 'sola salon', 'aspen dental',
  'heartland dental', 'western dental', 'bright now dental', 'coast dental', 'pacific dental', 'monarch dental', 'castle dental',
  'comfort dental', 'perfect teeth', 'smile brands', 'kool smiles', 'banfield', 'vca animal', 'thrive pet', 'medvet',
  // auto
  'jiffy lube', 'midas', 'meineke', 'firestone', 'pep boys', 'valvoline', 'maaco', 'precision tune', 'christian brothers automotive',
  'tire kingdom', 'big o tires', 'les schwab', 'take 5', 'grease monkey', 'caliber collision', 'service king', 'gerber collision',
  'carstar', 'fix auto', 'safelite', 'discount tire', 'monro',
  // childcare, education, senior care, pets
  'kiddie academy', 'goddard school', 'primrose school', 'kindercare', 'the learning experience', 'tutor time', 'childtime', 'kumon',
  'sylvan learning', 'mathnasium', 'huntington learning', 'club z', 'home instead', 'visiting angels', 'comfort keepers', 'right at home',
  'brightstar care', 'griswold', 'synergy homecare', 'amada senior care', 'dogtopia', 'camp bow wow', 'petsmart', 'petco',
  // food / retail (never an SMB prospect)
  'mcdonald s', 'subway', 'starbucks', 'dunkin', 'domino s', 'pizza hut', 'chick fil a', 'taco bell', 'wendy s', 'burger king',
  '7 eleven', 'walgreens', 'cvs', 'walmart', 'target', 'home depot', 'lowe s', 'best buy', 'autozone', 'o reilly auto', 'advance auto',
];

const normWords = (s) => ` ${String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
const BRAND_KEYS = FRANCHISE_BRANDS.map((b) => normWords(b));

/** The franchise brand in a company name, or null. */
export function franchiseBrand(company) {
  const n = normWords(company);
  if (n.trim().length < 2) return null;
  const hit = BRAND_KEYS.find((b) => n.includes(b));
  return hit ? hit.trim() : null;
}

/** Franchise disclaimer text on a location's website. */
export const FRANCHISE_TEXT_RE = /\b(?:each (?:location|office|franchise|studio|store) is |(?:is |are )?)independently owned and operated\b|\bfranchise (?:location|owner|opportunit)|\bindependent(?:ly owned)? franchisee\b/i;

/**
 * A Places website URL that points at one location page of a brand site
 * ("https://brand.com/locations/dallas", "https://brand.com/dallas-tx/").
 */
export function isLocationPageUrl(url, city = '') {
  const m = /^[a-z]+:\/\/[^/]+(\/[^?#]*)?/i.exec(String(url || ''));
  const path = (m && m[1]) || '';
  if (/\/(locations?|offices?|branches|stores?|franchise|find-a-location|near-you)\//i.test(`${path}/`)) return true;
  const c = String(city || '').toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
  if (!c) return false;
  const first = path.split('/').filter(Boolean)[0] || '';
  return first === c || first.startsWith(`${c}-`);
}

// ── titles ───────────────────────────────────────────────────────────────────

/** Decision-maker tiers (0–100). First match wins, longest phrases first. */
export const TITLE_TIERS = [
  [100, ['owner', 'co-owner', 'founder', 'co-founder', 'president', 'ceo', 'chief executive officer', 'chief executive', 'principal',
    'managing partner', 'proprietor', 'managing member', 'founding partner', 'owner/operator', 'owner operator', 'broker/owner', 'broker owner']],
  [85, ['general manager', 'managing director', 'coo', 'chief operating officer', 'senior partner', 'partner', 'managing attorney',
    'principal attorney', 'shareholder', 'executive director', 'managing broker', 'founding attorney', 'owner & ceo']],
  [70, ['vice president', 'vp', 'director of operations', 'operations director', 'cfo', 'chief financial officer', 'cto',
    'chief technology officer', 'cio', 'director', 'head of operations', 'operations manager', 'controller']],
  [55, ['office manager', 'practice manager', 'practice administrator', 'office administrator', 'business manager', 'administrator',
    'general counsel', 'branch manager', 'service manager', 'project manager', 'estimator', 'facilities manager', 'property manager']],
];
const TITLE_LIST = TITLE_TIERS.flatMap(([tier, words]) => words.map((w) => [w, tier])).sort((a, b) => b[0].length - a[0].length);
/** Every title word the extractor looks for, longest first. */
export const TITLE_WORDS = TITLE_LIST.map(([w]) => w);

/** 0–100 for a title string ('' → 0; unknown title → 25). */
export function titleTier(title) {
  const t = ` ${String(title || '').toLowerCase().replace(/[^a-z/&\- ]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
  if (!t.trim()) return 0;
  for (const [w, tier] of TITLE_LIST) {
    const re = new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}([^a-z]|$)`);
    if (re.test(t)) return tier;
  }
  return 25;
}

// ── names ────────────────────────────────────────────────────────────────────

// Common US first names (public SSA popularity data, top names across
// generations). Used to tell a person ("Jane Smith") from a heading ("Water
// Heaters") when a name has no title next to it.
export const FIRST_NAMES = new Set(`
james john robert michael william david richard joseph thomas charles christopher daniel matthew anthony mark donald steven paul andrew
joshua kenneth kevin brian george timothy ronald edward jason jeffrey ryan jacob gary nicholas eric jonathan stephen larry justin scott
brandon benjamin samuel gregory alexander frank patrick raymond jack dennis jerry tyler aaron jose adam nathan henry douglas zachary
peter kyle ethan walter noah jeremy christian keith roger terry gerald harold sean austin carl arthur lawrence dylan jesse jordan bryan
billy joe bruce gabriel logan albert willie alan juan wayne elijah randy roy vincent ralph eugene russell bobby mason philip louis
mary patricia jennifer linda elizabeth barbara susan jessica sarah karen lisa nancy betty margaret sandra ashley kimberly emily donna
michelle carol amanda dorothy melissa deborah stephanie rebecca sharon laura cynthia kathleen amy angela shirley anna brenda pamela
emma nicole helen samantha katherine christine debra rachel carolyn janet catherine maria heather diane ruth julie olivia joyce
virginia victoria kelly lauren christina joan evelyn judith megan andrea cheryl hannah jacqueline martha gloria teresa ann sara madison
frances kathryn janice jean abigail alice judy sophia grace denise amber doris marilyn danielle beverly isabella theresa diana natalie
brittany charlotte marie kayla alexis lori tom tim mike dave dan jim bob bill steve chris matt nick tony rick greg jeff ken ben sam
pat ron don joel todd troy shane chad brad derek travis cody corey dustin marcus luis carlos jorge miguel ricardo antonio manuel
francisco pedro alejandro javier fernando rafael sergio mario hector roberto eduardo victor oscar ruben angel diego raul jesus
kate katie beth liz jen jenny jill jane joanne leslie tracy stacy wendy tina dawn holly erin kristen kristin heidi april tara dana
monica veronica vanessa erica tiffany crystal courtney whitney allison alison lindsey lindsay molly caitlin kaitlyn morgan taylor
brooke paige kelsey hailey haley chloe zoe lily ella avery riley aubrey nora lucy claire audrey leah stella violet hazel aurora
anne annie ellen joy carrie misty tammy connie sherry sheila marcia rhonda terri kathy cathy vicki becky peggy sue gail jo lynn
kim meg nina rosa carmen lucia elena sofia ana isabel adriana gabriela alicia yolanda irene esther lydia marlene eileen colleen
maureen darlene charlene arlene rita norma bonnie lois phyllis jeanette sylvia josephine vera wanda kristina kristy melinda
brett blake chase cole grant hunter wyatt owen luke caleb isaac isaiah evan ian connor jared miles max leo levi eli colin spencer
seth trevor devin garrett jake jay jon dean glenn neil curtis dale allen leonard stanley earl jimmy johnny danny tommy kenny
marvin howard fred calvin darren warren lee gordon clifford dwayne rodney wesley bradley erik jamie shawn clayton casey drew
reid ross mitchell mitch nathaniel nate phil ray andy randall rob ronnie terrence lance kurt darrell alvin franklin herbert
vivian caroline madeline jocelyn natasha dianne suzanne yvonne priya anita sunita raj ravi amit vikram arjun sanjay deepak
kevin wei li chen mei ling hiroshi kenji yuki omar ali ahmed hassan fatima aisha mohammed muhammad yusuf ibrahim
`.split(/\s+/).filter(Boolean));

// Words that are never part of a person's name on a small-business site.
export const NAME_STOPWORDS = new Set(`
our the and meet about contact team home read more learn call email us we you your get free quote estimate service services
company roofing plumbing heating cooling air hvac electric electrical repair repairs install installation commercial residential
emergency schedule today now new welcome main street suite ave avenue road rd st blvd drive floor office
offices center group llc inc co corp ltd pllc pc law firm dental dentistry family clinic medical health care insurance agency realty
real estate financial tax accounting services solutions systems technologies technology it managed support network networks cloud
security marketing digital media design studio creative web website seo social privacy policy terms copyright rights reserved all
view click here book online appointment appointments request quick links menu search follow facebook linkedin instagram twitter
youtube google reviews review testimonials gallery projects portfolio careers jobs join apply staff leadership management board
directors owners founders history mission values vision why choose top quality trusted local serving since years year award
winning certified licensed bonded insured water heater drain sewer roof gutter gutters siding windows doors door garage
kitchen bath bathroom remodeling remodel construction builders building contractors contractor general landscaping lawn pest control
cleaning janitorial carpet flooring painting painters paint concrete masonry fencing fence pool pools solar energy storage moving
texas florida california metro county city state united states america usa inc. llc.
`.split(/\s+/).filter(Boolean));

const HONORIFIC_RE = /^(?:dr|mr|mrs|ms|miss|mx|prof|rev|hon)\.?\s+/i;
const SUFFIX_RE = /,?\s+(?:jr|sr|ii|iii|iv|dds|dmd|md|do|dc|od|dvm|cpa|esq|phd|pe|ra|aia|ea|cfp|clu|chfc|rn|np|pa-c|mba|pmp|cissp|ccie)\.?$/i;
const SUFFIX_ANY_RE = /\b(?:dds|dmd|md|dvm|cpa|esq|phd|pe|ea|cfp)\b/i;

/** "Dr. Jane Q. Smith, DDS" → { clean: 'Jane Q. Smith', doctor: true, credential: 'dds' } */
export function cleanPersonName(raw) {
  let s = String(raw || '').replace(/\s+/g, ' ').trim();
  const doctor = /^dr\.?\s/i.test(s) || /,?\s+(dds|dmd|md|do|dvm|od|dc)\.?$/i.test(s);
  const cred = (SUFFIX_ANY_RE.exec(s) || [])[0] || '';
  s = s.replace(HONORIFIC_RE, '');
  for (let i = 0; i < 3; i++) s = s.replace(SUFFIX_RE, '').trim();
  return { clean: s, doctor, credential: cred.toLowerCase() };
}

/** Plausible person name: 2–4 capitalised words, none a stop word. `strict` also wants a known first name. */
export function looksLikeName(raw, { strict = false } = {}) {
  const { clean } = cleanPersonName(raw);
  const parts = clean.split(' ').filter(Boolean);
  if (parts.length < 2 || parts.length > 4) return false;
  for (const p of parts) {
    if (!/^[A-Z][a-zA-Z'’-]*\.?$/.test(p)) return false;
    const w = p.toLowerCase().replace(/[^a-z]/g, '');
    if (w.length > 1 && NAME_STOPWORDS.has(w)) return false;
  }
  const first = parts[0].toLowerCase().replace(/[^a-z]/g, '');
  const last = parts[parts.length - 1].replace(/[^a-zA-Z]/g, '');
  if (first.length < 2 || last.length < 2) return false;
  if (strict && !FIRST_NAMES.has(first)) return false;
  return true;
}

/** { first, last, firstDisplay } lower-cased ASCII for patterns (middle initials dropped). */
export function splitName(name) {
  const { clean } = cleanPersonName(name);
  const parts = clean.replace(/\b[A-Z]\.\s*/g, '').trim().split(/\s+/).filter(Boolean);
  const ascii = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z]/g, '');
  return { first: ascii(parts[0] || ''), last: ascii(parts[parts.length - 1] || ''), firstDisplay: parts[0] || '' };
}

/**
 * A name from an address whose local part is unambiguously first.last /
 * first_last / first-last with a known first name ("john.smith" → John Smith).
 */
export function nameFromEmail(email) {
  const local = String(email || '').toLowerCase().split('@')[0];
  const m = /^([a-z]{2,15})[._-]([a-z]{2,20})$/.exec(local);
  if (!m || !FIRST_NAMES.has(m[1]) || isRoleLocal(local) || NAME_STOPWORDS.has(m[2])) return null;
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  return `${cap(m[1])} ${cap(m[2])}`;
}

/** LinkedIn profile URL slug → a name hint ("jane-smith-4b2a91" → "Jane Smith"). Never fetched. */
export function nameFromLinkedinSlug(url) {
  const m = /linkedin\.com\/in\/([a-z0-9-]+)/i.exec(String(url || ''));
  if (!m) return null;
  const parts = m[1].toLowerCase().split('-').filter((p) => /^[a-z]{2,20}$/.test(p));
  if (parts.length < 2 || !FIRST_NAMES.has(parts[0])) return null;
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  return `${cap(parts[0])} ${cap(parts[1])}`;
}

// ── email patterns ───────────────────────────────────────────────────────────

/**
 * Local-part builders. PATTERN_ORDER is the order small US companies use
 * them (Interseller, 5M+ companies: 1–10 staff {first} 71 %, {f}{last} 13 %,
 * {first}.{last} 10 %; 11–50 staff 42 / 27 / 23 % — docs/research/v2-leads-copy.md).
 */
export const PATTERNS = {
  first: (f) => f,
  'first.last': (f, l) => (l ? `${f}.${l}` : ''),
  flast: (f, l) => (l ? `${f[0]}${l}` : ''),
  firstlast: (f, l) => (l ? `${f}${l}` : ''),
  firstl: (f, l) => (l ? `${f}${l[0]}` : ''),
  'f.last': (f, l) => (l ? `${f[0]}.${l}` : ''),
  first_last: (f, l) => (l ? `${f}_${l}` : ''),
  last: (f, l) => l || '',
  lastf: (f, l) => (l ? `${l}${f[0]}` : ''),
  'last.first': (f, l) => (l ? `${l}.${f}` : ''),
};
export const PATTERN_ORDER = ['first', 'flast', 'first.last', 'firstlast', 'firstl', 'f.last', 'first_last', 'last', 'lastf', 'last.first'];

/** Which pattern `local` follows for this person, or null. */
export function patternOf(local, first, last) {
  const l = String(local || '').toLowerCase();
  if (!first || !l) return null;
  for (const p of PATTERN_ORDER) {
    const v = PATTERNS[p](first, last);
    if (v && v === l) return p;
  }
  return null;
}

/**
 * The company's address pattern from addresses we know belong to named
 * people on the same host: [{email, name}] → {pattern, from} | null.
 * Addresses whose local part is a known first name alone count as `first`.
 */
export function inferPattern(known = [], host = '') {
  const tally = new Map();
  for (const k of known) {
    const [local, dom] = String(k.email || '').toLowerCase().split('@');
    if (!local || (host && dom !== host && !String(dom).endsWith(`.${host}`)) || isRoleLocal(local)) continue;
    let p = null;
    if (k.name) { const { first, last } = splitName(k.name); p = patternOf(local, first, last); }
    if (!p && FIRST_NAMES.has(local)) p = 'first';
    if (!p) { const m = /^([a-z]{2,15})\.([a-z]{2,20})$/.exec(local); if (m && FIRST_NAMES.has(m[1])) p = 'first.last'; }
    if (!p) { const m = /^([a-z]{2,15})_([a-z]{2,20})$/.exec(local); if (m && FIRST_NAMES.has(m[1])) p = 'first_last'; }
    if (p) tally.set(p, { n: (tally.get(p)?.n || 0) + 1, from: tally.get(p)?.from || k.email });
  }
  let best = null;
  for (const [pattern, v] of tally) if (!best || v.n > best.n) best = { pattern, n: v.n, from: v.from };
  return best ? { pattern: best.pattern, from: best.from } : null;
}

/** Candidate addresses for a person: the inferred pattern first, then the usual order (max `max`). */
export function candidateEmails(first, last, host, { pattern = null, max = 5 } = {}) {
  if (!first || !host) return [];
  const order = pattern ? [pattern, ...PATTERN_ORDER.filter((p) => p !== pattern)] : PATTERN_ORDER;
  const out = [];
  for (const p of order) {
    const local = PATTERNS[p](first, last);
    if (local && /^[a-z]/.test(local)) out.push(`${local}@${host}`);
  }
  return [...new Set(out)].slice(0, pattern ? max : max);
}

// ── misc ─────────────────────────────────────────────────────────────────────

export function normCompany(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(the|inc|incorporated|llc|l l c|ltd|limited|co|corp|corporation|company|pllc|pc|lp|llp|pa)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** Meaningful words (≥ 3 letters, not filler) of an industry / company string. */
export function keywords(s) {
  const FILLER = new Set(['and', 'the', 'for', 'with', 'services', 'service', 'company', 'companies', 'business', 'businesses', 'firm', 'firms', 'local', 'small', 'inc', 'llc', 'group']);
  return [...new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !FILLER.has(w)))];
}

/** Crude singular: "plumbers" → "plumber", "companies" → "company". */
export const stem = (w) => String(w).replace(/ies$/, 'y').replace(/(ss)$/, '$1').replace(/([^s])s$/, '$1');
