/**
 * One-time Phase 1 migration: the owner's own outreach becomes client
 * `aviance`, and its env-configured inboxes are copied into Redis
 * (encrypted). Safe to run again: existing records are left alone.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { getClient, createClient } from '@/lib/db/client';
import { getInboxRecords, saveInbox } from '@/lib/db/inboxes';
import { logEvent } from '@/lib/db/events';
import { hasEncKey } from '@/lib/crypto';
import { parseAccount } from '@/lib/smtp-accounts';

export async function migrateAviance() {
  const done = [];
  if (!(await getClient('aviance'))) {
    await createClient('aviance', { name: 'Aviance', plan: 'own', state: 'sending', website: 'https://www.aviance.online', mainDomain: 'aviance.online' });
    done.push('created client aviance (state sending)');
  }
  if (!hasEncKey()) {
    done.push('ENC_KEY not set — inboxes left in env for now');
  } else {
    const existing = new Set((await getInboxRecords('aviance')).map((r) => r.email));
    for (let i = 1; i <= 10; i++) {
      const acct = parseAccount(process.env[`SMTP_ACCOUNT_${i}`] || process.env[`GMAIL_ACCOUNT_${i}`] || '', i);
      if (!acct || existing.has(acct.email)) continue;
      const enabled = await kv.hget('inbox_enabled', acct.email);
      await saveInbox('aviance', { email: acct.email, password: acct.password, displayName: acct.displayName, provider: acct.provider, enabled: enabled === '1' || enabled === 1 });
      done.push(`copied inbox ${acct.email} into Redis`);
    }
  }
  await kv.hset(K.migrations(), { phase1: new Date().toISOString() });
  await logEvent('aviance', 'migrate', 'phase1', { done });
  return done;
}
