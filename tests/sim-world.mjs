// A stubbed world for whole-trial simulations (tests/full-run.test.mjs).
// Every network piece is replaced: SMTP (nodemailer), IMAP (Stage C scans,
// warm-up/canary reads, Stage A loopback), DNS, fetch (Places, RDAP, Porkbun,
// GitHub, calendar pages). Mail really "arrives": warm-up and canary mail
// lands in the receiver's mailbox, prospect replies and calendar invites are
// queued into the trial inbox the Reply Handler / Booking Watcher scan.
import crypto from 'node:crypto';
import dnsPromises from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import nodemailer from 'nodemailer';
import { setDeps, resetDeps } from '@/lib/systems/stagec-common';
import { net as warmNet } from '@/lib/systems/warmup';
import { io } from '@/lib/systems/intake-io';

export const sim = {
  now: new Date(),
  sent: [],        // every SMTP message { from, to, subject, text, messageId, at }
  inbound: {},     // trial inbox → [{ uid, ...meta }]
  warmBoxes: {},   // warm-up/canary mailboxes
  fetches: [],
};
let uid = 1000;

function addressOf(v) {
  if (!v) return '';
  if (typeof v === 'string') { const m = /<([^>]+)>/.exec(v); return (m ? m[1] : v).trim().toLowerCase(); }
  return String(v.address || '').toLowerCase();
}

