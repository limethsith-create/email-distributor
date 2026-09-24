/** Registry of every client- and prospect-facing template (SPEC §11). */
import { TEMPLATES as A } from './stage-a';
import { TEMPLATES as B } from './stage-b';
import { TEMPLATES as C } from './stage-c';
import { TEMPLATES as D } from './stage-d';
import { fill } from '@/lib/templates/render';

export const TEMPLATES = { ...A, ...B, ...C, ...D };

/** Render → { subject, text, from }. Throws TemplateError on any missing slot. */
export function renderTemplate(key, vars = {}) {
  const t = TEMPLATES[key];
  if (!t) throw new Error(`unknown template ${key}`);
  return { subject: fill(key, t.subject || '', vars), text: fill(key, t.body, vars), from: t.from || 'owner' };
}
