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
          fetch('/api/leads?action=sent_log&limit=500'),
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

  // Count emails per account dynamically
  const accountCounts = {};
  sentLog.forEach(entry => {
    if (entry.from) {
      accountCounts[entry.from] = (accountCounts[entry.from] || 0) + 1;
    }
  });
  const accounts = Object.keys(accountCounts).sort();
  const colors = ['#5c7cfa', '#40c057', '#fab005', '#be4bdb', '#fa5252', '#20c997', '#ff922b', '#845ef7', '#339af0', '#f06595'];

  return (
    <div className="max-w-6xl animate-fade-in">
      {/* Header */}
      <div className="mb-6 md:mb-8">
        <h1 className="text-xl md:text-2xl font-bold text-white mb-1">Dashboard</h1>
        <p className="text-[#6b7280] text-xs md:text-sm">Live overview of your outreach system</p>
      </div>

      {/* Stats Cards â 2 cols on mobile, 5 on desktop */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 md:gap-4 mb-6 md:mb-8">
        <StatCard label="Total Leads" value={stats?.totalLeads || 0} color="#5c7cfa" />
        <StatCard label="Emails Sent" value={stats?.totalSent || 0} color="#40c057" />
        <StatCard label="Failed" value={stats?.totalFailed || 0} color="#fa5252" />
        <StatCard label="Replied" value={stats?.replied || 0} color="#be4bdb" />
        <StatCard label="Accounts" value={accounts.length || '...'} color="#fab005" />
      </div>

      {/* Per-Account Breakdown â 2 cols on mobile, 3 on md, flexible on lg */}
      <div className="bg-[#12121a] border border-[#2a2a3a] rounded-xl p-4 md:p-5 mb-6 md:mb-8">
        <h2 className="text-sm font-semibold text-white mb-3 md:mb-4">Sends per Account</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2 md:gap-3">
          {accounts.map((acc, i) => {
            const count = accountCounts[acc] || 0;
            return (
              <div key={acc} className="flex items-center gap-2 md:gap-3 p-2.5 md:p-3 bg-[#0d0d14] rounded-lg">
                <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: colors[i % colors.length] }}></div>
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] md:text-xs text-[#6b7280] truncate">{acc.split('@')[0]}</p>
                  <p className="text-base md:text-lg font-bold text-white">{count}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Quick Actions â stack on mobile */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4 mb-6 md:mb-8">
        <Link href="/leads" className="group p-4 md:p-6 bg-[#12121a] border border-[#2a2a3a] rounded-xl hover:border-[#fab005]/50 transition-all">
          <div className="flex items-center gap-3 md:gap-4">
            <div className="w-9 h-9 md:w-10 md:h-10 rounded-lg bg-[#fab005]/10 flex items-center justify-center text-[#fab005] flex-shrink-0">
              <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <div>
              <h3 className="text-white font-medium text-sm">Outreach Dashboard</h3>
              <p className="text-[#6b7280] text-xs mt-0.5">View leads, sent emails & full activity</p>
            </div>
          </div>
        </Link>

        <Link href="/upload" className="group p-4 md:p-6 bg-[#12121a] border border-[#2a2a3a] rounded-xl hover:border-[#40c057]/50 transition-all">
          <div className="flex items-center gap-3 md:gap-4">
            <div className="w-9 h-9 md:w-10 md:h-10 rounded-lg bg-[#40c057]/10 flex items-center justify-center text-[#40c057] flex-shrink-0">
              <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
              </svg>
            </div>
            <div>
              <h3 className="text-white font-medium text-sm">Upload Leads</h3>
              <p className="text-[#6b7280] text-xs mt-0.5">Upload CSV file with new leads</p>
            </div>
          </div>
        </Link>
      </div>

      {/* Recent Sent Emails */}
      <div className="bg-[#12121a] border border-[#2a2a3a] rounded-xl overflow-hidden">
        <div className="p-3 md:p-4 border-b border-[#2a2a3a] flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">Recent Emails Sent</h2>
          <Link href="/leads" className="text-xs text-[#5c7cfa] hover:underline">View all</Link>
        </div>
        {sentLog.length === 0 ? (
          <div className="p-8 md:p-12 text-center">
            <p className="text-[#6b7280] text-sm">
              {loading ? 'Loading...' : 'No emails sent yet. The system will start sending when scheduled tasks run.'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-[#2a2a3a]">
            {sentLog.slice(0, 10).map((entry, idx) => (
              <div key={idx} className="p-3 md:p-4 hover:bg-[#1a1a25] transition-colors">
                <div className="flex items-center justify-between mb-1 gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${entry.status === 'sent' ? 'bg-[#40c057]' : 'bg-[#fa5252]'}`}></span>
                    <span className="text-sm text-white font-medium truncate">{entry.company || entry.to}</span>
                  </div>
                  <span className="text-[10px] md:text-xs text-[#6b7280] whitespace-nowrap flex-shrink-0">
                    {entry.timestamp ? new Date(entry.timestamp).toLocaleDateString() : ''}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2 md:gap-4 text-[10px] md:text-xs text-[#6b7280] mt-1">
                  <span className="truncate max-w-[140px] md:max-w-none">To: {entry.to}</span>
                  <span>From: {entry.from?.split('@')[0]}</span>
                  <span className="capitalize">{entry.industry}</span>
                </div>
                {entry.subject && (
                  <p className="text-[10px] md:text-xs text-[#4b5563] mt-1 truncate">Subject: {entry.subject}</p>
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
    <div className="p-3 md:p-5 bg-[#12121a] border border-[#2a2a3a] rounded-xl">
      <span className="text-[#6b7280] text-[10px] md:text-xs uppercase tracking-wider">{label}</span>
      <p className="text-xl md:text-2xl font-bold mt-1 md:mt-2" style={{ color }}>{value}</p>
    </div>
  );
}
