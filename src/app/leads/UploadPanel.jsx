'use client';

import { useState, useRef, useCallback } from 'react';

const card = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 3, padding: '18px 20px' };

// Header aliases -> canonical field. First match wins.
const FIELD_ALIASES = {
  email: ['email', 'e-mail', 'email address', 'emailaddress', 'mail', 'contact email', 'work email', 'business email'],
  company_name: ['company', 'company name', 'companyname', 'business', 'business name', 'organisation', 'organization', 'account', 'firm'],
  name: ['name', 'full name', 'contact', 'contact name', 'person', 'owner'],
  first_name: ['first name', 'firstname', 'first', 'given name'],
  industry: ['industry', 'niche', 'sector', 'vertical', 'category', 'type'],
  website: ['website', 'site', 'url', 'domain', 'web'],
  phone: ['phone', 'telephone', 'tel', 'mobile', 'phone number'],
  title: ['title', 'job title', 'role', 'position'],
  city: ['city', 'town', 'location'],
  country: ['country', 'nation'],
};

function canonicalise(header) {
  const h = String(header || '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    if (aliases.includes(h)) return field;
  }
  return null;
}

// RFC4180-ish CSV parser: handles quoted fields, embedded commas/newlines, "" escapes, BOM, CRLF.
function parseCSV(text) {
  const s = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

export default function UploadPanel({ onImported }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null); // {rows, mapping, headers, valid, invalid, dupes, fileName}
  const [result, setResult] = useState(null);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef(null);

  const reset = () => { setPreview(null); setResult(null); setError(''); };

  const handleRows = useCallback((matrix, fileName) => {
    if (!matrix.length) { setError('That file looks empty.'); return; }

    // Find the header row: the first row where at least one cell maps to a known field.
    let headerIdx = matrix.findIndex(r => r.some(c => canonicalise(c)));
    if (headerIdx === -1) headerIdx = 0;
    const headers = matrix[headerIdx].map(h => String(h || '').trim());

    const mapping = {};
    headers.forEach((h, i) => { const f = canonicalise(h); if (f && mapping[f] === undefined) mapping[f] = i; });

    // No email column mapped? Fall back to whichever column holds the most emails.
    if (mapping.email === undefined) {
      let best = -1, bestCount = 0;
      const body = matrix.slice(headerIdx + 1, headerIdx + 60);
      for (let c = 0; c < headers.length; c++) {
        const n = body.filter(r => EMAIL_RE.test(String(r[c] || '').trim())).length;
        if (n > bestCount) { bestCount = n; best = c; }
      }
      if (best >= 0 && bestCount > 0) mapping.email = best;
    }

    if (mapping.email === undefined) {
      setError('Could not find an email column. Add a header called "Email" and try again.');
      return;
    }

    const seen = new Set();
    const rows = [];
    let invalid = 0, dupes = 0;

    for (const r of matrix.slice(headerIdx + 1)) {
      const get = (f) => (mapping[f] === undefined ? '' : String(r[mapping[f]] ?? '').trim());
      const email = get('email').toLowerCase();
      if (!EMAIL_RE.test(email)) { invalid++; continue; }
      if (seen.has(email)) { dupes++; continue; }
      seen.add(email);
      const first = get('first_name') || String(get('name') || '').split(' ')[0] || '';
      rows.push({
        email,
        company_name: get('company_name'),
        first_name: first,
        name: get('name'),
        title: get('title'),
        industry: get('industry') || 'business',
        website: get('website'),
        phone: get('phone'),
        city: get('city'),
        country: get('country'),
      });
    }

    if (!rows.length) { setError('No valid email addresses found in that file.'); return; }
    setError('');
    setResult(null);
    setPreview({ rows, mapping, headers, invalid, dupes, fileName });
  }, []);

  const onFile = useCallback(async (file) => {
    if (!file) return;
    reset(); setBusy(true);
    try {
      const name = (file.name || '').toLowerCase();
      if (name.endsWith('.csv') || name.endsWith('.txt') || name.endsWith('.tsv')) {
        const text = await file.text();
        handleRows(parseCSV(name.endsWith('.tsv') ? text.replace(/\t/g, ',') : text), file.name);
      } else if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.xlsm')) {
        const XLSX = await import('xlsx');
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
        handleRows(matrix.map(r => r.map(c => (c == null ? '' : String(c)))), file.name);
      } else {
        setError('Unsupported file. Use .xlsx, .xls or .csv');
      }
    } catch (e) {
      setError('Could not read that file: ' + (e?.message || 'unknown error'));
    } finally {
      setBusy(false);
    }
  }, [handleRows]);

  const doImport = useCallback(async () => {
    if (!preview) return;
    setBusy(true); setError('');
    const CHUNK = 200; // stay well under the KV request-size limit
    const totals = { added: 0, skipped: 0, invalid: 0 };
    try {
      for (let i = 0; i < preview.rows.length; i += CHUNK) {
        const batch = preview.rows.slice(i, i + CHUNK).map(l => ({
          ...l,
          status: 'pending',
          source: 'sheet-upload',
          // Sender requires an effective score >= 8 or the lead never goes out.
          quality_score: 8,
          quality_reason: 'Uploaded from spreadsheet',
          quality_engine: 'upload',
        }));
        const r = await fetch('/api/leads/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ leads: batch }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        totals.added += j.added || 0;
        totals.skipped += j.skipped || 0;
        totals.invalid += j.invalid || 0;
      }
      setResult(totals);
      setPreview(null);
      if (onImported) onImported();
    } catch (e) {
      setError('Import failed: ' + (e?.message || 'unknown error'));
    } finally {
      setBusy(false);
    }
  }, [preview, onImported]);

  const btn = (primary) => ({
    padding: '9px 16px', borderRadius: 9, fontSize: 13.5, fontWeight: 600, cursor: busy ? 'default' : 'pointer',
    border: '1px solid ' + (primary ? 'var(--accent)' : 'var(--border)'),
    background: primary ? 'var(--accent)' : 'transparent',
    color: primary ? '#fff' : 'var(--fg-muted)', opacity: busy ? 0.6 : 1,
  });

  const mapped = preview ? Object.keys(preview.mapping).filter(k => preview.mapping[k] !== undefined) : [];

  return (
    <div style={{ ...card, marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ fontWeight: 600 }}>Add leads from a spreadsheet</div>
          <div style={{ color: 'var(--fg-muted)', fontSize: 13, marginTop: 2 }}>
            Excel or CSV. Duplicates and unsubscribed contacts are skipped automatically.
          </div>
        </div>
        <button onClick={() => { setOpen(o => !o); reset(); }} style={btn(!open)}>
          {open ? 'Close' : 'Upload sheet'}
        </button>
      </div>

      {open && (
        <div style={{ marginTop: 16 }}>
          <div
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); onFile(e.dataTransfer.files?.[0]); }}
            onClick={() => inputRef.current?.click()}
            style={{
              border: '1.5px dashed ' + (drag ? 'var(--accent)' : 'var(--border)'),
              background: drag ? 'var(--accent-soft)' : 'transparent',
              borderRadius: 10, padding: '28px 20px', textAlign: 'center', cursor: 'pointer',
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
              {busy ? 'Working…' : 'Drop your file here, or click to choose'}
            </div>
            <div style={{ color: 'var(--fg-dim)', fontSize: 12.5 }}>.xlsx · .xls · .csv — needs a column with email addresses</div>
            <input
              ref={inputRef} type="file" accept=".xlsx,.xls,.xlsm,.csv,.tsv,.txt"
              style={{ display: 'none' }}
              onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }}
            />
          </div>

          {error && (
            <div style={{ marginTop: 12, padding: '10px 14px', borderRadius: 8, fontSize: 13,
              background: 'rgba(220,38,38,0.10)', color: '#b91c1c', border: '1px solid rgba(220,38,38,0.25)' }}>
              {error}
            </div>
          )}

          {result && (
            <div style={{ marginTop: 12, padding: '12px 14px', borderRadius: 8, fontSize: 13.5,
              background: 'rgba(22,163,74,0.10)', color: '#15803d', border: '1px solid rgba(22,163,74,0.25)' }}>
              <strong>{result.added} leads added.</strong>{' '}
              {result.skipped > 0 && <>{result.skipped} skipped (already in your list or unsubscribed). </>}
              {result.invalid > 0 && <>{result.invalid} had invalid emails.</>}
            </div>
          )}

          {preview && (
            <div style={{ marginTop: 14 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, marginBottom: 10, fontSize: 13.5 }}>
                <span><strong>{preview.rows.length}</strong> ready to import</span>
                {preview.dupes > 0 && <span style={{ color: 'var(--fg-muted)' }}>{preview.dupes} duplicate rows in file</span>}
                {preview.invalid > 0 && <span style={{ color: 'var(--fg-muted)' }}>{preview.invalid} rows without a valid email</span>}
              </div>

              <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', marginBottom: 10 }}>
                Columns detected: {mapped.map(m => (
                  <span key={m} style={{ display: 'inline-block', background: 'rgba(16,24,40,0.05)', border: '1px solid var(--border)',
                    borderRadius: 7, padding: '2px 8px', marginRight: 6, marginTop: 4, fontSize: 12 }}>
                    {m.replace('_', ' ')} → “{preview.headers[preview.mapping[m]]}”
                  </span>
                ))}
              </div>

              <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ color: 'var(--fg-dim)', textAlign: 'left' }}>
                      <th style={{ padding: '9px 14px', fontWeight: 500 }}>Email</th>
                      <th style={{ padding: '9px 14px', fontWeight: 500 }}>Company</th>
                      <th style={{ padding: '9px 14px', fontWeight: 500 }}>Name</th>
                      <th style={{ padding: '9px 14px', fontWeight: 500 }}>Niche</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.slice(0, 5).map((r, i) => (
                      <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ padding: '9px 14px' }}>{r.email}</td>
                        <td style={{ padding: '9px 14px', color: 'var(--fg-muted)' }}>{r.company_name || '—'}</td>
                        <td style={{ padding: '9px 14px', color: 'var(--fg-muted)' }}>{r.first_name || '—'}</td>
                        <td style={{ padding: '9px 14px', color: 'var(--fg-muted)' }}>{r.industry || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.rows.length > 5 && (
                <div style={{ color: 'var(--fg-dim)', fontSize: 12, marginTop: 6 }}>…and {preview.rows.length - 5} more</div>
              )}

              <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
                <button disabled={busy} onClick={doImport} style={btn(true)}>
                  {busy ? 'Importing…' : `Import ${preview.rows.length} leads`}
                </button>
                <button disabled={busy} onClick={reset} style={btn(false)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
