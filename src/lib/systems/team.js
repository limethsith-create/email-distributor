/**
 * The team (the hub's Team tab, docs/HUB-API.md "Team"): everyone who uses the hub, what they are working on (a
 * line they write themselves), where they are in the hub right now, and which clients they look after (set by the
 * owner). Built on the presence records (systems/presence.js); nothing here is guessed.
 *
 *   - hub:status:{uid}     { text, at }            — their own "working on" line
 *   - hub:clientowners     clientId → JSON [uid]   — who looks after which client
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { getAllClients } from '@/lib/db/client';
import { peopleView } from '@/lib/systems/presence';

const STATUS_MAX = 140;
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const parse = (v) => { if (Array.isArray(v)) return v; try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; } };

/** Their own "working on" line (empty text clears it). */
export async function setStatus(uid, text, now = new Date()) {
  if (!uid) throw new Error('no user');
  const t = clean(text, STATUS_MAX);
  if (!t) { await kv.del(K.hubStatus(uid)); return { ok: true, status: null }; }
  const status = { text: t, at: now.toISOString() };
  await kv.hset(K.hubStatus(uid), status);
  return { ok: true, status };
}

/** The owner sets who looks after a client (an empty list clears it). */
export async function assignClient(clientId, uids) {
  const id = String(clientId || '').trim();
  if (!id) throw new Error('clientId is required');
  const list = [...new Set((Array.isArray(uids) ? uids : []).map((u) => String(u || '').trim()).filter((u) => /^[A-Za-z0-9-]{1,64}$/.test(u)))].slice(0, 10);
  if (list.length) await kv.hset(K.hubClientOwners(), { [id]: JSON.stringify(list) });
  else await kv.hdel(K.hubClientOwners(), id);
  return { ok: true, clientId: id, uids: list };
}

/** Everyone, with their line, where they are and their clients; plus clientId → [uid]. */
export async function teamView(now = new Date()) {
  const { people } = await peopleView(now, { events: 1 });   // the people only (0 would read the whole log)
  const ownersRaw = (await kv.hgetall(K.hubClientOwners())) || {};
  const owners = Object.fromEntries(Object.entries(ownersRaw).map(([k, v]) => [k, parse(v)]));
  const clients = await getAllClients().catch(() => []);
  const byId = new Map(clients.map((c) => [c.id, c]));
  const team = [];
  for (const p of people) {
    const st = (await kv.hgetall(K.hubStatus(p.uid)).catch(() => null)) || {};
    const mine = Object.entries(owners).filter(([, u]) => u.includes(p.uid)).map(([id]) => byId.get(id)).filter(Boolean)
      .map((c) => ({ id: c.id, name: c.name || c.id, state: c.state, plan: c.plan || 'trial' }));
    team.push({
      uid: p.uid, name: p.name, email: p.email, role: p.role, online: p.online, lastSeen: p.lastSeen, lastView: p.lastView,
      activeSecondsToday: p.activeSecondsToday,
      status: st.text ? { text: st.text, at: st.at || null } : null,
      clients: mine,
    });
  }
  return { team, owners };
}
