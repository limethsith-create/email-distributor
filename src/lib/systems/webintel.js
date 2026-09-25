/**
 * Outside-the-website facts about an applicant (Research v3), all free and
 * public, no keys:
 *
 *  - email setup   DNS: who hosts their mail (MX), which services may send
 *                  as them (SPF includes → HubSpot, Mailchimp, SendGrid …),
 *                  their DMARC policy, and the tools that verified the domain
 *                  (TXT: Google, Microsoft, Facebook, Atlassian, DocuSign …)
 *  - web history   the Wayback Machine: when the site was first seen and in
 *                  how many months it was captured (a truer age than the
 *                  domain registration)
 *  - lookalikes    registered look-alike domains (get-, try-, -hq …) that
 *                  have mail servers and point at their site: the usual
 *                  sign that someone already cold-emails for them (the fit
 *                  gate's "nobody else emailing")
 *
 * DNS goes through `io.dns` so tests never touch the network.
 */

import { io } from '@/lib/systems/intake-io';
import { rdapLookup } from '@/lib/ext/porkbun';

/** DNS through io.dns (tests swap it); the live resolver is refused in tests, like safefetch. */
async function resolve(kind, name) {
  if (io.dns?.real && globalThis.__blockSafeFetch) throw new Error('dns blocked in tests');
  return kind === 'MX' ? io.dns.resolveMx(name, 4000) : io.dns.resolveTxt(name, 4000);
}

const MX_PROVIDERS = [
  [/aspmx\.l\.google\.com|googlemail\.com|google\.com$/i, 'Google Workspace'], [/mail\.protection\.outlook\.com|outlook\.com$/i, 'Microsoft 365'],
  [/zoho\.(com|eu)/i, 'Zoho Mail'], [/ppe-hosted\.com/i, 'Proofpoint Essentials (on top of their mail)'], [/pphosted\.com|proofpoint/i, 'Proofpoint (on top of their mail)'], [/mimecast/i, 'Mimecast (on top of their mail)'],
  [/barracudanetworks/i, 'Barracuda (on top of their mail)'], [/secureserver\.net/i, 'GoDaddy mail'], [/emailsrvr\.com/i, 'Rackspace mail'],
  [/icloud\.com/i, 'iCloud mail'], [/protonmail|proton\.me/i, 'Proton Mail'], [/mxroute|titan\.email/i, 'Titan / hosted mail'], [/ionos|1and1/i, 'IONOS mail'],
];
const SPF_TOOLS = [
  [/_spf\.google\.com/i, 'Google Workspace'], [/spf\.protection\.outlook\.com/i, 'Microsoft 365'], [/sendgrid\.net/i, 'SendGrid'], [/mailgun\.org/i, 'Mailgun'],
  [/amazonses\.com/i, 'Amazon SES'], [/servers\.mcsv\.net|mailchimp|mandrillapp/i, 'Mailchimp'], [/hubspotemail\.net|hubspot/i, 'HubSpot'], [/_spf\.salesforce\.com|exacttarget|pardot/i, 'Salesforce / Pardot'],
  [/zendesk\.com/i, 'Zendesk'], [/freshdesk|freshworks/i, 'Freshdesk'], [/mktomail\.com|marketo/i, 'Marketo'], [/constantcontact/i, 'Constant Contact'], [/activecampaign|emsd1\.com/i, 'ActiveCampaign'],
  [/zcsend\.net/i, 'Zoho Campaigns'], [/autotask\.net/i, 'Autotask (Datto PSA)'], [/connectwise/i, 'ConnectWise'], [/ppe-hosted\.com/i, 'Proofpoint Essentials'], [/zoho\.(com|eu)/i, 'Zoho'], [/intuit\.com|quickbooks/i, 'QuickBooks / Intuit'], [/stripe/i, 'Stripe'], [/mailjet/i, 'Mailjet'], [/sparkpostmail|sparkpost/i, 'SparkPost'],
  [/postmarkapp|mtasv\.net/i, 'Postmark'], [/klaviyo/i, 'Klaviyo'], [/outreach\.io/i, 'Outreach'], [/salesloft/i, 'Salesloft'], [/secureserver\.net/i, 'GoDaddy mail'],
  [/emailsrvr\.com/i, 'Rackspace'], [/pphosted\.com/i, 'Proofpoint'], [/mimecast/i, 'Mimecast'], [/smtp\.com|smtp2go/i, 'SMTP relay service'], [/docusign/i, 'DocuSign'],
];
const TXT_VERIFICATIONS = [
  [/^google-site-verification=/i, 'Google (Search Console / Workspace)'], [/^MS=/i, 'Microsoft 365'], [/^facebook-domain-verification=/i, 'Meta / Facebook'],
  [/^atlassian-domain-verification=/i, 'Atlassian (Jira / Confluence)'], [/^docusign=/i, 'DocuSign'], [/^apple-domain-verification=/i, 'Apple'], [/^adobe-idp-site-verification=/i, 'Adobe'],
  [/^zoom-domain-verification|^ZOOM_verify/i, 'Zoom'], [/^stripe-verification=/i, 'Stripe'], [/^hubspot-developer-verification=|^hubspot/i, 'HubSpot'], [/^slack-domain-verification=/i, 'Slack'],
  [/^dropbox-domain-verification=/i, 'Dropbox'], [/^box-domain-verification=/i, 'Box'], [/^knowbe4-site-verification=/i, 'KnowBe4 (security training)'], [/^mongodb-site-verification=/i, 'MongoDB'],
  [/^cisco-ci-domain-verification=/i, 'Cisco / Webex'], [/^onetrust-domain-verification=/i, 'OneTrust'], [/^pardot|^salesforce/i, 'Salesforce'], [/^zapier-domain-verification/i, 'Zapier'],
  [/^canva-site-verification=/i, 'Canva'], [/^miro-verification=/i, 'Miro'], [/^openai-domain-verification=/i, 'OpenAI'], [/^klaviyo-site-verification=/i, 'Klaviyo'], [/^airtable-verification=/i, 'Airtable'],
  [/^teamviewer-sso-verification=/i, 'TeamViewer'], [/^smartsheet-site-validation=/i, 'Smartsheet'], [/^citrix-verification-code=/i, 'Citrix'], [/^globalsign-domain-verification=/i, 'GlobalSign'],
];

