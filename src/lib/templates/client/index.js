/** Registry of every client- and prospect-facing template (SPEC §11). */
import { TEMPLATES as A } from './stage-a';
import { TEMPLATES as B } from './stage-b';
import { TEMPLATES as C } from './stage-c';
import { TEMPLATES as D } from './stage-d';
import { fill } from '@/lib/templates/render';

export const TEMPLATES = { ...A, ...B, ...C, ...D };

const squash = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * "in your name" when the emails go out in the contact's own name (the usual
 * case: Dana's trial sends as Dana), else "in Sam Carter's name". null
 * without a sender name.
 */
export function inWhoseName({ senderName, contactName } = {}) {
  const s = squash(senderName);
  if (!s) return null;
  const c = squash(contactName);
  const own = c && (s === c || (!s.includes(' ') && s === c.split(' ')[0]));
  return own ? 'in your name' : `in ${String(senderName).trim()}'s name`;
}

/** Render → { subject, text, from }. Throws TemplateError on any missing slot. */
export function renderTemplate(key, vars = {}) {
  const t = TEMPLATES[key];
  if (!t) throw new Error(`unknown template ${key}`);
  // A trial sends in the client's own name unless another sender is named.
  const v = vars.inWhoseName ? vars : { ...vars, inWhoseName: inWhoseName(vars) || 'in your name' };
  return { subject: fill(key, t.subject || '', v), text: fill(key, t.body, v), from: t.from || 'owner' };
}
