/**
 * Extension (SPEC §9.5). Day 30 with 0 qualified → `extension` automatically:
 * client `extension_notice`, owner `extension_started`, and the Gatekeeper
 * stops taking new trials (it checks for any client in `extension`; see
 * `isExtensionRunning`). Sending continues under the same rules.
 *
 * Ends on the first qualified call (→ `deciding` the next morning, when the
 * day job sees it) or when the trial reaches EXTENSION_CAP trial days
 * (→ `deciding` with the zero-call report). Never a second extension.
 */

import { cfg } from '@/lib/config';
import { getAllClients, getClient, getTrial, setState } from '@/lib/db/client';
import { requireCounters } from '@/lib/db/counters';
import { logEvent } from '@/lib/db/events';
import { alertOwner, notifyClient } from '@/lib/notify';
import { addDays } from '@/lib/time';
import { renderReport, decisionLink } from '@/lib/systems/reports';
import { sendDecision } from '@/lib/systems/decision';
import { sendHandover } from '@/lib/systems/handover';
import { patchTrial, ownerName, recordLedger } from '@/lib/systems/dshared';

export async function isExtensionRunning() {
  return (await getAllClients()).some((c) => c.state === 'extension');
}

export async function startExtension(clientId, { now = new Date() } = {}) {
  const trial = await getTrial(clientId);
  if (trial.extensionStartedAt) {
    // Never twice: straight to the decision with the zero-call report.
    await logEvent(clientId, 'extension', 'extension_refused_second', {});
    return { refused: 'already used' };
  }
  const sig = await ownerName(clientId, 'The extension notice');
  if (!sig) return { held: 'OWNER.signerName' };
  const cap = await cfg(clientId, 'EXTENSION_CAP');
  await patchTrial(clientId, {
    extensionStartedAt: now.toISOString(),
    extensionUntil: trial.day1Date ? addDays(trial.day1Date, cap - 1) : '',
  });
  await setState(clientId, 'extension', 'Day 30 with 0 qualified calls');
  await notifyClient(clientId, 'extension_notice', { capDay: cap, ownerName: sig }, { dedupe: 'extension_notice' });
  await alertOwner('extension_started', {
    clientId,
    body: `${clientId} reached Day 30 with no qualified call. The free extension runs until the first qualified call or Day ${cap}.`,
    did: 'Sent the extension notice to the client. New trials are held while an extension runs.',
  });
  await recordLedger(clientId, { extension: true });
  return { started: true, until: trial.day1Date ? addDays(trial.day1Date, cap - 1) : null };
}

/** Send the end-of-extension report (normal or zero-call) with the Market Report attached. */
async function sendFinalReport(clientId, now) {
  const url = await decisionLink(clientId, 'final', 30);
  const r = await renderReport('final', clientId, { now, decisionUrl: url });
  if (!r.ok) return { held: r.blockedReason };
  const sig = await ownerName(clientId, 'The final trial report');
  if (!sig) return { held: 'OWNER.signerName' };
  await notifyClient(clientId, r.zero ? 'trial_report_zero' : 'trial_report', { body: r.text, ownerName: sig }, { dedupe: 'trial_report:final', attachments: r.attachments });
  return { sent: true, zero: r.zero };
}

/**
 * Daily check while in `extension`. `day` is the trial day on the client's
 * clock. Returns what happened.
 */
export async function checkExtension(clientId, { now = new Date(), day }) {
  const client = await getClient(clientId);
  if (client?.state !== 'extension') return { skipped: 'state' };
  const gate = await requireCounters(clientId, ['qualified']);
  if (!gate.ok) {
    await alertOwner('report_blocked', { clientId, scope: `${clientId}:extension`, vars: { report: 'extension check', clientId }, body: `The extension check for ${clientId} cannot read the qualified counter.`, did: 'Extension continues unchanged.' });
    return { held: 'counters' };
  }
  const cap = await cfg(clientId, 'EXTENSION_CAP');
  if (gate.values.qualified >= 1) {
    await logEvent(clientId, 'extension', 'extension_ended', { reason: 'qualified', day });
    const report = await sendFinalReport(clientId, now);
    if (report.held) return { held: report.held };
    await sendHandover(clientId, 'qualified', { now });
    const d = await sendDecision(clientId, { now, zero: false });
    return { ended: 'qualified', decision: d };
  }
  if (day != null && day >= cap) {
    await logEvent(clientId, 'extension', 'extension_ended', { reason: 'cap', day });
    const report = await sendFinalReport(clientId, now);
    if (report.held) return { held: report.held };
    await sendHandover(clientId, 'cap', { now });
    const d = await sendDecision(clientId, { now, zero: true });
    return { ended: 'cap', decision: d };
  }
  return { running: true, day, cap };
}