/** Deterministic Math.random for the simulation (mulberry32), so a run is repeatable. */
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function installWorld({ seed = 20261005 } = {}) {
  // Pacing jitter, inbox tie-breaks and warm-up pairing all use Math.random;
  // the milestone fixture compares an exact event order, so the run must be too.
  Math.random = seededRandom(seed);
  sim.sent = []; sim.inbound = {}; sim.warmBoxes = {}; sim.fetches = [];
  process.env.ENC_KEY = process.env.ENC_KEY || crypto.randomBytes(32).toString('base64');
  process.env.CRON_SECRET = 'sim-secret';
  process.env.OWNER_INBOX = 'owner@aviance.test:app-pw:Owner';
  process.env.OWNER_EMAIL = 'owner@aviance.test';
  process.env.PLACES_API_KEY = 'places-key';
  process.env.GITHUB_TOKEN = 'gh-token';
  process.env.PUBLIC_BASE_URL = 'https://sim.test';
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.HC_PING_URL;
  delete process.env.PORKBUN_API_KEY;

  // Belt and braces: any code path that still reaches for real DNS or a real
  // socket (SMTP/IMAP) fails loudly instead of touching the network.
  for (const fn of ['resolveMx', 'resolveTxt', 'resolve4', 'resolve6', 'resolve', 'lookup']) {
    try { dnsPromises[fn] = async (name) => { throw new Error(`real DNS blocked in the simulation: ${fn} ${name}`); }; } catch {}
  }
  net.connect = net.createConnection = () => { throw new Error('real socket blocked in the simulation'); };
  tls.connect = () => { throw new Error('real TLS socket blocked in the simulation'); };

  // SMTP: everything the machine sends.
  nodemailer.createTransport = (opts = {}) => ({
    async sendMail(m) {
      const messageId = `<${crypto.randomUUID()}@sim>`;
      sim.sent.push({ from: addressOf(m.from) || String(opts.auth?.user || ''), to: addressOf(m.to), subject: m.subject, text: m.text || '', messageId, at: sim.now.toISOString(), headers: m.headers || {} });
      return { messageId, response: '250 OK' };
    },
    async verify() { return true; },
    close() {},
  });

  // Stage C: SMTP through the mailer (stub above), IMAP scans from sim.inbound,
  // MX checks always pass.
  resetDeps();
  setDeps({
    verifyEmail: async () => ({ valid: true, reason: 'mx_verified' }),
    scanMailbox: async (account, { uidState = {} } = {}) => {
      const box = sim.inbound[account.email] || [];
      const last = Number(uidState?.INBOX?.lastUid) || 0;
      const messages = box.filter((m) => m.uid > last);
      const maxUid = Math.max(last, ...box.map((m) => m.uid));
      return { ok: true, messages, uidState: { INBOX: { uidValidity: '1', lastUid: maxUid } } };
    },
  });

  // Warm-up + canary: sends land in the receiver's INBOX.
  warmNet.send = async (account, mail) => {
    const b = (sim.warmBoxes[mail.to] ||= { INBOX: [], '[Gmail]/Spam': [], '[Gmail]/All Mail': [] });
    const id = `<${crypto.randomUUID()}@warm>`;
    b.INBOX.push({ uid: ++uid, envelope: { messageId: id, from: [{ address: account.email }], subject: mail.subject }, headers: `X-Aviance-Warm: ${mail.headers['X-Aviance-Warm']}\r\nMessage-ID: ${id}\r\n` });
    return { success: true, messageId: id };
  };
  warmNet.imap = async (account) => {
    const b = (sim.warmBoxes[account.email] ||= { INBOX: [], '[Gmail]/Spam': [], '[Gmail]/All Mail': [] });
    let cur = 'INBOX';
    return {
      async connect() {}, async logout() {},
      async list() { return [{ path: 'INBOX' }, { path: '[Gmail]/Spam', specialUse: '\\Junk' }, { path: '[Gmail]/All Mail', specialUse: '\\All' }]; },
      async getMailboxLock(p) { cur = p; b[p] ||= []; return { release() {} }; },
      async search(q) { const want = String(q.header['x-aviance-warm'] || '').toLowerCase(); return b[cur].filter((m) => m.headers.toLowerCase().includes(want)).map((m) => m.uid); },
      async *fetch(uids) { for (const m of [...b[cur]]) if (uids.includes(m.uid)) yield m; },
      async messageFlagsAdd() {},
      async messageMove(u, dest) { const i = b[cur].findIndex((x) => x.uid === u); if (i >= 0) { const [m] = b[cur].splice(i, 1); b[dest].push(m); } },
    };
  };

  // Stage A: DNS all correct for the trial domain, SMTP/IMAP logins fine,
  // loopback found with passing auth headers, calendar page is Cal.com.
  const notFound = () => Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  io.now = () => sim.now;
  io.dns = {
    resolveTxt: async (n) => {
      if (/^google\._domainkey\./.test(n)) return [['v=DKIM1; k=rsa; p=MIIB']];
      if (/^_dmarc\./.test(n)) return [[`v=DMARC1; p=none; rua=mailto:dmarc@${n.replace(/^_dmarc\./, '')}`]];
      if (/^[a-z0-9-]+\.[a-z]+$/.test(n)) return [['v=spf1 include:_spf.google.com ~all']];
      throw notFound();
    },
    resolveMx: async () => [{ exchange: 'smtp.google.com', priority: 1 }],
    resolve4: async (n) => { if (/\.(bl|b|dnsbl|spam)\./.test(n) || /spamcop|barracuda|sorbs/.test(n)) throw notFound(); return ['203.0.113.5']; },
  };
  io.smtpVerify = async () => ({ success: true });
  io.imapLogin = async () => ({ ok: true, spamFolderExists: true });
  io.imapFindMessage = async (acct, token) => ({ found: true, folder: 'INBOX', headers: `Subject: Setup check ${token}\r\nAuthentication-Results: mx.google.com; dkim=pass; spf=pass` });
  io.imapFetchAttachments = async () => ({ ok: true, messages: [], maxUid: 0, more: false });
  // The trial domain redirects to the client's main site (setup check 10);
  // every other page (calendar link, website) answers 200.
  io.fetchExt = async (url) => {
    const u = String(url);
    const final = /testmode-team\.com/.test(u) ? 'https://aviance-test.invalid/' : u;
    return { ok: true, status: 200, url: final, text: async () => '<html><title>Cal.com</title> cal.com booking page</html>', json: async () => ({}) };
  };

  // The rest of the internet.
  let placeN = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    sim.fetches.push(u);
    if (u.includes('places.googleapis.com')) {
      placeN++;
      const ids = Array.from({ length: 20 }, (_, i) => ({ id: `p${placeN}-${i}`, displayName: { text: `Place ${placeN}-${i}` } }));
      return new Response(JSON.stringify({ places: ids, nextPageToken: placeN % 3 ? 'more' : undefined }), { status: 200 });
    }
    if (u.includes('rdap.org')) return new Response('not found', { status: 404 });
    if (u.includes('porkbun.com')) return new Response(JSON.stringify({ status: 'SUCCESS', pricing: { com: { registration: '10.37', renewal: '11.08' }, net: { registration: '12.52' }, co: { registration: '11.00' } } }), { status: 200 });
    if (u.includes('api.github.com')) return new Response(null, { status: 204 });
    throw new Error(`unexpected network call in the simulation: ${u.slice(0, 100)}`);
  };
}

/** Queue a message into a trial inbox (a prospect reply, a DSN, a calendar invite). */
export function deliver(inbox, meta) {
  const box = (sim.inbound[inbox] ||= []);
  const m = { uid: ++uid, folder: 'INBOX', inbox, messageId: `<in-${uid}@sim>`, date: sim.now.toISOString(), headers: {}, threadIds: [], kind: 'human', text: '', ...meta };
  box.push(m);
  return m;
}

/** Sent mail helpers. */
export const sentTo = (to) => sim.sent.filter((m) => m.to === String(to).toLowerCase());
export const tokenIn = (text, page) => {
  const m = new RegExp(`/c/([A-Za-z0-9_-]{20,})/${page}`).exec(String(text || ''));
  return m ? m[1] : null;
};