/** Pure: DNS answers → the email-setup facts. */
export function emailSetupFrom({ mx = [], txt = [], dmarc = [] } = {}) {
  const hosts = mx.map((r) => String(r.exchange || r).toLowerCase()).filter(Boolean);
  const providers = [...new Set(hosts.map((h) => (MX_PROVIDERS.find(([re]) => re.test(h)) || [])[1]).filter(Boolean))];
  const records = txt.map((r) => (Array.isArray(r) ? r.join('') : String(r)));
  const spf = records.find((r) => /^v=spf1\b/i.test(r)) || null;
  const includes = spf ? [...spf.matchAll(/\b(?:include|redirect)[:=](\S+)/gi)].map((m) => m[1].toLowerCase()) : [];
  const senders = [...new Set(includes.map((i) => (SPF_TOOLS.find(([re]) => re.test(i)) || [])[1] || i))];
  const verified = [...new Set(records.map((r) => (TXT_VERIFICATIONS.find(([re]) => re.test(r)) || [])[1]).filter(Boolean))];
  const dm = dmarc.map((r) => (Array.isArray(r) ? r.join('') : String(r))).find((r) => /^v=DMARC1/i.test(r)) || null;
  const policy = dm ? ((dm.match(/;\s*p=(\w+)/i) || [])[1] || 'none').toLowerCase() : null;
  return {
    mailHost: providers[0] || (hosts.length ? hosts[0] : null),
    mailHosts: providers.length ? providers : hosts.slice(0, 3),
    spf: Boolean(spf),
    senders,
    dmarc: dm ? policy : 'missing',
    verifiedTools: verified,
  };
}

/** null when DNS could not be asked at all (unknown is not "missing"). */
export async function emailSetup(domain) {
  let answered = 0;
  const ask = (kind, name) => resolve(kind, name).then((r) => { answered += 1; return r; }, (err) => { if (/ENOTFOUND|ENODATA|NXDOMAIN/i.test(String(err?.code || err?.message))) answered += 1; return []; });
  const [mx, txt, dmarc] = await Promise.all([ask('MX', domain), ask('TXT', domain), ask('TXT', `_dmarc.${domain}`)]);
  return answered ? emailSetupFrom({ mx, txt, dmarc }) : null;
}

