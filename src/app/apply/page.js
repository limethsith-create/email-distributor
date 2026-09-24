'use client';

/**
 * /apply — the public trial application (SPEC §6.1): the fit-gate questions
 * from The 30-Day Trial, Section 2. Posts to /api/apply; the Gatekeeper
 * answers by email within one business day (usually at once).
 */

import { useState } from 'react';
import { box, btn, input, Eyebrow } from '@/app/mc/_ui/ui';

const YES_NO = [['yes', 'Yes'], ['no', 'No']];

function Radio({ name, value, onChange, options = YES_NO }) {
  return (
    <div style={{ display: 'flex', gap: 16 }}>
      {options.map(([v, label]) => (
        <label key={v} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="radio" name={name} value={v} checked={value === v} onChange={() => onChange(v)} /> {label}
        </label>
      ))}
    </div>
  );
}

function Q({ label, hint, error, children }) {
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <label style={{ fontWeight: 600 }}>{label}</label>
      {hint && <span style={{ fontSize: 13, color: 'var(--fg-muted)' }}>{hint}</span>}
      {children}
      {error && <span style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</span>}
    </div>
  );
}

export default function Apply() {
  const [f, setF] = useState({ dream: ['', '', ''] });
  const [errors, setErrors] = useState({});
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: typeof v === 'string' ? v : v.target.value }));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    const body = {
      companyName: f.companyName, contactName: f.contactName, contactEmail: f.contactEmail, website: f.website,
      usBased: f.usBased, employees: f.employees, dealValue: f.dealValue, soldToStrangers: f.soldToStrangers,
      dreamCustomers: f.dream, meetWithin5Days: f.meetWithin5Days, slotsPerWeek: f.slotsPerWeek,
      nobodyElseEmailing: f.othersEmailing === 'no' ? 'yes' : f.othersEmailing === 'yes' ? 'no' : '',
      reviewAgreed: f.reviewAgreed, notes: f.notes, company_url2: f.company_url2,
    };
    try {
      const res = await fetch('/api/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setErrors(j.errors || { _form: j.error || 'Something went wrong. Please try again.' }); return; }
      setDone(j.message);
    } catch {
      setErrors({ _form: 'Could not reach the server. Please try again.' });
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div style={{ maxWidth: 640, margin: '0 auto', display: 'grid', gap: 16 }}>
        <Eyebrow>Aviance 30-Day Trial</Eyebrow>
        <div style={box}><p style={{ margin: 0, fontSize: 17 }}>{done}</p></div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} style={{ maxWidth: 640, margin: '0 auto', display: 'grid', gap: 20 }}>
      <div>
        <Eyebrow>Aviance 30-Day Trial</Eyebrow>
        <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0 }}>Apply for a trial</h1>
        <p style={{ color: 'var(--fg-muted)' }}>Ten questions. Every answer decides whether a trial can work for you, so please answer them straight — you'll hear back by email within one business day.</p>
      </div>
      <div style={{ ...box, display: 'grid', gap: 16 }}>
        <Q label="Company name" error={errors.companyName}><input style={input} value={f.companyName || ''} onChange={set('companyName')} required /></Q>
        <Q label="Your name" error={errors.contactName}><input style={input} value={f.contactName || ''} onChange={set('contactName')} required /></Q>
        <Q label="Your email" error={errors.contactEmail}><input style={input} type="email" value={f.contactEmail || ''} onChange={set('contactEmail')} required /></Q>
        <Q label="1. Company website" error={errors.website}><input style={input} value={f.website || ''} onChange={set('website')} placeholder="acme.com" required /></Q>
        <Q label="2. Is your company based in the US?"><Radio name="usBased" value={f.usBased} onChange={set('usBased')} /></Q>
        <Q label="3. How many employees do you have?"><input style={input} inputMode="numeric" value={f.employees || ''} onChange={set('employees')} /></Q>
        <Q label="4. What is a new customer worth to you in the first year? (US$)"><input style={input} inputMode="numeric" value={f.dealValue || ''} onChange={set('dealValue')} placeholder="5000" /></Q>
        <Q label="5. Have customers who weren't referrals or friends — strangers — already bought from you?"><Radio name="soldToStrangers" value={f.soldToStrangers} onChange={set('soldToStrangers')} /></Q>
        <Q label="6. Name three companies that would be perfect customers" hint="Name and website is ideal.">
          {[0, 1, 2].map((i) => (
            <input key={i} style={input} value={f.dream[i]} onChange={(e) => setF((s) => { const d = [...s.dream]; d[i] = e.target.value; return { ...s, dream: d }; })} placeholder={`Dream customer ${i + 1}`} />
          ))}
        </Q>
        <Q label="7. Can you take a booked meeting within five business days?"><Radio name="meetWithin5Days" value={f.meetWithin5Days} onChange={set('meetWithin5Days')} /></Q>
        <Q label="8. How many open calendar slots a week can you keep for these calls?"><input style={input} inputMode="numeric" value={f.slotsPerWeek || ''} onChange={set('slotsPerWeek')} /></Q>
        <Q label="9. Is anyone else cold-emailing on your behalf right now?"><Radio name="othersEmailing" value={f.othersEmailing} onChange={set('othersEmailing')} /></Q>
        <Q label="10. At the end, will you leave an honest review of the trial — whatever it says?"><Radio name="reviewAgreed" value={f.reviewAgreed} onChange={set('reviewAgreed')} /></Q>
        <Q label="Anything else we should know? (optional)"><textarea style={{ ...input, minHeight: 80 }} value={f.notes || ''} onChange={set('notes')} /></Q>
        <input type="text" name="company_url2" value={f.company_url2 || ''} onChange={set('company_url2')} tabIndex={-1} autoComplete="off" style={{ position: 'absolute', left: -9999, width: 1, height: 1 }} aria-hidden="true" />
      </div>
      {errors._form && <div style={{ ...box, borderColor: 'var(--danger)' }}>{errors._form}</div>}
      <button type="submit" style={btn} disabled={busy}>{busy ? 'Sending…' : 'Apply'}</button>
    </form>
  );
}
