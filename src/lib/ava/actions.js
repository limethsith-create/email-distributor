/**
 * What Ava may offer the hub (docs/HUB-API.md "Ava (AI helper)"):
 *   navigate {view, id?, tab?, section?} — the hub opens it at once
 *            (client → id + tab; settings → section),
 *   read {what:'page'}                   — the hub reads out what is on the
 *            screen now, on the device (no page data comes to the machine),
 *   confirm  — a button the user must press,
 *   draft    — text to copy.
 * Ava never does a write herself. A team member gets no owner-only views,
 * tabs or buttons.
 */

export const VIEWS = ['trials', 'paying', 'calendar', 'team', 'mystats', 'activity', 'inquiries', 'behind', 'settings', 'client'];
export const OWNER_VIEWS = new Set(['activity', 'settings']);
/** A client's email system: five shared tabs (the client sees them too) and four "Only you" tabs (the owner's). */
export const SHARED_TABS = ['overview', 'conversations', 'sent', 'calls', 'messages'];
export const OWNER_TAB_LIST = ['money', 'health', 'leads', 'setup'];
export const CLIENT_TABS = [...SHARED_TABS, ...OWNER_TAB_LIST];
export const OWNER_TABS = new Set(OWNER_TAB_LIST);
/** Old or spoken tab names → the tab that holds them now (the hub's TK_TAB_ALIAS). */
export const TAB_ALIAS = {
  numbers: 'overview', stats: 'overview', convos: 'conversations', replies: 'conversations', emails: 'sent', 'emails-sent': 'sent',
  plan: 'money', invoice: 'money', invoices: 'money', payments: 'money',
  growth: 'health', deliverability: 'health', inboxes: 'health', warmup: 'health', autobuy: 'health',
  copy: 'leads', sequence: 'leads', comingup: 'leads', promises: 'leads', upcoming: 'leads', reports: 'leads',
  systems: 'setup', parts: 'setup', timeline: 'setup', history: 'setup', actions: 'setup', application: 'setup', access: 'setup',
};
/** Settings sections (the hub's TK_SETTINGS). All owner-only (Settings is). */
export const SETTINGS_SECTIONS = ['alerts', 'phone', 'details', 'keys', 'ava', 'google', 'inboxes', 'warmup', 'replybot', 'demo', 'status', 'behind', 'advanced', 'look', 'account'];
export const SECTION_ALIAS = { theme: 'look', dark: 'look', light: 'look', meet: 'google', 'test-run': 'demo', testrun: 'demo', 'warm-up': 'warmup', helpers: 'warmup', 'reply-bot': 'replybot', notifications: 'phone', health: 'status', running: 'status' };
/** What `read` may read: the page on screen (the hub reads its own screen out loud — nothing comes to the machine). */
export const READ_WHAT = ['page'];
/**
 * Where things are — every place Ava can open, one line each (the system
 * prompt's map and kb.md "Where things are" say the same).
 */
export const PLACES = {
  views: {
    trials: 'Trials — every trial client: Needs you, In progress, Done; stage tiles; add a trial client',
    paying: 'Paying clients — Starter/Growth/Scale clients, new paid applications, money received (owner)',
    calendar: 'Calendar — every call (Sri Lanka + US Eastern), call times waiting for a yes',
    team: 'Team — who is in the hub, their status line, who looks after which clients',
    mystats: "My stats — Aviance's own outreach: sent, opens, replies, bounces, per inbox; Saved history",
    activity: 'Activity (owner) — sign-ins, what people opened, accounts waiting for approval',
    inquiries: 'Plan call requests — people who booked a call for a paid plan (Open, Won, Lost)',
    behind: 'Behind the scenes — every to-do, every trial by stage, the waiting list',
    settings: 'Settings (owner) — the sections below',
    client: "One client (id) — the client page and their email system's tabs below",
  },
  tabs: {
    overview: 'Overview (shared) — sent, opened, replies, bounced, interested, calls booked, per day',
    conversations: 'Conversations (shared) — every reply thread with a prospect',
    sent: 'Emails sent (shared) — the emails that went out',
    calls: 'Calls (shared) — booked and qualified calls, no-shows',
    messages: "Messages (shared) — the owner's emails with the client, the reply box",
    money: 'Money & plan (only you, owner) — plan, invoice, paid or not',
    health: 'Health (only you) — inboxes, warm-up, inbox rate, deliverability, growth, auto-buy',
    leads: 'Leads & emails (only you) — lead grades, email checks, the copy, reply types, coming up',
    setup: 'Setup & history (only you) — who can see their page (give access), application, onboarding/launch calls, disputes, parts, history, actions',
  },
  sections: {
    alerts: 'Alerts — every machine message, not seen first',
    phone: 'Phone alerts — notifications on the phone',
    details: "Your details — signer name, postal address, call link, PayPal/Wise",
    keys: 'Keys — every service key (Groq, Cloudflare, Mistral, Ollama, Tavily, Places, verifiers, GitHub…)',
    ava: "Ava — her brains and models, voice, Business facts, change requests",
    google: 'Google Meet — connect Google for Meet links',
    inboxes: 'Inboxes & domains — CheapInboxes auto-buy',
    warmup: 'Warm-up — warm-up helper inboxes',
    replybot: 'Reply bot — automatic replies',
    demo: 'Test run — load or remove example clients',
    status: 'Is everything running? — the health check',
    behind: 'Behind the scenes — the machine board',
    advanced: 'Advanced — Mission Control, config',
    look: 'Light or dark — the theme',
    account: 'Your account — log out',
  },
};

