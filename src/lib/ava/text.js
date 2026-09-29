/**
 * Ava's personal-data net (docs/HUB-API.md "Ava (AI helper)"): email
 * addresses, phone numbers and links are removed from every string that goes
 * to an AI or search service, and the clients' contact people's names become
 * "the client".
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { getAllClients } from '@/lib/db/client';

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const AT_RE = /\S*@\S+/g;
const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
const PHONE_RE = /(?:\+?\d[\d\s().-]{6,}\d)/g;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The words to hide: every client's contact person (whole name, first and last). */
export async function personNames() {
  const clients = await getAllClients(null, { includeDemo: true }).catch(() => []);
  const set = new Set();
  for (const c of clients) {
    const n = String(c.contactName || '').trim();
    if (!n) continue;
    set.add(n);
    for (const part of n.split(/\s+/)) if (part.length >= 3) set.add(part);
  }
  return [...set].sort((a, b) => b.length - a.length);
}

let prospectsMemo = { at: 0, names: null };
export const __resetProspectNames = () => { prospectsMemo = { at: 0, names: null }; };

/**
 * The prospects' names across every client's leads (first, last, whole) —
 * for what leaves the machine to a search service. Read at most every 10
 * minutes per instance (one hash per client).
 */
export async function prospectNames(now = Date.now()) {
  if (prospectsMemo.names && now - prospectsMemo.at < 10 * 60e3) return prospectsMemo.names;
  const set = new Set();
  const add = (n) => { const t = String(n || '').trim(); if (!t || t.length < 3) return; set.add(t); for (const p of t.split(/\s+/)) if (p.length >= 3) set.add(p); };
  const clients = await getAllClients(null, { includeDemo: true }).catch(() => []);
  for (const c of clients) {
    let map = {};
    try { map = (await kv.hgetall(K.leads(c.id))) || {}; } catch { map = {}; }
    for (const v of Object.values(map)) {
      let l = v;
      if (typeof l === 'string') { try { l = JSON.parse(l); } catch { l = null; } }
      if (!l || typeof l !== 'object') continue;
      add(l.first_name ?? l.firstName); add(l.last_name ?? l.lastName); add(l.name); add(l.attendeeName);
    }
  }
  const names = [...set].filter((n) => /^[A-Z]/.test(n)).sort((a, b) => b.length - a.length);
  prospectsMemo = { at: now, names };
  return names;
}

/** One string, cleaned. Dates like 2026-10-06 and times survive the phone rule (it needs 8+ digits in a row-ish run). */
export function cleanText(s, names = []) {
  let t = String(s ?? '');
  t = t.replace(URL_RE, '[link]').replace(EMAIL_RE, '[email]').replace(AT_RE, '[email]');
  t = t.replace(PHONE_RE, (m) => ((m.match(/\d/g) || []).length >= 8 && !/^\d{4}-\d{2}-\d{2}/.test(m.trim()) ? '[phone]' : m));
  for (const n of names) t = t.replace(new RegExp(`\\b${esc(n)}\\b(?:'s)?`, 'g'), 'the client');
  return t;
}

/** Deep: every string in an answer goes through cleanText. */
export function clean(v, names = []) {
  if (typeof v === 'string') return cleanText(v, names);
  if (Array.isArray(v)) return v.map((x) => clean(x, names));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x, names)]));
  return v;
}
