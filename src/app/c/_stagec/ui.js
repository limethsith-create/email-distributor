'use client';

/** Small shared pieces for the Stage C client pages (/c/[token]/tap|customer|stop|away). */

export const card = { maxWidth: 520, margin: '32px auto', padding: 24, border: '1px solid var(--border, #ddd)', background: 'var(--card, #fff)', borderRadius: 6, fontSize: 15, lineHeight: 1.55 };
export const button = { padding: '10px 14px', border: '1.5px solid #111', background: '#111', color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer', margin: '6px 8px 6px 0', borderRadius: 4 };
export const ghost = { ...button, background: 'transparent', color: '#111' };
export const field = { width: '100%', padding: '8px 10px', border: '1px solid #ccc', fontSize: 14, margin: '6px 0 12px', borderRadius: 4, boxSizing: 'border-box' };

export async function call(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) throw new Error(json.error || `Something went wrong (${res.status})`);
  return json;
}