/** Pure: Wayback CDX rows (["timestamp"] …, first row a header) → history facts. */
export function historyFrom(rows = [], now = new Date()) {
  const stamps = rows.slice(rows[0]?.[0] === 'timestamp' ? 1 : 0).map((r) => String(Array.isArray(r) ? r[0] : r)).filter((s) => /^\d{6,14}$/.test(s)).sort();
  if (!stamps.length) return { firstSeen: null, lastSeen: null, monthsCaptured: 0, years: null };
  const d = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.length >= 8 ? s.slice(6, 8) : '01'}`;
  const first = d(stamps[0]);
  return { firstSeen: first, lastSeen: d(stamps[stamps.length - 1]), monthsCaptured: new Set(stamps.map((s) => s.slice(0, 6))).size, years: Math.max(0, Math.floor((now - Date.parse(first)) / (365.25 * 86400e3))) };
}

/** When the Wayback Machine first saw the site, and how often since (one capture per month). */
export async function webHistory(domain, { timeoutMs = 8000 } = {}) {
  const url = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(domain)}&output=json&fl=timestamp&collapse=timestamp:6&limit=600`;
  const res = await io.fetchJson(url, { service: 'wayback', timeoutMs, retry: false });
  if (!res.ok || !Array.isArray(res.json)) throw new Error(`wayback ${res.status}`);
  return historyFrom(res.json);
}

/** Look-alike names people register to send cold email for a company. */
export function lookalikeCandidates(domain) {
  const label = String(domain || '').split('.')[0].toLowerCase();
  if (!label || label.length < 3) return [];
  const names = [`get${label}`, `try${label}`, `${label}hq`, `hello${label}`, `join${label}`, `${label}team`, `${label}mail`, `meet${label}`];
  return [...new Set([...names.map((n) => `${n}.com`), `${label}.co`, `${label}.net`].filter((d) => d !== String(domain).toLowerCase()))].slice(0, 10);
}

/**
 * Registered look-alikes with mail servers; `pointsHome` when the look-alike
 * redirects to their real site (what sending domains usually do).
 */
export async function lookalikes(domain, { max = 10 } = {}) {
  const found = [];
  const cands = lookalikeCandidates(domain).slice(0, max);
  await Promise.all(cands.map(async (d) => {
    const r = await rdapLookup(d, { timeoutMs: 5000 }).catch(() => ({ status: 'unknown' }));
    if (r.status !== 'taken') return;
    const mx = await resolve('MX', d).catch(() => []);
    let pointsHome = null;
    try {
      const res = await io.fetchExt(`https://${d}/`, { timeoutMs: 6000, retry: false, redirect: 'follow', publicOnly: true, method: 'HEAD', headers: { 'user-agent': 'AvianceBot/1.0 (+aviance.online/bot)' } });
      const host = new URL(res.url || `https://${d}/`).hostname.replace(/^www\./, '');
      pointsHome = host === String(domain).replace(/^www\./, '');
    } catch { pointsHome = null; }
    found.push({ domain: d, registeredAt: r.registeredAt || null, mail: mx.length > 0, pointsHome });
  }));
  return found.sort((a, b) => Number(b.mail && b.pointsHome) - Number(a.mail && a.pointsHome));
}

/** The one-line reading of the look-alikes for the owner. */
export function outboundSignal(list = []) {
  const sending = list.filter((l) => l.mail && l.pointsHome);
  if (sending.length) return { level: 'warn', text: `${sending.map((l) => l.domain).join(', ')} ${sending.length === 1 ? 'is a look-alike domain' : 'are look-alike domains'} with mail servers pointing at their site — someone may already cold-email for them` };
  const mail = list.filter((l) => l.mail);
  if (mail.length) return { level: 'info', text: `Look-alike domain${mail.length === 1 ? '' : 's'} with mail servers: ${mail.map((l) => l.domain).join(', ')} (not pointing at their site — may belong to someone else)` };
  return null;
}
