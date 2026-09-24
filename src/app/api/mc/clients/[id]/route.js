import { kv } from '@vercel/kv';
import { K, assertClientId } from '@/lib/db/keys';
import { getClient, getProfile, getTrial, getDomain, setState, STATES } from '@/lib/db/client';
import { getInboxRecords, saveInbox, removeInbox, patchInbox } from '@/lib/db/inboxes';
import { getEvents, logEvent } from '@/lib/db/events';
import { runTick } from '@/lib/scheduler';
import { JOBS } from '@/lib/jobs';
import { hasEncKey } from '@/lib/crypto';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Profile fields the owner may edit here (SPEC §3 client:{id}:profile).
const PROFILE_FIELDS = ['senderName', 'senderTitle', 'senderPrefix', 'postalAddress', 'calendarUrl', 'defaultNiche', 'defaultIcp', 'sellsTo', 'industry', 'capacityPerWeek', 'winCondition'];

function publicInbox(r) {
  const { passwordEnc, ...rest } = r;
  return { ...rest, hasPassword: Boolean(passwordEnc) };
}

export async function GET(_req, { params }) {
  const id = assertClientId(params.id);
  const client = await getClient(id);
  if (!client) return Response.json({ error: 'not found' }, { status: 404 });
  const [profile, trial, domain, inboxes, events] = await Promise.all([getProfile(id), getTrial(id), getDomain(id), getInboxRecords(id), getEvents(id, 150)]);
  const jobs = {};
  for (const j of JOBS.filter((x) => x.scope === 'client')) {
    try { jobs[j.name] = await kv.get(K.jobLast(j.name, id)); } catch { jobs[j.name] = null; }
  }
  return Response.json({ client, profile, trial, domain, inboxes: inboxes.map(publicInbox), events, jobs, states: STATES, profileFields: PROFILE_FIELDS, encKey: hasEncKey() });
}

export async function POST(request, { params }) {
  const id = assertClientId(params.id);
  if (!(await getClient(id))) return Response.json({ error: 'not found' }, { status: 404 });
  const body = await request.json().catch(() => ({}));
  switch (body.action) {
    case 'profile': {
      const fields = {};
      for (const f of PROFILE_FIELDS) if (typeof body.fields?.[f] === 'string') fields[f] = body.fields[f].trim();
      await kv.hset(K.profile(id), fields);
      await logEvent(id, 'mc', 'profile_updated', { fields: Object.keys(fields) });
      return Response.json({ ok: true });
    }
    case 'addInbox': {
      if (!hasEncKey()) return Response.json({ error: 'ENC_KEY is not set on the server, so passwords cannot be stored safely yet.' }, { status: 503 });
      const rec = await saveInbox(id, { email: body.email, password: body.password, displayName: body.displayName, provider: body.provider || 'google', enabled: false });
      return Response.json({ ok: true, inbox: publicInbox(rec) });
    }
    case 'removeInbox':
      await removeInbox(id, body.email);
      return Response.json({ ok: true });
    case 'inboxEnabled':
      await patchInbox(id, body.email, { enabled: body.enabled ? '1' : '0' });
      if (id === 'aviance') await kv.hset('inbox_enabled', { [String(body.email).toLowerCase()]: body.enabled ? '1' : '0' });
      await logEvent(id, 'mc', 'inbox_switched', { email: body.email, enabled: Boolean(body.enabled) });
      return Response.json({ ok: true });
    case 'setState': {
      const changed = await setState(id, body.to, body.reason || 'owner (Mission Control)', { force: Boolean(body.force) });
      return Response.json({ ok: true, changed });
    }
    case 'runJob': {
      const result = await runTick({ source: 'mc', only: body.job, clientId: id, force: true });
      return Response.json({ ok: true, result });
    }
    default:
      return Response.json({ error: 'unknown action' }, { status: 400 });
  }
}
