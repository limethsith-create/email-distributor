/**
 * GitHub workflow_run report (SPEC §7.2 Failure): a Lead Finder run that did
 * not succeed → leadfinder_failed. Accepts GitHub's signed webhook
 * (X-Hub-Signature-256) or leadfinder-watch.yml's Bearer; both use
 * GITHUB_WEBHOOK_SECRET.
 */

import { verifyGithubRequest } from '@/lib/ext/github';
import { handleWorkflowRun } from '@/lib/systems/leadfinder';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  const raw = await request.text();
  if (!verifyGithubRequest(raw, request.headers)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const event = request.headers.get('x-github-event') || 'workflow_run';
  if (event === 'ping') return Response.json({ ok: true });
  if (event !== 'workflow_run') return Response.json({ ignored: event });
  let payload;
  try { payload = JSON.parse(raw); } catch { return Response.json({ error: 'bad json' }, { status: 400 }); }
  return Response.json(await handleWorkflowRun(payload));
}
