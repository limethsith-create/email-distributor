/**
 * /mc/config API (SPEC §10.1): every config.js setting, editable with
 * validation. Admin session required (middleware).
 *   GET                              → { settings: [{key, default, value, overridden, toSet}] }
 *   POST {action:'set', key, value}  → validated save (value is JSON)
 *   POST {action:'reset', key}       → back to the default
 */

import { listSettings, saveSetting, resetSetting } from '@/lib/systems/configedit';
import { logEvent } from '@/lib/db/events';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ settings: await listSettings() });
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  try {
    if (body.action === 'set') {
      const r = await saveSetting(String(body.key), body.value);
      await logEvent(null, 'config', 'setting_changed', { key: body.key });
      return Response.json({ ok: true, ...r });
    }
    if (body.action === 'reset') {
      const r = await resetSetting(String(body.key));
      await logEvent(null, 'config', 'setting_reset', { key: body.key });
      return Response.json({ ok: true, ...r });
    }
    return Response.json({ error: 'unknown action' }, { status: 400 });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 400 });
  }
}
