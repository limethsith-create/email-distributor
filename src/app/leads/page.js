'use client';

import { useState, useEffect, useRef } from 'react';

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row = {};
    headers.forEach((h, i) => { row[h] = (cells[i] || '').trim(); });
    return row;
  });
}

export default function LeadsPage() {
  const [leads, setLeads] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [niche, setNiche] = useState('all');
  const fileRef = useRef(null);

  const showToast = (msg, type = 'info') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3500); };

  const load = () => {
    Promise.all([
      fetch('/api/leads?action=list&limit=2000').then((r) => r.json()).catch(() => ({ leads: [] })),
      fetch('/api/leads?action=stats').then((r) => r.json()).catch(() => null),
    ]).then(([list, st]) => { setLeads(list.leads || []); setStats(st); setLoading(false); });
  };
  useEffect(load, []);

  const niches = ['all', ...Array.from(new Set(leads.map((l) => l.industry || 'other'))).sort()];
  const visible = niche === 'all' ? leads : leads.filter((l) => (l.industry || 'other') === niche);

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const text = await file.text();
      const rows = parseCSV(text);
      const mapped = rows
        .map((r) => ({
          email: r.email || r['email address'] || '',
          company: r.company || r.company_name || r.organization || '',
          name: r.name || r.first_name || r.contact || '',
          industry: r.industry || r.sector || '',
        }))
        .filter((r) => r.email.includes('@'));
      if (!mapped.length) { showToast('No valid emails found. Need an "email" column.', 'error'); setUploading(false); return; }
      const res = await fetch('/api/leads/bulk', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leads: mapped }),
      });
      const data = await res.json();
      if (res.ok) { showToast(`Added ${data.added ?? mapped.length} leads${data.skipped ? `, skipped ${data.skipped}` : ''}.`, 'success'); load(); }
      else showToast(data.error || 'Upload failed', 'error');
    } catch (err) { showToast('Could not read file', 'error'); }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  const statusBadge = (s) => {
    const map = {
      sent: 'badge-success', sending: 'badge-warning', replied: 'badge-accent',
      bounced: 'badge-warning', pending: 'badge-muted',
    };
    return <span className={`badge ${map[s] || 'badge-muted'}`}>{s || 'pending'}</span>;
  };

  return (
    <div className="space-y-7">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Leads</h1>
          <p className="text-[14px] mt-0.5" style={{ color: 'var(--fg-muted)' }}>
            Upload recipients and track who&apos;s been emailed.
          </p>
        </div>
        <button className="btn btn-primary" disabled={uploading} onClick={() => fileRef.current?.click()}>
          {uploading ? 'Uploading…' : 'Upload CSV'}
        </button>
        <input ref={fileRef} type="file" accept=".csv" hidden onChange={onFile} />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Total leads', value: stats?.totalLeads ?? stats?.total ?? leads.length },
          { label: 'Sent', value: stats?.totalSent ?? stats?.sent ?? '—' },
          { label: 'Pending', value: leads.filter((l) => (l.status || 'pending') === 'pending').length },
          { label: 'Replied', value: stats?.replied ?? '—' },
        ].map((s) => (
          <div key={s.label} className="card p-5">
            <div className="stat-label">{s.label}</div>
            <div className="stat-value mt-1.5">{s.value}</div>
          </div>
        ))}
      </div>

      {/* Format hint */}
      <div className="card p-4 flex items-start gap-3" style={{ background: 'var(--bg-subtle)' }}>
        <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="#b3a4f5" strokeWidth="1.6" className="mt-0.5 flex-shrink-0"><path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" /></svg>
        <div className="text-[13px]" style={{ color: 'var(--fg-muted)' }}>
          CSV needs an <b className="text-[var(--fg)]">email</b> column. Optional: <b className="text-[var(--fg)]">name</b>, <b className="text-[var(--fg)]">company</b>, <b className="text-[var(--fg)]">industry</b> — use them as <span className="font-mono">{'{{name}}'}</span>, <span className="font-mono">{'{{company}}'}</span> in your template.
        </div>
      </div>

      {/* Table */}
      <div className="card overflow-hidden fade-up">
        <div className="px-5 py-3.5 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border)' }}>
          <span className="text-[14px] font-medium">All leads</span>
          <select value={niche} onChange={(e) => setNiche(e.target.value)} className="text-[12.5px] rounded-lg px-2.5 py-1.5" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--fg)' }}>
            {niches.map((n) => <option key={n} value={n}>{n === 'all' ? 'All niches' : n}</option>)}
          </select>
          <span className="text-[12px]" style={{ color: 'var(--fg-dim)' }}>{visible.length} shown</span>
        </div>
        {loading ? (
          <div className="p-6 text-[13px]" style={{ color: 'var(--fg-dim)' }}>Loading…</div>
        ) : leads.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr style={{ color: 'var(--fg-dim)' }} className="text-left">
                  <th className="font-medium px-5 py-2.5">Email</th>
                  <th className="font-medium px-5 py-2.5">Company</th>
                  <th className="font-medium px-5 py-2.5">Niche</th>
                  <th className="font-medium px-5 py-2.5">Status</th>
                  <th className="font-medium px-5 py-2.5">Sent from</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((l, i) => (
                  <tr key={l.email + i} style={{ borderTop: '1px solid var(--border)' }}>
                    <td className="px-5 py-3 truncate max-w-[220px]">{l.email}</td>
                    <td className="px-5 py-3" style={{ color: 'var(--fg-muted)' }}>{l.company_name || '—'}</td>
                    <td className="px-5 py-3"><span className="badge badge-muted">{l.industry || '—'}</span></td>
                    <td className="px-5 py-3">{statusBadge(l.status)}</td>
                    <td className="px-5 py-3" style={{ color: 'var(--fg-dim)' }}>{l.account_used || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-8 text-center">
            <div className="text-[14px] font-medium mb-1">No leads yet</div>
            <div className="text-[13px]" style={{ color: 'var(--fg-muted)' }}>Upload a CSV to get started.</div>
          </div>
        )}
      </div>

      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}
    </div>
  );
}
