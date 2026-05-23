'use client';

import { useState, useEffect } from 'react';

export default function AccountsPage() {
  const [accounts, setAccounts] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ email: '', appPassword: '', displayName: '' });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    const saved = localStorage.getItem('mail-distro-accounts');
    if (saved) setAccounts(JSON.parse(saved));
  }, []);

  const saveAccounts = (updated) => {
    setAccounts(updated);
    localStorage.setItem('mail-distro-accounts', JSON.stringify(updated));
  };

  const showToast = (message, type = 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const handleTestConnection = async () => {
    if (!form.email || !form.appPassword) {
      showToast('Please fill in email and app password', 'error');
      return;
    }
    setTesting(true);
    setTestResult(null);

    try {
      const res = await fetch('/api/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.email, appPassword: form.appPassword }),
      });
      const data = await res.json();
      setTestResult(data);

      if (data.success) {
        showToast('Connection successful!', 'success');
      } else {
        showToast('Connection failed: ' + data.error, 'error');
      }
    } catch (err) {
      setTestResult({ success: false, error: err.message });
      showToast('Connection test failed', 'error');
    }
    setTesting(false);
  };

  const handleAddAccount = async () => {
    if (!form.email || !form.appPassword) {
      showToast('Please fill in email and app password', 'error');
      return;
    }

    if (accounts.some(a => a.email === form.email)) {
      showToast('This account is already connected', 'error');
      return;
    }

    const newAccount = {
      id: Date.now().toString(),
      email: form.email,
      appPassword: form.appPassword,
      displayName: form.displayName || form.email.split('@')[0],
      addedAt: new Date().toISOString(),
      status: testResult?.success ? 'verified' : 'unverified',
    };

    saveAccounts([...accounts, newAccount]);
    setForm({ email: '', appPassword: '', displayName: '' });
    setShowForm(false);
    setTestResult(null);
    showToast('Account added successfully!', 'success');
  };

  const handleRemoveAccount = (id) => {
    saveAccounts(accounts.filter(a => a.id !== id));
    showToast('Account removed', 'info');
  };

  const handleRetestAccount = async (account) => {
    try {
      const res = await fetch('/api/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: account.email, appPassword: account.appPassword }),
      });
      const data = await res.json();

      const updated = accounts.map(a =>
        a.id === account.id ? { ...a, status: data.success ? 'verified' : 'failed' } : a
      );
      saveAccounts(updated);
      showToast(data.success ? 'Account verified!' : 'Verification failed: ' + data.error, data.success ? 'success' : 'error');
    } catch (err) {
      showToast('Test failed: ' + err.message, 'error');
    }
  };

  return (
    <div className="max-w-4xl animate-fade-in">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white mb-1">Gmail Accounts</h1>
          <p className="text-[#6b7280] text-sm">Connect your Gmail accounts for email distribution</p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-4 py-2 bg-[#5c7cfa] hover:bg-[#4c6ef5] text-white text-sm rounded-lg transition-colors flex items-center gap-2"
        >
          <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          Add Account
        </button>
      </div>

      {showForm && (
        <div className="mb-6 p-6 bg-[#12121a] border border-[#2a2a3a] rounded-xl animate-fade-in">
          <h3 className="text-sm font-semibold text-white mb-4">Connect New Gmail Account</h3>
          <div className="mb-5 p-4 bg-[#5c7cfa]/5 border border-[#5c7cfa]/20 rounded-lg">
            <p className="text-xs text-[#91a7ff] leading-relaxed">
              <strong>How to get a Gmail App Password:</strong><br />
              1. Go to your Google Account &rarr; Security<br />
              2. Enable 2-Step Verification (if not already enabled)<br />
              3. Go to <span className="font-mono bg-[#1a1a25] px-1 rounded">myaccount.google.com/apppasswords</span><br />
              4. Generate a new App Password for &quot;Mail&quot;<br />
              5. Copy the 16-character password below
            </p>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-xs text-[#6b7280] mb-1.5">Display Name (optional)</label>
              <input type="text" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="e.g. Marketing Team" className="w-full px-3 py-2.5 bg-[#0a0a0f] border border-[#2a2a3a] rounded-lg text-sm text-white placeholder-[#4a4a5a] focus:border-[#5c7cfa] focus:outline-none transition-colors" />
            </div>
            <div>
              <label className="block text-xs text-[#6b7280] mb-1.5">Gmail Address *</label>
              <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="youremail@gmail.com" className="w-full px-3 py-2.5 bg-[#0a0a0f] border border-[#2a2a3a] rounded-lg text-sm text-white placeholder-[#4a4a5a] focus:border-[#5c7cfa] focus:outline-none transition-colors" />
            </div>
            <div>
              <label className="block text-xs text-[#6b7280] mb-1.5">App Password *</label>
              <input type="password" value={form.appPassword} onChange={(e) => setForm({ ...form, appPassword: e.target.value })} placeholder="xxxx xxxx xxxx xxxx" className="w-full px-3 py-2.5 bg-[#0a0a0f] border border-[#2a2a3a] rounded-lg text-sm text-white placeholder-[#4a4a5a] focus:border-[#5c7cfa] focus:outline-none transition-colors font-mono" />
            </div>

            {testResult && (
              <div className={`p-3 rounded-lg text-xs ${testResult.success ? 'bg-[#40c057]/10 text-[#40c057] border border-[#40c057]/20' : 'bg-[#fa5252]/10 text-[#fa5252] border border-[#fa5252]/20'}`}>
                {testResult.success ? 'Connection verified successfully!' : `Error: ${testResult.error}`}
              </div>
            )}

            <div className="flex gap-3 pt-2">
              <button onClick={handleTestConnection} disabled={testing} className="px-4 py-2 bg-[#1a1a25] hover:bg-[#2a2a3a] text-[#91a7ff] text-sm rounded-lg transition-colors border border-[#2a2a3a] disabled:opacity-50">
                {testing ? 'Testing...' : 'Test Connection'}
              </button>
              <button onClick={handleAddAccount} className="px-4 py-2 bg-[#5c7cfa] hover:bg-[#4c6ef5] text-white text-sm rounded-lg transition-colors">
                Add Account
              </button>
              <button onClick={() => { setShowForm(false); setTestResult(null); }} className="px-4 py-2 text-[#6b7280] hover:text-white text-sm transition-colors">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {accounts.length === 0 ? (
        <div className="p-12 bg-[#12121a] border border-[#2a2a3a] rounded-xl text-center">
          <div className="w-12 h-12 rounded-xl bg-[#5c7cfa]/10 flex items-center justify-center mx-auto mb-4">
            <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="#5c7cfa" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>
          <p className="text-[#6b7280] text-sm mb-4">No Gmail accounts connected yet.</p>
          <button onClick={() => setShowForm(true)} className="px-4 py-2 bg-[#5c7cfa] hover:bg-[#4c6ef5] text-white text-sm rounded-lg transition-colors">
            Connect Your First Account
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {accounts.map((account, idx) => (
            <div key={account.id} className="p-4 bg-[#12121a] border border-[#2a2a3a] rounded-xl flex items-center justify-between hover:border-[#3a3a4a] transition-colors animate-slide-in" style={{ animationDelay: `${idx * 50}ms` }}>
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-[#fa5252]/20 to-[#fab005]/20 flex items-center justify-center text-white text-sm font-bold">
                  {account.email[0].toUpperCase()}
                </div>
                <div>
                  <p className="text-sm text-white font-medium">{account.displayName || account.email}</p>
                  <p className="text-xs text-[#6b7280]">{account.email}</p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <span className={`px-2.5 py-1 rounded-full text-xs ${
                  account.status === 'verified' ? 'bg-[#40c057]/10 text-[#40c057]'
                    : account.status === 'failed' ? 'bg-[#fa5252]/10 text-[#fa5252]'
                    : 'bg-[#fab005]/10 text-[#fab005]'
                }`}>
                  {account.status || 'unverified'}
                </span>
                <button onClick={() => handleRetestAccount(account)} className="p-2 text-[#6b7280] hover:text-[#91a7ff] transition-colors" title="Re-test connection">
                  <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                </button>
                <button onClick={() => handleRemoveAccount(account.id)} className="p-2 text-[#6b7280] hover:text-[#fa5252] transition-colors" title="Remove account">
                  <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {toast && (
        <div className={`toast toast-${toast.type}`}>
          {toast.message}
        </div>
      )}
    </div>
  );
}