/** The map for the prompt (a team member gets no owner-only places). */
export function placesMap(role) {
  const owner = role === 'admin';
  const L = ['Where things are (propose_action navigate):'];
  L.push(`- views: ${Object.entries(PLACES.views).filter(([k]) => owner || !OWNER_VIEWS.has(k)).map(([k, v]) => `${k} = ${v.split(' — ')[0]}`).join('; ')}.`);
  L.push(`- client tabs (view client + id + tab): ${Object.entries(PLACES.tabs).filter(([k]) => owner || !OWNER_TABS.has(k)).map(([k, v]) => `${k} = ${v.split(' — ')[1]}`).join('; ')}.`);
  if (owner) L.push(`- settings sections (view settings + section): ${Object.entries(PLACES.sections).map(([k, v]) => `${k} = ${v.split(' — ')[0]}`).join('; ')}.`);
  return L.join('\n');
}

export const CONFIRMS = ['open_add_trial', 'open_add_paid', 'open_client', 'mark_todo_seen', 'give_access', 'load_test_run', 'remove_test_run', 'set_my_status', 'add_change_request'];
export const EMPLOYEE_CONFIRMS = new Set(['open_client', 'set_my_status', 'add_change_request']);

const key = (v) => String(v ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
/** A client tab as named (or an old name for it) → the tab key, or null. */
export function clientTab(t) {
  const k = key(t);
  if (!k) return null;
  if (CLIENT_TABS.includes(k)) return k;
  return TAB_ALIAS[k] || TAB_ALIAS[k.replace(/-/g, '')] || null;
}
/** A Settings section as named → its key, or null. */
export function settingsSection(t) {
  const k = key(t);
  if (!k) return null;
  if (SETTINGS_SECTIONS.includes(k)) return k;
  return SECTION_ALIAS[k] || (SETTINGS_SECTIONS.includes(k.replace(/-/g, '')) ? k.replace(/-/g, '') : null);
}

const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
export const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

/** Only the actions the hub knows, with clean args, and only what this role may do (at most 4). */
export function cleanActions(list, role) {
  const owner = role === 'admin';
  const out = [];
  for (const a of Array.isArray(list) ? list : []) {
    if (!a || typeof a !== 'object') continue;
    if (a.type === 'navigate') {
      const view = String(a.view || '');
      if (!VIEWS.includes(view) || (!owner && OWNER_VIEWS.has(view))) continue;
      const nav = { type: 'navigate', view };
      if (a.id != null && ID_RE.test(String(a.id))) nav.id = String(a.id);
      if (view === 'client' && !nav.id) continue;
      if (view !== 'client') delete nav.id;
      if (view === 'client') {
        const tab = clientTab(a.tab);
        // An "Only you" tab is dropped for a team member (they get the client's overview).
        if (tab && (owner || !OWNER_TABS.has(tab))) nav.tab = tab;
      }
      if (view === 'settings') {
        // `section` (the contract); older answers put it in `tab`.
        const sec = settingsSection(a.section ?? a.tab);
        if (sec) nav.section = sec;
      }
      out.push(nav);
    } else if (a.type === 'read') {
      const what = String(a.what || 'page');
      if (!READ_WHAT.includes(what)) continue;
      if (out.some((x) => x.type === 'read')) continue;
      out.push({ type: 'read', what });
    } else if (a.type === 'confirm') {
      const name = String(a.name || '');
      if (!CONFIRMS.includes(name) || (!owner && !EMPLOYEE_CONFIRMS.has(name))) continue;
      const src = a.args && typeof a.args === 'object' ? a.args : {};
      const args = {};
      if (['open_client', 'mark_todo_seen', 'give_access'].includes(name)) {
        if (!ID_RE.test(String(src.id || ''))) continue;
        args.id = String(src.id);
      }
      if (name === 'mark_todo_seen') { const t = str(src.todoId, 160); if (!t) continue; args.todoId = t; }
      if (name === 'set_my_status') args.text = str(src.text, 140);
      if (name === 'add_change_request') { args.text = str(src.text, 1000); if (!args.text) continue; }
      out.push({ type: 'confirm', label: str(a.label, 80) || name.replace(/_/g, ' '), name, args });
    } else if (a.type === 'draft') {
      const text = String(a.text ?? '').trim().slice(0, 4000);
      if (!text) continue;
      out.push({ type: 'draft', title: str(a.title, 100) || 'Draft', text });
    }
    if (out.length >= 4) break;
  }
  // Read after the page it reads has opened.
  const r = out.findIndex((x) => x.type === 'read');
  if (r >= 0 && r < out.length - 1) out.push(...out.splice(r, 1));
  return out;
}

/**
 * propose_action {name, args, label} → one action (or null): name `navigate`
 * (args {view, id?, tab?, section?}), `read` (args {what: 'page'}), `draft`
 * (args {title, text}) or a confirm name.
 */
export function proposalToAction({ name, args, label } = {}, role) {
  const n = String(name || '');
  const a = args && typeof args === 'object' ? args : {};
  let raw;
  if (n === 'navigate') raw = { type: 'navigate', view: a.view, id: a.id, tab: a.tab, section: a.section };
  else if (n === 'read') raw = { type: 'read', what: a.what || 'page' };
  else if (n === 'draft') raw = { type: 'draft', title: a.title || label, text: a.text };
  else raw = { type: 'confirm', name: n, args: a, label };
  return cleanActions([raw], role)[0] || null;
}
