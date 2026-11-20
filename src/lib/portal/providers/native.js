/** Our own sending data: the day counters the sender writes (client:{id}:counters:{day}). */
import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';

const n = (v) => Number(v) || 0;

export default {
  name: 'Aviance',
  kind: 'native',
  /** Always on: it is our own data. */
  async available() { return true; },
  /** @param {string[]} days YYYY-MM-DD keys → [{day, sent, replies, interested, booked}] in the same order. */
  async daily(clientId, days) {
    const p = kv.pipeline();
    for (const d of days) p.hgetall(K.countersDay(clientId, d));
    const rows = (await p.exec()) || [];
    return days.map((day, i) => {
      const r = rows[i] || {};
      return { day, sent: n(r.sent), replies: n(r.replies), interested: n(r.positive), booked: n(r.booked) };
    });
  },
};
