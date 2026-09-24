/**
 * US geography for intake: state names ↔ two-letter codes, the land-border
 * neighbour map the Market Counter widens into once (SPEC §6.3), and the
 * postal-address check the onboarding page uses (US state + ZIP, SPEC §6.2).
 */

export const STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

const BY_NAME = Object.fromEntries(Object.entries(STATES).map(([c, n]) => [n.toLowerCase(), c]));

/** Land borders between states (DC with MD/VA). AK and HI have none. */
export const NEIGHBOURS = {
  AL: ['FL', 'GA', 'MS', 'TN'], AK: [], AZ: ['CA', 'CO', 'NM', 'NV', 'UT'], AR: ['LA', 'MO', 'MS', 'OK', 'TN', 'TX'],
  CA: ['AZ', 'NV', 'OR'], CO: ['AZ', 'KS', 'NE', 'NM', 'OK', 'UT', 'WY'], CT: ['MA', 'NY', 'RI'], DE: ['MD', 'NJ', 'PA'],
  DC: ['MD', 'VA'], FL: ['AL', 'GA'], GA: ['AL', 'FL', 'NC', 'SC', 'TN'], HI: [], ID: ['MT', 'NV', 'OR', 'UT', 'WA', 'WY'],
  IL: ['IA', 'IN', 'KY', 'MO', 'WI'], IN: ['IL', 'KY', 'MI', 'OH'], IA: ['IL', 'MN', 'MO', 'NE', 'SD', 'WI'],
  KS: ['CO', 'MO', 'NE', 'OK'], KY: ['IL', 'IN', 'MO', 'OH', 'TN', 'VA', 'WV'], LA: ['AR', 'MS', 'TX'], ME: ['NH'],
  MD: ['DC', 'DE', 'PA', 'VA', 'WV'], MA: ['CT', 'NH', 'NY', 'RI', 'VT'], MI: ['IN', 'OH', 'WI'],
  MN: ['IA', 'ND', 'SD', 'WI'], MS: ['AL', 'AR', 'LA', 'TN'], MO: ['AR', 'IA', 'IL', 'KS', 'KY', 'NE', 'OK', 'TN'],
  MT: ['ID', 'ND', 'SD', 'WY'], NE: ['CO', 'IA', 'KS', 'MO', 'SD', 'WY'], NV: ['AZ', 'CA', 'ID', 'OR', 'UT'],
  NH: ['MA', 'ME', 'VT'], NJ: ['DE', 'NY', 'PA'], NM: ['AZ', 'CO', 'OK', 'TX', 'UT'], NY: ['CT', 'MA', 'NJ', 'PA', 'VT'],
  NC: ['GA', 'SC', 'TN', 'VA'], ND: ['MN', 'MT', 'SD'], OH: ['IN', 'KY', 'MI', 'PA', 'WV'], OK: ['AR', 'CO', 'KS', 'MO', 'NM', 'TX'],
  OR: ['CA', 'ID', 'NV', 'WA'], PA: ['DE', 'MD', 'NJ', 'NY', 'OH', 'WV'], RI: ['CT', 'MA'], SC: ['GA', 'NC'],
  SD: ['IA', 'MN', 'MT', 'ND', 'NE', 'WY'], TN: ['AL', 'AR', 'GA', 'KY', 'MO', 'MS', 'NC', 'VA'],
  TX: ['AR', 'LA', 'NM', 'OK'], UT: ['AZ', 'CO', 'ID', 'NM', 'NV', 'WY'], VT: ['MA', 'NH', 'NY'],
  VA: ['DC', 'KY', 'MD', 'NC', 'TN', 'WV'], WA: ['ID', 'OR'], WV: ['KY', 'MD', 'OH', 'PA', 'VA'],
  WI: ['IA', 'IL', 'MI', 'MN'], WY: ['CO', 'ID', 'MT', 'NE', 'SD', 'UT'],
};

/** 'TX' | 'texas' | ' Texas ' → 'TX'; anything else → null. */
export function stateCode(s) {
  const v = String(s || '').trim();
  if (!v) return null;
  if (v.length === 2 && STATES[v.toUpperCase()]) return v.toUpperCase();
  return BY_NAME[v.toLowerCase()] || null;
}

/** Neighbours of the given states that are not already in the list. */
export function neighboursOf(codes) {
  const have = new Set(codes);
  const out = [];
  for (const c of codes) for (const n of NEIGHBOURS[c] || []) if (!have.has(n) && !out.includes(n)) out.push(n);
  return out;
}

/** State code found in a 'City, ST' string, else null. */
export function stateOfCity(city) {
  const parts = String(city || '').split(',').map((s) => s.trim());
  return parts.length > 1 ? stateCode(parts[parts.length - 1].split(/\s+/)[0]) || stateCode(parts[parts.length - 1]) : null;
}

const ZIP_RE = /\b\d{5}(?:-\d{4})?\b/;
const CODE_RE = new RegExp(`\\b(${Object.keys(STATES).join('|')})\\b`);

/** True when the address names a US state (code or full name) and has a ZIP. */
export function isUsPostalAddress(address) {
  const s = String(address || '');
  if (!ZIP_RE.test(s)) return false;
  if (CODE_RE.test(s)) return true;
  const lower = s.toLowerCase();
  return Object.keys(BY_NAME).some((name) => lower.includes(name));
}
