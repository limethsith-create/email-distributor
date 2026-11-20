/**
 * The client's numbers (portal "Numbers" screen). Built from the same counters and records as the client's shared
 * dashboard (systems/clientdash.js). Client-safe only: no money, costs, invoices, notes, fit scores or lead lists.
 */
import { getClient, getTrial } from '@/lib/db/client';
import { getInboxRecords } from '@/lib/db/inboxes';
import { K } from '@/lib/db/keys';
import { kv } from '@vercel/kv';
import { clientNow, clientTrialDay } from '@/lib/testclock';
import { dayKeyIn, addDays, ET, daysBetween } from '@/lib/time';
import { statusLine } from '@/lib/systems/clientdash';
import { mergedDaily, PROVIDERS } from './providers/index';

const WARMUP_DAYS = 14;
const PAID = ['starter', 'growth', 'scale'];
const on = (v) => v === '1' || v === 1 || v === true;
const has = (v) => v != null && v !== '' && v !== '0' && v !== 'false';
const num = (v) => Number(v) || 0;

const STAGE_WORDS = {
  applied: 'Call booked', onboarding: 'Onboarding call', awaiting_purchase: 'Setting up', setup_check: 'Setting up', ready: 'Ready to start',
  warming: 'Warming up', sending: 'Sending emails', paused: 'Paused', retired: 'Stopped', declined: 'Not going ahead', deleted: 'Stopped',
};
const HEALTH_WORDS = { good: 'Healthy', warming: 'Warming up', paused: 'Paused', problem: 'Needs a look' };

export function inboxHealth(rec, state, warmupDay) {
  if (!on(rec.enabled)) return has(rec.disabledReason) || has(rec.emergencyDisabledAt) || rec.twoStepVerified === '0' ? 'problem' : 'paused';
  if (state === 'warming' || (has(rec.warmupStartedAt) && warmupDay > 0 && warmupDay < WARMUP_DAYS && state !== 'sending')) return 'warming';
  return 'good';
}

export async function buildNumbers(clientId, { now = new Date() } = {}) {
  const client = await getClient(clientId);
  if (!client) return null;
  const [trial, recs] = await Promise.all([getTrial(clientId).catch(() => ({})), getInboxRecords(clientId).catch(() => [])]);
  const state = client.state || 'applied';
  const today = dayKeyIn(ET, clientNow(client, now));
  const dayKeys = Array.from({ length: 30 }, (_, i) => addDays(today, i - 29));
  const { days, sources } = await mergedDaily(clientId, dayKeys, PROVIDERS);
  const sum = (f) => days.reduce((a, d) => a + d[f], 0);
  const last = days[days.length - 1];
  const sends = (await kv.hgetall(K.inboxSends(clientId, today)).catch(() => null)) || {};
  const plan = String(client.plan || 'starter').toLowerCase();
  const sentTotal = sum('sent');

  const inboxes = recs.map((r) => {
    const startedDay = has(r.warmupStartedAt) ? daysBetween(dayKeyIn(ET, new Date(r.warmupStartedAt)), today) + 1 : 0;
    const warmupDay = Math.max(0, Math.min(startedDay, WARMUP_DAYS));
    const health = inboxHealth(r, state, startedDay);
    return { email: String(r.email), health, healthWords: HEALTH_WORDS[health], warmupDay, warmupOf: WARMUP_DAYS, sentToday: num(sends[r.email]), limit: num(r.dailyCap) };
  });

  const warmDays = inboxes.map((i) => i.warmupDay).filter((d) => d > 0);
  const day = warmDays.length ? Math.max(...warmDays) : 0;
  const wState = state === 'warming' ? 'warming' : ['sending', 'paused', 'retired'].includes(state) ? 'done' : inboxes.length && day ? 'warming' : 'not_started';
  const warmup = {
    state: wState, day: wState === 'done' ? WARMUP_DAYS : day, of: WARMUP_DAYS,
    words: wState === 'done' ? 'Warm-up finished' : wState === 'warming' ? `Warm-up day ${day} of ${WARMUP_DAYS}` : 'Warm-up has not started',
  };

  let next = { words: 'Nothing for you to do right now.', at: null };
  const d1 = trial?.day1Date;
  if (state === 'warming' && d1) next = { words: `Emails start on ${d1}.`, at: d1 };
  else if (state === 'sending') next = { words: 'Emails go out each weekday morning.', at: null };
  else if (state === 'paused') next = { words: 'Sending is paused for now.', at: null };
  else if (['applied', 'onboarding'].includes(state)) next = { words: statusLine({ state, paid: PAID.includes(plan), day: clientTrialDay(client, trial || {}, now) }), at: null };

  return {
    ok: true,
    client: { name: client.name || clientId, plan: `${PAID.includes(plan) ? plan[0].toUpperCase() + plan.slice(1) : 'Starter'} plan`, stage: state, stageWords: STAGE_WORDS[state] || 'On your plan' },
    today: { sent: last.sent, replies: last.replies, interested: last.interested, booked: last.booked },
    days,
    totals: { sent: sentTotal, replies: sum('replies'), interested: sum('interested'), booked: sum('booked'), replyRate: sentTotal ? Math.round((sum('replies') / sentTotal) * 1000) / 1000 : 0 },
    inboxes, warmup, next, sources, updatedAt: now.toISOString(),
  };
}
