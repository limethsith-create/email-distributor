import { kv } from '@vercel/kv';
import { K, assertClientId } from '@/lib/db/keys';
import { getClient, getProfile, getTrial, getDomain, setState, STATES } from '@/lib/db/client';
import { getInboxRecords, saveInbox, removeInbox, patchInbox, publicInbox } from '@/lib/db/inboxes';
import { getEvents, logEvent } from '@/lib/db/events';
import { runTick, jobRecords } from '@/lib/scheduler';
import { JOBS } from '@/lib/jobs';
import { hasEncKey } from '@/lib/crypto';
import { clientExtras } from '@/lib/systems/clientview';
import { addOwnerNote, completePromise } from '@/lib/systems/promiseregister';
import { markInboxesCancelled } from '@/lib/systems/wrapup';
import { markPaid } from '@/lib/systems/invoice';
import { patchTrial, recordLedger } from '@/lib/systems/dshared';
import { ackAlerts } from '@/lib/notify';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Profile fields the owner may edit here (SPEC §3 client:{id}:profile).
const PROFILE_FIELDS = ['senderName', 'senderTitle', 'senderPrefix', 'postalAddress', 'calendarUrl', 'defaultNiche', 'defaultIcp', 'sellsTo', 'industry', 'capacityPerWeek', 'winCondition'];

export async function GET(_req, { params }) {
  const id = assertClientId(params.id);
  const client = await getClient(id);
  if (!client) return Response.json({ error: 'not found' }, { status: 404 });
  const [profile, trial, domain, inboxes, events, extras] = await Promise.all([getProfile(id), getTrial(id), getDomain(id), getInboxRecords(id), getEvents(id, 150), clientExtras(client)]);
  // Last runs live in the client hash (jl:{job}), written by the scheduler.
  const last = jobRecords(client);
  const jobs = {};
  for (const j of JOBS.filter((x) => x.scope === 'client')) jobs[j.name] = last[j.name] || null;
  return Response.json({ client, profile, trial, domain, inboxes: inboxes.map(publicInbox), events, jobs, states: STATES, profileFields: PROFILE_FIELDS, encKey: hasEncKey(), ...extras });
}

export async function POST(request, { params }) {
  const id = assertClientId(params.id);
  const client = await getClient(id);
  if (!client) return Response.json({ error: 'not found' }, { status: 404 });
  const body = await request.json().catch(() => ({}));
  try {
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
      // ── Phase 6 actions ──
      case 'addNote': {
        const r = await addOwnerNote(id, body.text, body.dueDate || null);
        return Response.json({ ok: true, ...r });
      }
      case 'completePromise':
        await completePromise(id, String(body.promiseId));
        await logEvent(id, 'promises', 'promise_done', { promiseId: body.promiseId });
        return Response.json({ ok: true });
      case 'inboxesCancelled':
        await markInboxesCancelled(id);
        return Response.json({ ok: true });
      case 'markPaid':
        return Response.json({ ok: true, ...(await markPaid(id)) });
      case 'clearLegalHold': {
        // Stage C's legal hold is a flag (legalHoldAt) the Sender honours; the
        // state is not changed by the hold, so clearing it does not change state either.
        await kv.hset(K.client(id), { legalHoldAt: '', legalHoldReply: '', legalHoldClearedAt: new Date().toISOString() });
        await logEvent(id, 'mc', 'legal_hold_cleared', { by: 'owner' });
        // He read it and cleared the hold: the legal_reply alert is handled too (no lingering to-do).
        await ackAlerts(id, ['legal_reply'], { reason: 'legal hold cleared' });
        return Response.json({ ok: true });
      }
      case 'clearSendHold': {
        await kv.hset(K.client(id), { sendHold: '', sendHoldClearedAt: new Date().toISOString() });
        await logEvent(id, 'mc', 'send_hold_cleared', { by: 'owner' });
        await ackAlerts(id, ['blacklisted'], { reason: 'send hold cleared' });
        return Response.json({ ok: true });
      }
      case 'reviewCaptured': {
        const at = new Date().toISOString();
        await patchTrial(id, { reviewCapturedAt: at });
        await recordLedger(id, { reviewCapturedAt: at });
        await logEvent(id, 'mc', 'review_captured', {});
        return Response.json({ ok: true });
      }
      case 'logTime': {
        const minutes = Math.round(Number(body.minutes));
        if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 600) return Response.json({ error: 'minutes must be 1–600' }, { status: 400 });
        const total = await kv.hincrby(K.trial(id), 'ownerMinutes', minutes);
        await recordLedger(id, { ownerMinutes: total });
        await logEvent(id, 'mc', 'owner_time_logged', { minutes, total });
        return Response.json({ ok: true, total });
      }
      default:
        return Response.json({ error: 'unknown action' }, { status: 400 });
    }
  } catch (err) {
    return Response.json({ error: err.message }, { status: 400 });
  }
}
