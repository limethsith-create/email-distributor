/**
 * GitHub API wrapper (SPEC §13): repository_dispatch for the Lead Finder
 * workflow, and verification of the workflow_run failure report.
 * GITHUB_TOKEN needs `repo` (classic) or Contents: read & write (fine-grained).
 * The token and the repository: env wins, else what the owner pasted in the
 * hub (lib/secrets.js, Settings › Keys), else BUILD.repo / the default.
 */

import crypto from 'crypto';
import { fetchExt } from '@/lib/ext/http';
import { safeEqual } from '@/lib/crypto';
import { secretOf, DEFAULT_REPO } from '@/lib/secrets';

/** owner/repository: env GITHUB_REPO, else the hub's, else `fallback` (BUILD.repo), else the default. */
export async function repoName(fallback = null) {
  return String((await secretOf('GITHUB_REPO')) || fallback || DEFAULT_REPO).trim();
}

/** POST /repos/{repo}/dispatches. Resolves { ok, status, error }. Never retried (a retry could start two runs). */
export async function repositoryDispatch(eventType, clientPayload, { token = undefined, repo = undefined } = {}) {
  token = token ?? await secretOf('GITHUB_TOKEN');
  repo = repo ?? await repoName();
  if (!token) return { ok: false, status: 0, error: 'GITHUB_TOKEN is not set — paste a GitHub token in the hub (Settings › Keys)' };
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
