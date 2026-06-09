'use client';

import { useState, useEffect } from 'react';

const DAILY_LIMIT = 15;

export default function AccountsPage() {
  const [accounts, setAccounts] = useState([]);
  const [sentLog, setSentLog] = useState([]);
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeAccount, setActiveAccount] = useState(null);
  const [expandedEmail, setExpandedEmail] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ email: '', password: '', displayName: '' });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    async function fetchData() {
      try {
        const [accountsRes, logRes, leadsRes] = await Promise.all([
          fetch('/api/accounts'),
          fetch('/api/leads?action=sent_log&limit=500'),
          fetch('/api/leads?action=list&limit=500'),
        ]);
        const accData = await accountsRes.json();
        const logData = await logRes.json();
        const leadsData = await leadsRes.json();

        const serverAccounts = accData.success ? accData.accounts : [];
        setAccounts(serverAccounts);
        setSentLog(logData.log || []);
        setLeads(leadsData.leads || []);

        if (serverAccounts.length > 0 && !activeAccount) {
          setActiveAccount(serverAccounts[0].email);
        }
      } catch (err) {
        console.error('Accounts fetch error:', err);
      }
      setLoading(false);
    }
    fetchData();
    const interval = setInterval(fetchData, 20000);
    return () => clearInterval(interval);
  }, []);

  // Build per-account data dynamically
  const accountData = {};
  accounts.forEach(acc => {
    accountData[acc.email] = {
      ...acc,
      sent: [],
      totalSent: 0,
      totalFailed: 0,
      totalReplied: 0,
      industries: new Set(),
    };
  });

  sentLog.forEach(entry => {
    if (entry.from && !accountData[entry.from]) {
      accountData[entry.from] = {
        email: entry.from,
        displayName: entry.from.split('@')[0],
        status: 'active',
        sent: [],
        totalSent: 0,
        totalFailed: 0,
        totalReplied: 0,
        industries: new Set(),
      };
    }
    if (entry.from && accountData[entry.from]) {
      accountData[entry.from].sent.push(entry);
      if (entry.status === 'sent') accountData[entry.from].totalSent++;
      if (entry.status === 'failed') accountData[entry.from].totalFailed++;
      if (entry.industry) accountData[entry.from].industries.add(entry.industry);
    }
  });

  leads.forEach(lead => {
    if (lead.status === 'replied' && lead.account_used && accountData[lead.account_used]) {
      accountData[lead.account_used].totalReplied++;
    }
  });

  const allAccounts = Object.keys(accountData).sort();
  const activeData = activeAccount ? accountData[activeAccount] : null;
  const activeEmails = activeData ? activeData.sent.sort((a, b) =>
    new Date(b.timestamp || 0) - new Date(a.timestamp || 0)
  ) : [];

  const showToast = (message, type = 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const handleTestConnection = async () => {
    if (!form.email || !form.password) {
      showToast('Please fill in email and password', 'error');
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.email, appPassword: form.password }),
      });
      const data = await res.json();
      setTestResult(data);
      showToast(data.success ? 'Connection successful!' : 'Connection failed: ' + data.error, data.success ? 'success' : 'error');
    } catch (err) {
      setTestResult({ success: false, error: err.message });
      showToast('Connection test failed', 'error');
    }
    setTesting(false);
  };

  const handleAddAccount = () => {
    if (!form.email || !form.password) {
      showToast('Please fill in email and password', 'error');
      return;
    }
    showToast('To add a permanent account, set SMTP_ACCOUNT_X in Vercel env vars (format: email:password:displayName)', 'info');
    setShowForm(false);
  };

  const colors = ['#5c7cfa', '#40c057', '#fab005', '#be4bdb', '#fa5252', '#20c997', '#ff922b', '#845ef7', '#339af0', '#f06595'];

  if (loading) {
    return (
      <div className="max-w-6xl animate-fade-in">
        <div className="mb-6 md:mb-8">
          <h1 className="text-xl md:text-2xl font-bold text-white mb-1">Accounts</h1>
          <p className="text-[#6b7280] text-xs md:text-sm">Loading account data...</p>
        </div>
        <div className="flex items-center justify-center p-20">
          <div className="w-6 h-6 border-2 border-[#5c7cfa] border-t-transparent rounded-full animate-spin"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 md:mb-6 gap-3">
        <div className="min-w-0">
          <h1 className="text-xl md:text-2xl font-bold text-white mb-1">Accounts</h1>
          <p className="text-[#6b7280] text-xs md:text-sm">
            {allAccounts.length} account{allAccounts.length !== 1 ? 's' : ''} active — {DAILY_LIMIT} emails/day each
          </p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-3 md:px-4 py-2 bg-[#5c7cfa] hover:bg-[#4c6ef5] text-white text-xs md:text-sm rounded-lg transition-colors flex items-center gap-1.5 md:gap-2 flex-shrink-0"
        >
          <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          <span className="hidden sm:inline">Add Account</span>
          <span className="sm:hidden">Add</span>
        </button>
      </div>

      {/* Add Account Info */}
      {showForm && (
        <div className="mb-4 md:mb-6 p-4 md:p-5 bg-[#12121a] border border-[#2a2a3a] rounded-xl animate-fade-in">
          <h3 className="text-sm font-semibold text-white mb-3">Connect SMTP Email Account</h3>
          <div className="mb-4 p-3 md:p-4 bg-[#5c7cfa]/5 border border-[#5c7cfa]/20 rounded-lg">
            <p className="text-[10px] md:text-xs text-[#91a7ff] leading-relaxed">
              <strong>Namecheap Private Email Setup:</strong><br />
              1. Log in to Namecheap &rarr; Domain List &rarr; Manage<br />
              2. Go to Private Email tab<br />
              3. Create a mailbox (e.g. info@aviance.store)<br />
              4. Use the mailbox password below<br />
              5. SMTP: mail.privateemail.com:465 (pre-configured)
            </p>
          </div>
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-[#6b7280] mb-1">Email Address *</label>
              <input type="email" value={form.email} onChange={e => setForm({...form, email: e.target.value})}
                placeholder="info@aviance.store"
                className="w-full px-3 py-2.5 bg-[#0a0a0f] border border-[#2a2a3a] rounded-lg text-sm text-white placeholder-[#4a4a5a] focus:border-[#5c7cfa] focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs text-[#6b7280] mb-1">SMTP Password *</label>
              <input type="password" value={form.password} onChange={e => setForm({...form, password: e.target.value})}
                placeholder="Your mailbox password"
                className="w-full px-3 py-2.5 bg-[#0a0a0f] border border-[#2a2a3a] rounded-lg text-sm text-white placeholder-[#4a4a5a] focus:border-[#5c7cfa] focus:outline-none font-mono" />
            </div>
            {testResult && (
              <div className={`p-3 rounded-lg text-xs ${testResult.success ? 'bg-[#40c057]/10 text-[#40c057] border border-[#40c057]/20' : 'bg-[#fa5252]/10 text-[#fa5252] border border-[#fa5252]/20'}`}>
                {testResult.success ? 'Connection verified!' : `Error: ${testResult.error}`}
              </div>
            )}
            <div className="flex flex-wrap gap-2 md:gap-3 pt-1">
              <button onClick={handleTestConnection} disabled={testing}
                className="px-3 md:px-4 py-2 bg-[#1a1a25] hover:bg-[#2a2a3a] text-[#91a7ff] text-xs md:text-sm rounded-lg border border-[#2a2a3a] disabled:opacity-50">
                {testing ? 'Testing...' : 'Test Connection'}
              </button>
              <button onClick={handleAddAccount}
                className="px-3 md:px-4 py-2 bg-[#5c7cfa] hover:bg-[#4c6ef5] text-white text-xs md:text-sm rounded-lg">
                Add Account
              </button>
              <button onClick={() => { setShowForm(false); setTestResult(null); }}
                className="px-3 md:px-4 py-2 text-[#6b7280] hover:text-white text-xs md:text-sm">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Account Tabs — horizontally scrollable on mobile */}
      <div className="flex gap-2 mb-4 md:mb-6 overflow-x-auto pb-2 -mx-4 px-4 md:mx-0 md:px-0 scrollbar-hide">
        {allAccounts.map((email, i) => {
          const data = accountData[email];
          const isActive = activeAccount === email;
          const color = colors[i % colors.length];
          return (
            <button
              key={email}
              onClick={() => { setActiveAccount(email); setExpandedEmail(null); }}
              className={`flex items-center gap-1.5 md:gap-2 px-3 md:px-4 py-2 md:py-2.5 rounded-lg text-xs md:text-sm whitespace-nowrap transition-all flex-shrink-0 ${
                isActive
                  ? 'bg-[#1a1a25] border-2 text-white'
                  : 'bg-[#12121a] border border-[#2a2a3a] text-[#6b7280] hover:text-white hover:border-[#3a3a4a]'
              }`}
              style={isActive ? { borderColor: color } : {}}
            >
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }}></div>
              <span>{email.split('@')[0]}</span>
              <span className="text-[10px] md:text-xs px-1.5 py-0.5 rounded-full bg-[#0d0d14]" style={{ color }}>
                {data.totalSent}
              </span>
            </button>
          );
        })}
      </div>

      {/* Active Account Details */}
      {activeData && (
        <>
          {/* Stats Row — 2x2 grid on mobile */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4 mb-4 md:mb-6">
            <MiniStat label="Emails Sent" value={activeData.totalSent} color="#40c057" />
            <MiniStat label="Failed" value={activeData.totalFailed} color="#fa5252" />
            <MiniStat label="Replied" value={activeData.totalReplied} color="#be4bdb" />
            <MiniStat label="Industries" value={activeData.industries.size} color="#fab005" />
          </div>

          {/* Daily Limit Progress — fixed to 15 */}
          <div className="mb-4 md:mb-6 p-3 md:p-4 bg-[#12121a] border border-[#2a2a3a] rounded-xl">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] md:text-xs text-[#6b7280]">Daily Sending Progress</span>
              <span className="text-[10px] md:text-xs text-white font-medium">
                {Math.min(activeData.totalSent, DAILY_LIMIT)} / {DAILY_LIMIT} today
              </span>
            </div>
            <div className="w-full h-2 bg-[#0d0d14] rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${Math.min((activeData.totalSent / DAILY_LIMIT) * 100, 100)}%`,
                  backgroundColor: activeData.totalSent >= DAILY_LIMIT ? '#fa5252' : '#40c057',
                }}
              ></div>
            </div>
          </div>

          {/* Sent Emails List */}
          <div className="bg-[#12121a] border border-[#2a2a3a] rounded-xl overflow-hidden">
            <div className="p-3 md:p-4 border-b border-[#2a2a3a] flex items-center justify-between">
              <h2 className="text-xs md:text-sm font-semibold text-white">
                Emails by {activeAccount?.split('@')[0]}
              </h2>
              <span className="text-[10px] md:text-xs text-[#6b7280]">{activeEmails.length} total</span>
            </div>

            {activeEmails.length === 0 ? (
              <div className="p-8 md:p-12 text-center">
                <p className="text-[#6b7280] text-xs md:text-sm">No emails sent from this account yet.</p>
              </div>
            ) : (
              <div className="divide-y divide-[#2a2a3a]">
                {activeEmails.map((entry, idx) => (
                  <div key={idx} className="hover:bg-[#1a1a25] transition-colors">
                    {/* Email Row */}
                    <button
                      onClick={() => setExpandedEmail(expandedEmail === idx ? null : idx)}
                      className="w-full text-left p-3 md:p-4"
                    >
                      <div className="flex items-center justify-between mb-1 gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                            entry.status === 'sent' ? 'bg-[#40c057]' : 'bg-[#fa5252]'
                          }`}></span>
                          <span className="text-xs md:text-sm text-white font-medium truncate">
                            {entry.company || entry.to}
                          </span>
                          <span className="hidden sm:inline text-[10px] md:text-xs px-1.5 py-0.5 rounded-full bg-[#fab005]/10 text-[#fab005] capitalize">
                            {entry.industry || 'unknown'}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className="text-[10px] md:text-xs text-[#6b7280] hidden sm:inline">
                            {entry.timestamp ? new Date(entry.timestamp).toLocaleString() : ''}
                          </span>
                          <span className="text-[10px] text-[#6b7280] sm:hidden">
                            {entry.timestamp ? new Date(entry.timestamp).toLocaleDateString() : ''}
                          </span>
                          <svg
                            width="12" height="12" fill="none" viewBox="0 0 24 24"
                            stroke="#6b7280" strokeWidth="2"
                            className={`transition-transform ${expandedEmail === idx ? 'rotate-180' : ''}`}
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                          </svg>
                        </div>
                      </div>
                      {/* Mobile: show industry tag on separate line */}
                      <div className="flex flex-wrap items-center gap-1.5 md:gap-4 text-[10px] md:text-xs text-[#6b7280] mt-1">
                        <span className="truncate max-w-[150px] md:max-w-none">To: {entry.to}</span>
                        <span className="sm:hidden text-[10px] px-1.5 py-0.5 rounded-full bg-[#fab005]/10 text-[#fab005] capitalize">
                          {entry.industry || 'unknown'}
                        </span>
                        {entry.city && <span className="hidden md:inline">City: {entry.city}</span>}
                      </div>
                      {entry.subject && (
                        <p className="text-[10px] md:text-xs text-[#4b5563] mt-1 truncate">Subject: {entry.subject}</p>
                      )}
                    </button>

                    {/* Expanded Email Details */}
                    {expandedEmail === idx && (
                      <div className="px-3 md:px-4 pb-3 md:pb-4 animate-fade-in">
                        <div className="p-3 md:p-4 bg-[#0d0d14] rounded-lg border border-[#2a2a3a]">
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 md:gap-3 mb-3 text-[10px] md:text-xs">
                            <div>
                              <span className="text-[#6b7280]">Recipient: </span>
                              <span className="text-white break-all">{entry.to}</span>
                            </div>
                            <div>
                              <span className="text-[#6b7280]">Company: </span>
                              <span className="text-white">{entry.company || 'N/A'}</span>
                            </div>
                            <div>
                              <span className="text-[#6b7280]">Industry: </span>
                              <span className="text-white capitalize">{entry.industry || 'N/A'}</span>
                            </div>
                            <div>
                              <span className="text-[#6b7280]">Status: </span>
                              <span className={entry.status === 'sent' ? 'text-[#40c057]' : 'text-[#fa5252]'}>
                                {entry.status}
                              </span>
                            </div>
                            <div>
                              <span className="text-[#6b7280]">From: </span>
                              <span className="text-white break-all">{entry.from}</span>
                            </div>
                            <div>
                              <span className="text-[#6b7280]">Sent: </span>
                              <span className="text-white">
                                {entry.timestamp ? new Date(entry.timestamp).toLocaleString() : 'N/A'}
                              </span>
                            </div>
                          </div>
                          {entry.subject && (
                            <div className="mb-3">
                              <span className="text-[10px] md:text-xs text-[#6b7280]">Subject: </span>
                              <span className="text-[10px] md:text-xs text-white">{entry.subject}</span>
                            </div>
                          )}
                          {entry.body && (
                            <div>
                              <span className="text-[10px] md:text-xs text-[#6b7280] block mb-1">Email Body:</span>
                              <pre className="text-[10px] md:text-xs text-[#9ca3af] whitespace-pre-wrap leading-relaxed max-h-[200px] md:max-h-[300px] overflow-y-auto">
                                {entry.body}
                              </pre>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* No accounts state */}
      {allAccounts.length === 0 && (
        <div className="p-8 md:p-12 bg-[#12121a] border border-[#2a2a3a] rounded-xl text-center">
          <div className="w-12 h-12 rounded-xl bg-[#5c7cfa]/10 flex items-center justify-center mx-auto mb-4">
            <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="#5c7cfa" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>
          <p className="text-[#6b7280] text-sm mb-4">No email accounts configured yet.</p>
          <p className="text-[#4b5563] text-xs">
            Add accounts via Vercel environment variables (SMTP_ACCOUNT_1, SMTP_ACCOUNT_2, etc.)
          </p>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-4 right-4 md:bottom-6 md:right-6 px-3 md:px-4 py-2.5 md:py-3 rounded-lg text-xs md:text-sm z-50 animate-fade-in max-w-[90vw] ${
          toast.type === 'success' ? 'bg-[#40c057]/20 text-[#40c057] border border-[#40c057]/30' :
          toast.type === 'error' ? 'bg-[#fa5252]/20 text-[#fa5252] border border-[#fa5252]/30' :
          'bg-[#5c7cfa]/20 text-[#91a7ff] border border-[#5c7cfa]/30'
        }`}>
          {toast.message}
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, value, color }) {
  return (
    <div className="p-3 md:p-4 bg-[#12121a] border border-[#2a2a3a] rounded-xl">
      <span className="text-[#6b7280] text-[10px] md:text-xs uppercase tracking-wider">{label}</span>
      <p className="text-lg md:text-xl font-bold mt-1" style={{ color }}>{value}</p>
    </div>
  );
}
