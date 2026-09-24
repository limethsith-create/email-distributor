/**
 * Paid-plan starter (SPEC §9.8). On **Start {plan}**: set `plan` and
 * `planStartedAt`, keep the trial domain and inboxes live, hand off to the
 * Invoice Maker, and tell the owner (`converted`) with a link to the client
 * page where the one-tap **Mark paid** lives. Plan mode itself is out of
 * scope; the trial pair keeps its records until the fleet is added.
 */

import { updateClient } from '@/lib/db/client';
import { logEvent } from '@/lib/db/events';
import { alertOwner, baseUrl } from '@/lib/notify';
import { cfg } from '@/lib/config';
import { createInvoice } from '@/lib/systems/invoice';
import { patchTrial, recordLedger, PLAN_NAMES, money, cfgTree } from '@/lib/systems/dshared';

export async function startPlan(clientId, plan, { bonus = false, now = new Date() } = {}) {
  if (!PLAN_NAMES[plan]) throw new Error(`unknown plan ${plan}`);
  const at = now.toISOString();
  await updateClient(clientId, { plan, planStartedAt: at });
  await patchTrial(clientId, { decision: 'plan', decisionAt: at, planChosen: plan, bonusApplied: bonus ? '1' : '0' });
  await logEvent(clientId, 'planstart', 'plan_started', { plan, bonus });
  await recordLedger(clientId, { converted: true, plan, convertedAt: at });
  const invoice = await createInvoice(clientId, plan, { bonus, now });
  const plans = await cfgTree(clientId, 'PLANS');
  const bonusCfg = (await cfgTree(clientId, 'BONUS'))?.[plan];
  await alertOwner('converted', {
    clientId,
    vars: { plan: PLAN_NAMES[plan] },
    body: `${clientId} started ${PLAN_NAMES[plan]} (${money(plans[plan].price)}/month).${bonus && bonusCfg ? ` Month-one bonus applies: ${bonusCfg[0]} calls for ${bonusCfg[1]}.` : ''}\nInvoice: ${invoice.status}.\nWhen the money arrives, tap "Mark paid" on the client page: ${baseUrl()}/mc/clients/${clientId}`,
    did: `Set the plan, kept the trial domain and inboxes live, ${invoice.status === 'sent' ? 'emailed the month-one invoice' : 'held the invoice until the payment settings are filled'}.`,
  });
  return { plan, invoice };
}
