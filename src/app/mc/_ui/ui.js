'use client';

export const box = { border: '1px solid var(--border)', padding: 16, borderRadius: 'var(--radius)', background: 'var(--card)' };
export const btn = { padding: '8px 12px', border: '1.5px solid var(--fg)', background: 'var(--fg)', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer' };
export const btnGhost = { ...btn, background: 'transparent', color: 'var(--fg)' };
export const input = { padding: '8px 10px', border: '1px solid var(--border)', width: '100%', fontSize: 14, background: 'transparent', color: 'inherit' };

export async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

export function Eyebrow({ children }) {
  return <div className="eyebrow" style={{ marginBottom: 8 }}>{children}</div>;
}

export function ago(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export function Dot({ color }) {
  return <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 9, background: color, marginRight: 6 }} />;
}
