'use client';
import { useState, useRef } from 'react';
import Link from 'next/link';

export default function UploadPage() {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState([]);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [stats, setStats] = useState(null);
  const fileRef = useRef();

  function parseCSV(text) {
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length < 2) return [];
    const header = lines[0].split(',').map(h => h.replace(/"/g, '').trim().toLowerCase());
    const emailIdx = header.findIndex(h => h === 'email');
    const companyIdx = header.findIndex(h => h.includes('company') && h.includes('name'));
    const industryIdx = header.findIndex(h => h.includes('industry') || h === 'companyindustry/0');
    const nameIdx = header.findIndex(h => h === 'fullname' || h === 'name' || h === 'full_name');
    const statusIdx = header.findIndex(h => h === 'emailstatus' || h === 'email_status');
    if (emailIdx === -1) return [];
    const personalDomains = new Set(['gmail.com','yahoo.com','hotmail.com','outlook.com','live.com','aol.com','icloud.com','mail.com','ymail.com','protonmail.com','zoho.com','t-online.hu','yahoo.co.uk','msn.com','rediffmail.com']);
    const leads = [];
    const rejected = { noEmail: 0, personal: 0, unavailable: 0, invalid: 0 };
    for (let i = 1; i < lines.length; i++) {
      const fields = [];
      let current = '';
      let inQuotes = false;
      for (const char of lines[i]) {
        if (char === '"') { inQuotes = !inQuotes; continue; }
        if (char === ',' && !inQuotes) { fields.push(current.trim()); current = ''; continue; }
        current += char;
      }
      fields.push(current.trim());
      const email = (fields[emailIdx] || '').toLowerCase().trim();
      const emailStatus = statusIdx >= 0 ? (fields[statusIdx] || '').toLowerCase().trim() : '';
      if (!email || !email.includes('@')) { rejected.noEmail++; continue; }
      if (emailStatus === 'unavailable') { rejected.unavailable++; continue; }
      const domain = email.split('@')[1];
      if (personalDomains.has(domain)) { rejected.personal++; continue; }
      if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email)) { rejected.invalid++; continue; }
      const rawInd = industryIdx >= 0 ? (fields[industryIdx] || '').toLowerCase() : '';
      let industry = 'business';
      if (/hotel|hospitality|travel|leisure|tourism/.test(rawInd)) industry = 'hotel';
      else if (/health|medical|pharma/.test(rawInd)) industry = 'healthcare';
      else if (/logist|shipping|freight|transport|supply/.test(rawInd)) industry = 'logistics';
      else if (/legal|law/.test(rawInd)) industry = 'legal';
      else if (/insur/.test(rawInd)) industry = 'insurance';
      else if (/bank|financ/.test(rawInd)) industry = 'finance';
      else if (/tech|software|computer|internet/.test(rawInd)) industry = 'technology';
      else if (/telecom/.test(rawInd)) industry = 'technology';
      else if (/manufactur|apparel|textil|food/.test(rawInd)) industry = 'manufacturing';
      else if (/construct|real estate|building/.test(rawInd)) industry = 'construction';
      else if (/educat/.test(rawInd)) industry = 'education';
      leads.push({ email, company: companyIdx >= 0 ? (fields[companyIdx] || '') : '', industry, name: nameIdx >= 0 ? (fields[nameIdx] || '') : '', status: 'pending' });
    }
    return { leads, rejected };
  }

  function handleFile(e) {
    const f = e.target.files[0];
    if (!f) return;
    setFile(f);
    setResult(null);
    setError(null);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const parsed = parseCSV(ev.target.result);
      if (!parsed.leads || parsed.leads.length === 0) { setError('No valid leads found in CSV.'); return; }
      const seen = new Set();
      const unique = parsed.leads.filter(l => { if (seen.has(l.email)) return false; seen.add(l.email); return true; });
      setPreview(unique);
      setStats({ total: parsed.leads.length + parsed.rejected.noEmail + parsed.rejected.personal + parsed.rejected.unavailable + parsed.rejected.invalid, valid: unique.length, duplicates: parsed.leads.length - unique.length, ...parsed.rejected });
    };
    reader.readAsText(f);
  }

  async function uploadLeads() {
    if (!preview.length) return;
    setLoading(true);
    setError(null);
    try {
      let totalAdded = 0, totalSkipped = 0;
      for (let i = 0; i < preview.length; i += 100) {
        const chunk = preview.slice(i, i + 100);
        const resp = await fetch('/api/leads/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ leads: chunk }) });
        const data = await resp.json();
        totalAdded += data.added || 0;
        totalSkipped += data.skipped || 0;
      }
      setResult({ added: totalAdded, skipped: totalSkipped });
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }

  const industries = preview.reduce((acc, l) => { acc[l.industry] = (acc[l.industry] || 0) + 1; return acc; }, {});

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a1a', color: '#e2e8f0', fontFamily: 'system-ui' }}>
      <nav style={{ display: 'flex', alignItems: 'center', gap: 24, padding: '16px 32px', borderBottom: '1px solid #1e293b' }}>
        <Link href="/" style={{ color: '#818cf8', textDecoration: 'none', fontWeight: 700, fontSize: 18 }}>MailDistro</Link>
        <Link href="/" style={{ color: '#94a3b8', textDecoration: 'none' }}>Dashboard</Link>
        <Link href="/leads" style={{ color: '#94a3b8', textDecoration: 'none' }}>Leads</Link>
        <span style={{ color: '#e2e8f0', fontWeight: 600 }}>Upload</span>
      </nav>
      <main style={{ maxWidth: 900, margin: '0 auto', padding: 32 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>Upload Leads</h1>
        <p style={{ color: '#94a3b8', marginBottom: 32 }}>Upload a CSV file with leads. Invalid emails, personal addresses, and duplicates are filtered automatically.</p>
        <div onClick={() => fileRef.current?.click()} style={{ border: '2px dashed #334155', borderRadius: 12, padding: 48, textAlign: 'center', cursor: 'pointer', marginBottom: 24 }}>
          <input ref={fileRef} type="file" accept=".csv" onChange={handleFile} style={{ display: 'none' }} />
          <p style={{ fontSize: 18, marginBottom: 8 }}>{file ? file.name : 'Click to select CSV file'}</p>
          <p style={{ color: '#64748b', fontSize: 14 }}>Supports CSV with email, companyName, companyIndustry, fullName columns</p>
        </div>
        {error && <div style={{ background: '#7f1d1d', border: '1px solid #dc2626', borderRadius: 8, padding: 16, marginBottom: 24 }}>{error}</div>}
        {stats && (
          <div style={{ background: '#111827', borderRadius: 12, padding: 24, marginBottom: 24, border: '1px solid #1e293b' }}>
            <h3 style={{ marginBottom: 16, fontWeight: 600 }}>Filter Results</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
              {[['Total Rows', stats.total, '#64748b'], ['Valid Leads', stats.valid, '#10b981'], ['No Email', stats.noEmail, '#64748b'], ['Personal', stats.personal, '#64748b'], ['Unavailable', stats.unavailable, '#64748b'], ['Duplicates', stats.duplicates, '#64748b']].map(([label, val, color]) => (
                <div key={label} style={{ background: '#1e293b', borderRadius: 8, padding: 12 }}>
                  <div style={{ color, fontSize: 11, textTransform: 'uppercase' }}>{label}</div>
                  <div style={{ fontSize: 24, fontWeight: 700, color }}>{val}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        {preview.length > 0 && (
          <div style={{ background: '#111827', borderRadius: 12, padding: 24, marginBottom: 24, border: '1px solid #1e293b' }}>
            <h3 style={{ marginBottom: 16, fontWeight: 600 }}>Industry Breakdown</h3>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {Object.entries(industries).sort((a,b) => b[1] - a[1]).map(([ind, count]) => (
                <span key={ind} style={{ background: '#1e293b', borderRadius: 6, padding: '6px 12px', fontSize: 13 }}>{ind}: <strong>{count}</strong></span>
              ))}
            </div>
          </div>
        )}
        {preview.length > 0 && (
          <div style={{ background: '#111827', borderRadius: 12, padding: 24, marginBottom: 24, border: '1px solid #1e293b' }}>
            <h3 style={{ marginBottom: 16, fontWeight: 600 }}>Preview (first 20 of {preview.length})</h3>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead><tr style={{ borderBottom: '1px solid #334155' }}><th style={{ textAlign: 'left', padding: '8px 12px', color: '#94a3b8' }}>Email</th><th style={{ textAlign: 'left', padding: '8px 12px', color: '#94a3b8' }}>Company</th><th style={{ textAlign: 'left', padding: '8px 12px', color: '#94a3b8' }}>Industry</th><th style={{ textAlign: 'left', padding: '8px 12px', color: '#94a3b8' }}>Name</th></tr></thead>
                <tbody>{preview.slice(0, 20).map((lead, i) => (<tr key={i} style={{ borderBottom: '1px solid #1e293b' }}><td style={{ padding: '8px 12px' }}>{lead.email}</td><td style={{ padding: '8px 12px' }}>{lead.company || '\u2014'}</td><td style={{ padding: '8px 12px' }}><span style={{ background: '#1e293b', borderRadius: 4, padding: '2px 8px', fontSize: 11 }}>{lead.industry}</span></td><td style={{ padding: '8px 12px' }}>{lead.name || '\u2014'}</td></tr>))}</tbody>
              </table>
            </div>
          </div>
        )}
        {preview.length > 0 && !result && (
          <button onClick={uploadLeads} disabled={loading} style={{ width: '100%', padding: 16, borderRadius: 8, border: 'none', background: loading ? '#334155' : '#6366f1', color: 'white', fontSize: 16, fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer' }}>
            {loading ? 'Uploading...' : `Upload ${preview.length} Leads to System`}
          </button>
        )}
        {result && (
          <div style={{ background: '#064e3b', border: '1px solid #10b981', borderRadius: 12, padding: 24, textAlign: 'center' }}>
            <h3 style={{ color: '#10b981', marginBottom: 8 }}>Upload Complete!</h3>
            <p style={{ fontSize: 24, fontWeight: 700 }}>{result.added} leads added</p>
            {result.skipped > 0 && <p style={{ color: '#94a3b8' }}>{result.skipped} duplicates skipped</p>}
            <p style={{ color: '#94a3b8', marginTop: 16 }}>The auto-sender will pick these up automatically \u2014 15 per account per day.</p>
            <Link href="/" style={{ color: '#818cf8', textDecoration: 'none', fontWeight: 600 }}>\u2190 Back to Dashboard</Link>
          </div>
        )}
      </main>
    </div>
  );
}
