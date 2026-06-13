'use client';

import { useState, useEffect } from 'react';

const SAMPLE = { name: 'Nimal', company: 'Ceylon Tea Co', industry: 'retail' };

function fillVars(text, vars) {
  return (text || '').replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
}

export default function ComposePage() {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testEmail, setTestEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState(null);

  const showToast = (msg, type = 'info') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3500); };

  useEffect(() => {
    fetch('/api/template').then((r) => r.json()).then((d) => {
      if (d.template) { setSubject(d.template.subject || ''); setBody(d.template.body || ''); }
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/template', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject, body }),
      });
      showToast(res.ok ? 'Template saved.' : 'Save failed', res.ok ? 'success' : 'error');
    } catch { showToast('Save failed', 'error'); }
    setSaving(false);
  };

  const sendTest = async () => {
    if (!testEmail.includes('@')) { showToast('Enter a valid email to test', 'error'); return; }
    setSending(true);
    try {
      const res = await fetch('/api/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipients: [{ email: testEmail, name: SAMPLE.name, company: SAMPLE.company }],
          subject, body, delayMs: 0,
        }),
      });
      if (res.ok) showToast(`Test sent to ${testEmail} (if inboxes are live).`, 'success');
      else { const d = await res.json().catch(() => ({})); showToast(d.error || 'Send failed — inboxes may not be live yet.', 'error'); }
    } catch { showToast('Send failed — inboxes may not be live yet.', 'error'); }
    setSending(false);
  };

  const wordCount = fillVars(body, SAMPLE).trim().split(/\s+/).filter(Boolean).length;

  return (
    <div className="space-y-7">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Compose</h1>
          <p className="text-[14px] mt-0.5" style={{ color: 'var(--fg-muted)' }}>
            Your cold email template. Use <span className="font-mono">{'{{name}}'}</span>, <span className="font-mono">{'{{company}}'}</span> for personalization.
          </p>
        </div>
        <button className="btn btn-primary" onClick={save} disabled={saving || loading}>
          {saving ? 'Saving…' : 'Save template'}
        </button>
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        {/* Editor */}
        <div className="space-y-4">
          <div className="card p-5">
            <label className="section-title">Subject</label>
            <input className="input mt-2" value={subject} onChange={(e) => setSubject(e.target.value)}
              placeholder="{{name}} — quick question about {{company}}" />
          </div>
          <div className="card p-5">
            <div className="flex items-center justify-between">
              <label className="section-title">Body</label>
              <span className="text-[12px]" style={{ color: wordCount > 70 ? 'var(--warning)' : 'var(--fg-dim)' }}>
                {wordCount} words {wordCount > 70 ? '· keep it under 70' : ''}
              </span>
            </div>
            <textarea className="input mt-2 font-[inherit]" rows={12} value={body}
              onChange={(e) => setBody(e.target.value)} placeholder="Hi {{name}}, ..." style={{ resize: 'vertical', lineHeight: 1.6 }} />
          </div>
          <div className="flex flex-wrap gap-2">
            {['{{name}}', '{{company}}', '{{industry}}'].map((v) => (
              <button key={v} className="badge badge-muted" style={{ cursor: 'pointer' }}
                onClick={() => setBody((b) => b + ' ' + v)}>{v}</button>
            ))}
          </div>
        </div>

        {/* Preview */}
        <div className="space-y-4">
          <div className="card overflow-hidden">
            <div className="px-5 py-3 flex items-center gap-2" style={{ borderBottom: '1px solid var(--border)' }}>
              <span className="text-[12px]" style={{ color: 'var(--fg-dim)' }}>Preview · sample data</span>
            </div>
            <div className="p-5">
              <div className="text-[12px]" style={{ color: 'var(--fg-dim)' }}>Subject</div>
              <div className="text-[15px] font-medium mt-0.5 mb-4">{fillVars(subject, SAMPLE) || <span style={{ color: 'var(--fg-dim)' }}>—</span>}</div>
              <div className="text-[12px]" style={{ color: 'var(--fg-dim)' }}>Body</div>
              <div className="text-[14px] mt-1.5 whitespace-pre-wrap" style={{ color: 'var(--fg)', lineHeight: 1.65 }}>
                {fillVars(body, SAMPLE) || <span style={{ color: 'var(--fg-dim)' }}>Start typing…</span>}
              </div>
            </div>
          </div>

          {/* Test send */}
          <div className="card p-5">
            <label className="section-title">Send a test to yourself</label>
            <div className="flex gap-2 mt-2">
              <input className="input" type="email" value={testEmail} onChange={(e) => setTestEmail(e.target.value)} placeholder="you@gmail.com" />
              <button className="btn btn-ghost" onClick={sendTest} disabled={sending}>{sending ? 'Sending…' : 'Send test'}</button>
            </div>
            <p className="text-[12px] mt-2" style={{ color: 'var(--fg-dim)' }}>
              Works once your inboxes finish provisioning and credentials are set.
            </p>
          </div>
        </div>
      </div>

      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}
    </div>
  );
}
