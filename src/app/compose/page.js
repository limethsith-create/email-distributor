'use client';

import { useState, useEffect, useRef } from 'react';

export default function ComposePage() {
  const [accounts, setAccounts] = useState([]);
  const [selectedAccounts, setSelectedAccounts] = useState([]);
  const [recipients, setRecipients] = useState([]);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [csvText, setCsvText] = useState('');
  const [manualEmail, setManualEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, results: [] });
  const [showPreview, setShowPreview] = useState(false);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [toast, setToast] = useState(null);
  const [tab, setTab] = useState('manual');
  const [delayMs, setDelayMs] = useState(2000);
  const fileInputRef = useRef(null);

  useEffect(() => {
    const saved = localStorage.getItem('mail-distro-accounts');
    if (saved) {
      const parsed = JSON.parse(saved);
      setAccounts(parsed);
      setSelectedAccounts(parsed.map(a => a.id));
    }
  }, []);

  const showToast = (message, type = 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  const handleCSVUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const text = evt.target.result;
      setCsvText(text);
      parseCSV(text);
    };
    reader.readAsText(file);
  };

  const parseCSV = (text) => {
    const lines = text.trim().split('\n');
    if (lines.length < 2) {
      showToast('CSV must have a header row and at least one data row', 'error');
      return;
    }
    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    const emailCol = headers.findIndex(h => h.toLowerCase() === 'email');
    if (emailCol === -1) {
      showToast('CSV must have an "email" column', 'error');
      return;
    }
    const parsed = [];
    for (let i = 1; i < lines.length; i++) {
      const values = [];
      let current = '';
      let inQuotes = false;
      for (const char of lines[i]) {
        if (char === '"') inQuotes = !inQuotes;
        else if (char === ',' && !inQuotes) {
          values.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      values.push(current.trim());
      if (values[emailCol] && values[emailCol].includes('@')) {
        const obj = {};
        headers.forEach((h, j) => { obj[h] = values[j] || ''; });
        parsed.push(obj);
      }
    }
    setRecipients(parsed);
    showToast('Loaded ' + parsed.length + ' recipients from CSV', 'success');
  };

  const handleAddManualEmail = () => {
    if (!manualEmail.includes('@')) {
      showToast('Please enter a valid email address', 'error');
      return;
    }
    if (recipients.some(r => r.email === manualEmail)) {
      showToast('This email is already in the list', 'error');
      return;
    }
    setRecipients([...recipients, { email: manualEmail }]);
    setManualEmail('');
  };

  const handleRemoveRecipient = (index) => {
    setRecipients(recipients.filter((_, i) => i !== index));
  };

  const handlePasteEmails = (text) => {
    const emails = text.split(/[,\n;]+/).map(e => e.trim()).filter(e => e.includes('@'));
    const unique = emails.filter(e => !recipients.some(r => r.email === e));
    const newRecipients = unique.map(email => ({ email }));
    setRecipients([...recipients, ...newRecipients]);
    if (newRecipients.length > 0) {
      showToast('Added ' + newRecipients.length + ' email(s)', 'success');
    }
  };

  const processTemplate = (template, data) => {
    if (!template) return '';
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return data[key] || data[key?.toLowerCase()] || match;
    });
  };

  const toggleAccount = (id) => {
    setSelectedAccounts(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const handleSend = async () => {
    const activeAccounts = accounts.filter(a => selectedAccounts.includes(a.id));
    if (activeAccounts.length === 0) { showToast('Please select at least one account', 'error'); return; }
    if (recipients.length === 0) { showToast('Please add at least one recipient', 'error'); return; }
    if (!subject.trim()) { showToast('Please enter a subject line', 'error'); return; }
    if (!body.trim()) { showToast('Please enter an email body', 'error'); return; }

    setSending(true);
    setProgress({ current: 0, total: recipients.length, results: [] });

    try {
      const res = await fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accounts: activeAccounts, recipients, subject, body, delayMs }),
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === 'progress') {
                setProgress(prev => ({ ...prev, current: data.current, results: [...prev.results, data.result] }));
              } else if (data.type === 'complete') {
                setProgress(prev => ({ ...prev, current: prev.total }));
              }
            } catch (e) {}
          }
        }
      }

      const campaign = {
        subject,
        timestamp: new Date().toISOString(),
        recipientCount: recipients.length,
        accountsUsed: activeAccounts.map(a => a.email),
        results: progress.results,
      };
      const history = JSON.parse(localStorage.getItem('mail-distro-campaigns') || '[]');
      history.push(campaign);
      localStorage.setItem('mail-distro-campaigns', JSON.stringify(history));
      showToast('Campaign completed!', 'success');
    } catch (err) {
      showToast('Error sending campaign: ' + err.message, 'error');
    }
    setSending(false);
  };

  const activeAccounts = accounts.filter(a => selectedAccounts.includes(a.id));

  return (
    <div className="max-w-5xl animate-fade-in">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white mb-1">Compose Campaign</h1>
        <p className="text-[#6b7280] text-sm">
          Write your email, add recipients, and distribute across {accounts.length} connected account{accounts.length !== 1 ? 's' : ''}
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-5">
          <div className="p-5 bg-[#12121a] border border-[#2a2a3a] rounded-xl">
            <h3 className="text-xs font-semibold text-[#6b7280] uppercase tracking-wider mb-3">
              Send From ({activeAccounts.length} of {accounts.length} selected)
            </h3>
            {accounts.length === 0 ? (
              <p className="text-sm text-[#fa5252]">
                No accounts connected.{' '}
                <a href="/accounts" className="underline hover:text-white">Add one first</a>
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {accounts.map(account => (
                  <button key={account.id} onClick={() => toggleAccount(account.id)}
                    className={`px-3 py-1.5 rounded-lg text-xs transition-all border ${
                      selectedAccounts.includes(account.id)
                        ? 'bg-[#5c7cfa]/15 border-[#5c7cfa]/40 text-[#91a7ff]'
                        : 'bg-[#0a0a0f] border-[#2a2a3a] text-[#6b7280] hover:border-[#3a3a4a]'
                    }`}>
                    {account.email}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="p-5 bg-[#12121a] border border-[#2a2a3a] rounded-xl">
            <label className="block text-xs font-semibold text-[#6b7280] uppercase tracking-wider mb-2">Subject</label>
            <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)}
              placeholder="e.g. Hey {{name}}, quick question about {{company}}"
              className="w-full px-3 py-2.5 bg-[#0a0a0f] border border-[#2a2a3a] rounded-lg text-sm text-white placeholder-[#4a4a5a] focus:border-[#5c7cfa] focus:outline-none" />
            <p className="text-xs text-[#4a4a5a] mt-2">Use {'{{variable}}'} for personalization. Variables come from your CSV columns.</p>
          </div>

          <div className="p-5 bg-[#12121a] border border-[#2a2a3a] rounded-xl">
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-[#6b7280] uppercase tracking-wider">Email Body</label>
              {recipients.length > 0 && (
                <button onClick={() => { setShowPreview(true); setPreviewIndex(0); }}
                  className="text-xs text-[#5c7cfa] hover:text-[#91a7ff] transition-colors">Preview with data</button>
              )}
            </div>
            <textarea value={body} onChange={(e) => setBody(e.target.value)}
              placeholder={`Hi {{name}},\n\nI noticed that {{company}} is doing great work in...\n\nWould love to connect and discuss how we can help.\n\nBest regards`}
              rows={12}
              className="w-full px-3 py-2.5 bg-[#0a0a0f] border border-[#2a2a3a] rounded-lg text-sm text-white placeholder-[#4a4a5a] focus:border-[#5c7cfa] focus:outline-none resize-y font-mono leading-relaxed" />
          </div>

          <div className="p-5 bg-[#12121a] border border-[#2a2a3a] rounded-xl">
            <h3 className="text-xs font-semibold text-[#6b7280] uppercase tracking-wider mb-3">Settings</h3>
            <div className="flex items-center gap-4">
              <label className="text-sm text-[#6b7280]">Delay between emails:</label>
              <select value={delayMs} onChange={(e) => setDelayMs(Number(e.target.value))}
                className="px-3 py-1.5 bg-[#0a0a0f] border border-[#2a2a3a] rounded-lg text-sm text-white focus:border-[#5c7cfa] focus:outline-none">
                <option value={1000}>1 second</option>
                <option value={2000}>2 seconds</option>
                <option value={3000}>3 seconds</option>
                <option value={5000}>5 seconds</option>
                <option value={10000}>10 seconds</option>
                <option value={30000}>30 seconds</option>
              </select>
            </div>
            <p className="text-xs text-[#4a4a5a] mt-2">Longer delays help avoid Gmail rate limits. Emails are distributed round-robin across your selected accounts.</p>
          </div>
        </div>

        <div className="space-y-5">
          <div className="p-5 bg-[#12121a] border border-[#2a2a3a] rounded-xl">
            <h3 className="text-xs font-semibold text-[#6b7280] uppercase tracking-wider mb-3">
              Recipients ({recipients.length})
            </h3>
            <div className="flex gap-1 mb-4 bg-[#0a0a0f] rounded-lg p-1">
              <button onClick={() => setTab('manual')}
                className={`flex-1 px-3 py-1.5 rounded-md text-xs transition-colors ${tab === 'manual' ? 'bg-[#1a1a25] text-white' : 'text-[#6b7280] hover:text-white'}`}>Manual</button>
              <button onClick={() => setTab('csv')}
                className={`flex-1 px-3 py-1.5 rounded-md text-xs transition-colors ${tab === 'csv' ? 'bg-[#1a1a25] text-white' : 'text-[#6b7280] hover:text-white'}`}>CSV Upload</button>
            </div>

            {tab === 'manual' ? (
              <div>
                <div className="flex gap-2 mb-3">
                  <input type="email" value={manualEmail} onChange={(e) => setManualEmail(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddManualEmail()}
                    placeholder="email@example.com"
                    className="flex-1 px-3 py-2 bg-[#0a0a0f] border border-[#2a2a3a] rounded-lg text-xs text-white placeholder-[#4a4a5a] focus:border-[#5c7cfa] focus:outline-none" />
                  <button onClick={handleAddManualEmail}
                    className="px-3 py-2 bg-[#5c7cfa] hover:bg-[#4c6ef5] text-white text-xs rounded-lg">Add</button>
                </div>
                <div className="mb-3">
                  <textarea placeholder="Or paste multiple emails (comma, semicolon, or newline separated)..." rows={3}
                    className="w-full px-3 py-2 bg-[#0a0a0f] border border-[#2a2a3a] rounded-lg text-xs text-white placeholder-[#4a4a5a] focus:border-[#5c7cfa] focus:outline-none resize-none"
                    onBlur={(e) => { if (e.target.value.trim()) { handlePasteEmails(e.target.value); e.target.value = ''; } }} />
                </div>
              </div>
            ) : (
              <div>
                <div onClick={() => fileInputRef.current?.click()}
                  className="border-2 border-dashed border-[#2a2a3a] rounded-lg p-6 text-center cursor-pointer hover:border-[#5c7cfa]/50 transition-colors mb-3">
                  <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="#6b7280" strokeWidth="1.5" className="mx-auto mb-2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                  <p className="text-xs text-[#6b7280]">Click to upload CSV file</p>
                  <p className="text-xs text-[#4a4a5a] mt-1">Must have an &quot;email&quot; column</p>
                </div>
                <input ref={fileInputRef} type="file" accept=".csv" onChange={handleCSVUpload} className="hidden" />
                <p className="text-xs text-[#4a4a5a]">CSV columns become template variables. e.g. name, company, email</p>
              </div>
            )}

            {recipients.length > 0 && (
              <div className="mt-4 max-h-64 overflow-y-auto space-y-1">
                {recipients.map((r, i) => (
                  <div key={i} className="flex items-center justify-between px-2 py-1.5 rounded-md hover:bg-[#1a1a25] group">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-white truncate">{r.email}</p>
                      {r.name && <p className="text-xs text-[#4a4a5a] truncate">{r.name}</p>}
                    </div>
                    <span className="text-xs text-[#4a4a5a] mr-2">
                      via {activeAccounts.length > 0 ? activeAccounts[i % activeAccounts.length]?.email?.split('@')[0] : '—'}
                    </span>
                    <button onClick={() => handleRemoveRecipient(i)} className="opacity-0 group-hover:opacity-100 text-[#fa5252] transition-opacity">
                      <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}

            {recipients.length > 0 && (
              <button onClick={() => setRecipients([])} className="mt-3 text-xs text-[#fa5252] hover:text-[#ff6b6b] transition-colors">
                Clear all recipients
              </button>
            )}
          </div>

          {activeAccounts.length > 0 && recipients.length > 0 && (
            <div className="p-5 bg-[#12121a] border border-[#2a2a3a] rounded-xl">
              <h3 className="text-xs font-semibold text-[#6b7280] uppercase tracking-wider mb-3">Distribution</h3>
              {activeAccounts.map((account, idx) => {
                const count = recipients.filter((_, i) => i % activeAccounts.length === idx).length;
                return (
                  <div key={account.id} className="flex items-center justify-between py-1.5">
                    <span className="text-xs text-[#91a7ff] truncate max-w-[150px]">{account.email}</span>
                    <span className="text-xs text-[#6b7280]">{count} email{count !== 1 ? 's' : ''}</span>
                  </div>
                );
              })}
            </div>
          )}

          <button onClick={handleSend} disabled={sending || activeAccounts.length === 0 || recipients.length === 0}
            className="w-full py-3 bg-gradient-to-r from-[#5c7cfa] to-[#7c3aed] hover:from-[#4c6ef5] hover:to-[#6d28d9] text-white text-sm font-medium rounded-xl transition-all disabled:opacity-40 disabled:cursor-not-allowed">
            {sending ? `Sending... (${progress.current}/${progress.total})` : `Send ${recipients.length} Email${recipients.length !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>

      {sending && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-[#12121a] border border-[#2a2a3a] rounded-2xl p-8 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold text-white mb-2">Sending Campaign</h3>
            <p className="text-sm text-[#6b7280] mb-6">{progress.current} of {progress.total} emails sent</p>
            <div className="w-full h-2 bg-[#2a2a3a] rounded-full mb-4 overflow-hidden">
              <div className="h-full bg-gradient-to-r from-[#5c7cfa] to-[#40c057] rounded-full transition-all duration-500"
                style={{ width: `${(progress.current / progress.total) * 100}%` }} />
            </div>
            <div className="max-h-40 overflow-y-auto space-y-1">
              {progress.results.slice(-5).map((r, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <span className={r.status === 'sent' ? 'text-[#40c057]' : 'text-[#fa5252]'}>{r.status === 'sent' ? '✓' : '✗'}</span>
                  <span className="text-[#6b7280]">{r.to}</span>
                  <span className="text-[#4a4a5a]">via {r.from}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {showPreview && recipients.length > 0 && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-[#12121a] border border-[#2a2a3a] rounded-2xl p-6 max-w-lg w-full mx-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-white">Preview Email</h3>
              <button onClick={() => setShowPreview(false)} className="text-[#6b7280] hover:text-white">
                <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <span className="text-xs text-[#6b7280]">To:</span>
                <p className="text-sm text-white">{recipients[previewIndex]?.email}</p>
              </div>
              <div>
                <span className="text-xs text-[#6b7280]">Subject:</span>
                <p className="text-sm text-white">{processTemplate(subject, recipients[previewIndex])}</p>
              </div>
              <div>
                <span className="text-xs text-[#6b7280]">Body:</span>
                <pre className="text-sm text-white whitespace-pre-wrap mt-1 p-3 bg-[#0a0a0f] rounded-lg font-sans leading-relaxed">
                  {processTemplate(body, recipients[previewIndex])}
                </pre>
              </div>
            </div>
            <div className="flex items-center justify-between mt-4 pt-4 border-t border-[#2a2a3a]">
              <span className="text-xs text-[#6b7280]">Recipient {previewIndex + 1} of {recipients.length}</span>
              <div className="flex gap-2">
                <button onClick={() => setPreviewIndex(Math.max(0, previewIndex - 1))} disabled={previewIndex === 0}
                  className="px-3 py-1 text-xs bg-[#1a1a25] rounded-md text-[#6b7280] hover:text-white disabled:opacity-30">Prev</button>
                <button onClick={() => setPreviewIndex(Math.min(recipients.length - 1, previewIndex + 1))} disabled={previewIndex === recipients.length - 1}
                  className="px-3 py-1 text-xs bg-[#1a1a25] rounded-md text-[#6b7280] hover:text-white disabled:opacity-30">Next</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {toast && <div className={`toast toast-${toast.type}`}>{toast.message}</div>}
    </div>
  );
}
