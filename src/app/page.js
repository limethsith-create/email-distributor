'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [sentLog, setSentLog] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const [statsRes, logRes] = await Promise.all([
          fetch('/api/leads?action=stats'),
          fetch('/api/leads?action=sent_log&limit=20'),
        ]);
        setStats(await statsRes.json());
        const logData = await logRes.json();
        setSentLog(logData.log || []);
      } catch (err) {
        console.error('Dashboard fetch error:', err);
      }
      setLoading(false);
    }
    fetchData();
    const interval = setInterval(fetchData, 15000);
    return () => clearInterval(interval);
  }, []);

  const accounts = ['aviancesystems@gmail.com', 'avianceops@gmail.com', 'avianceauto@gmail.com', 'avianceflow@gmail.com', 'aviancedev@gmail.com'];

  // Count emails per account from sent log
  const accountCounts = {};
  sentLog.forEach(entry => {
    if (entry.from) {
      accountCounts[entry.from] = (accountCounts[entry.from] || 0) + 1;
    }
  });

  return (
    <div className="max-w-6xl animate-fade-in">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white mb-1">Dashboard</h1>
        <p className="text-[#6b7280] text-sm">Live overview of your outreach system</p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
        <StatCard label="Total Leads" value={stats?.totalLeads || 0} color="#5c7cfa" />
        <StatCard label="Emails Sent" value={stats?.totalSent || 0} color="#40c057" />
        <StatCard label="Failed" value={stats?.totalFailed || 0} color="#fa5252" />
        <StatCard label="Replied" value={stats?.replied || 0} color="#be4bdb" />
        <StatCard label="Connected" value={5} color="#fab005" />
      </div>

      {/* Per-Account Breakdown */}
      <div className="bg-[#12121a] border border-[#2a2a3a] rounded-xl p-5 mb-8">
        <h2 className="text-sm font-semibold text-white mb-4">Sends per Account</h2>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          {accounts.map((acc, i) => {
            const count = accountCounts[acc] || 0;
            const colors = ['#5c7cfa', '#40c057', '#fab005', '#be4bdb', '#fa5252'];
            return (
              <div key={acc} className="flex items-center gap-3 p-3 bg-[#0d0d14] rounded-lg">
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: colors[i] }}></div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-[#6b7280] truncate">{acc.split('@')[0]}</p>
                  <p className="text-lg font-bold text-white">{count}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
        <Link href="/leads" className="group p-6 bg-[#12121a] border border-[#2a2a3a] rounded-xl hover:border-[#fab005]/50 transition-all">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-lg bg-[#fab005]/10 flex items-center justify-center text-[#fab005]">
              <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <div>
              <h3 className="text-white font-medium text-sm">Outreach Dashboard</h3>
              <p className="text-[#6b7280] text-xs mt-0.5">View leads, sent emails & full activity</p>
            </div>
          </div>
        </Link>

        <Link href="/compose" className="group p-6 bg-[#12121a] border border-[#2a2a3a] rounded-xl hover:border-[#40c057]/50 transition-all">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-lg bg-[#40c057]/10 flex items-center justify-center text-[#40c057]">
              <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
            </div>
            <div>
              <h3 className="text-white font-medium text-sm">Send Campaign</h3>
              <p className="text-[#6b7280] text-xs mt-0.5">Compose and distribute emails manually</p>
            </div>
          </div>
        </Link>
      </div>

      {/* Recent Sent Emails */}
      <div className="bg-[#12121a] border border-[#2a2a3a] rounded-xl overflow-hidden">
        <div className="p-4 border-b border-[#2a2a3a] flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">Recent Emails Sent</h2>
          <Link href="/leads" className="text-xs text-[#5c7cfa] hover:underline">View all</Link>
        </div>
        {sentLog.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-[#6b7280] text-sm">
              {loading ? 'Loading...' : 'No emails sent yet. The system will start sending when scheduled tasks run.'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-[#2a2a3a]">
            {sentLog.slice(0, 10).map((entry, idx) => (
              <div key={idx} className="p-4 hover:bg-[#1a1a25] transition-colors">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${entry.status === 'sent' ? 'bg-[#40c057]' : 'bg-[#fa5252]'}`}></span>
                    <span className="text-sm text-white font-medium">{entry.company || entry.to}</span>
                  </div>
                  <span className="text-xs text-[#6b7280]">
                    {entry.timestamp ? new Date(entry.timestamp).toLocaleString() : ''}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-xs text-[#6b7280] mt-1">
                  <span>To: {entry.to}</span>
                  <span>From: {entry.from?.split('@')[0]}</span>
                  <span className="capitalize">{entry.industry}</span>
                </div>
                {entry.subject && (
                  <p className="text-xs text-[#4b5563] mt-1 truncate">Subject: {entry.subject}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, color }) {
  return (
    <div className="p-5 bg-[#12121a] border border-[#2a2a3a] rounded-xl">
      <span className="text-[#6b7280] text-xs uppercase tracking-wider">{label}</span>
      <p className="text-2xl font-bold mt-2" style={{ color }}>{value}</p>
    </div>
  );
}
