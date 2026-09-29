/**
 * What Ava may offer the hub (docs/HUB-API.md "Ava (AI helper)"): `navigate`
 * (the hub opens it at once), `confirm` (a button the user must press) and
 * `draft` (text to copy). Ava never does a write herself. A team member gets
 * no owner-only views, tabs or buttons.
 */

export const VIEWS = ['trials', 'paying', 'calendar', 'team', 'mystats', 'activity', 'inquiries', 'behind', 'settings', 'client'];
export const OWNER_VIEWS = new Set(['activity', 'settings']);
export const CLIENT_TABS = ['overview', 'conversations', 'emails', 'calls', 'messages', 'money', 'health', 'leads', 'setup', 'history'];
export const OWNER_TABS = new Set(['money', 'health', 'leads', 'setup']);
export const SETTINGS_SECTIONS = ['alerts', 'phone', 'details', 'keys', 'ava', 'google', 'inboxes', 'warmup', 'replybot', 'demo', 'status', 'behind', 'advanced', 'theme', 'account'];
export const CONFIRMS = ['open_add_trial', 'open_add_paid', 'open_client', 'mark_todo_seen', 'give_access', 'load_test_run', 'remove_test_run', 'set_my_status', 'add_change_request'];
export const EMPLOYEE_CONFIRMS = new Set(['open_client', 'set_my_status', 'add_change_request']);

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
      const tab = a.tab == null ? null : String(a.tab);
      if (tab && view === 'client' && CLIENT_TABS.includes(tab) && (owner || !OWNER_TABS.has(tab))) nav.tab = tab;
      if (tab && view === 'settings' && SETTINGS_SECTIONS.includes(tab)) nav.tab = tab;
      out.push(nav);
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
  return out;
}

/**
 * propose_action {name, args, label} → one action (or null): name `navigate`
 * (args {view, id?, tab?}), `draft` (args {title, text}) or a confirm name.
 */
export function proposalToAction({ name, args, label } = {}, role) {
  const n = String(name || '');
  const a = args && typeof args === 'object' ? args : {};
  let raw;
  if (n === 'navigate') raw = { type: 'navigate', view: a.view, id: a.id, tab: a.tab };
  else if (n === 'draft') raw = { type: 'draft', title: a.title || label, text: a.text };
  else raw = { type: 'confirm', name: n, args: a, label };
  return cleanActions([raw], role)[0] || null;
}
