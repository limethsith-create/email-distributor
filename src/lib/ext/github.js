/**
 * GitHub API wrapper (SPEC §13): repository_dispatch for the Lead Finder
 * workflow, and verification of the workflow_run failure report.
 * GITHUB_TOKEN needs `repo` (classic) or Contents: read & write (fine-grained).
 */

import crypto from 'crypto';
import { fetchExt } from '@/lib/ext/http';
import { safeEqual } from '@/lib/crypto';

export function repoName(fallback) {
  return (process.env.GITHUB_REPO || fallback || 'limethsith-create/email-distributor').trim();
}

/** POST /repos/{repo}/dispatches. Resolves { ok, status, error }. Never retried (a retry could start two runs). */
export async function repositoryDispatch(eventType, clientPayload, { token = process.env.GITHUB_TOKEN, repo = repoName() } = {}) {
  if (!token) return { ok: false, status: 0, error: 'GITHUB_TOKEN is not set' };
  try {
    const res = await fetchExt(`https://api.github.com/repos/${repo}/dispatches`, {
      service: 'github',
      retry: false,
      timeoutMs: 15_000,
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'aviance-trial-machine',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ event_type: eventType, client_payload: clientPayload }),
    });
    if (res.status === 204 || res.ok) return { ok: true, status: res.status };
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: `github ${res.status} ${text.slice(0, 160)}` };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

/**
 * Accept either GitHub's own webhook signature (X-Hub-Signature-256 over the
 * raw body) or `Authorization: Bearer <secret>` from leadfinder-watch.yml.
 */
export function verifyGithubRequest(rawBody, headers, secret = process.env.GITHUB_WEBHOOK_SECRET) {
  if (!secret) return false;
  const get = (k) => (typeof headers.get === 'function' ? headers.get(k) : headers[k]) || '';
  const sig = get('x-hub-signature-256');
  if (sig) {
    const want = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    return safeEqual(sig, want);
  }
  return safeEqual(get('authorization'), `Bearer ${secret}`);
}
