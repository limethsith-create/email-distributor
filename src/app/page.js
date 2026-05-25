'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

export default function Dashboard() {
  const [accounts, setAccounts] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [stats, setStats] = useState({ totalSent: 0, totalFailed: 0, totalPending: 0 });

  useEffect(() => {
    // Load accounts
    const saved = localStorage.getItem('mail-distro-accounts');
    if (saved) setAccounts(JSON.parse(saved));

    // Load campaign history
    const history = localStorage.getItem('mail-distro-campaigns');
    if (history) {
      const parsed = JSON.parse(history);
      setCampaigns(parsed);

      // Calculate stats
      let totalSent = 0, totalFailed = 0, totalPending = 0;
      parsed.forEach(c => {
        c.results?.forEach(r => {
          if (r.status === 'sent') totalSent++;
          else if (r.status === 'failed') totalFailed++;
          else totalPending++;
        });
      });
      setStats({ totalSent, totalFailed, totalPending });
    }
  }, []);

  return (
    <div className="max-w-6xl animate-fade-in">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white mb-1">Dashboard</h1>
        <p className="text-[#6b7280] text-sm">Overview of your email distribution system</p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <StatCard
          label="Connected Accounts"
          value={accounts.length}
          color="#5c7cfa"
          icon={
            <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          }
        />
        <StatCard
          label="Emails Sent"
          value={stats.totalSent}
          color="#40c057"
          icon={
            <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          }
        />
        <StatCard
          label="Failed"
          value={stats.totalFailed}
          color="#fa5252"
          icon={
            <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          }
        />
        <StatCard
          label="Campaigns"
          value={campaigns.length}
          color="#fab005"
          icon={
            <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          }
        />
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
        <Link href="/accounts" className="group p-6 bg-[#12121a] border border-[#2a2a3a] rounded-xl hover:border-[#5c7cfa]/50 transition-all">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-lg bg-[#5c7cfa]/10 flex items-center justify-center text-[#5c7cfa] group-hover:bg-[#5c7cfa]/20 transition-colors">
              <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
              </svg>
            </div>
            <div>
              <h3 className="text-white font-medium text-sm">Connect Gmail Account</h3>
              <p className="text-[#6b7280] text-xs mt-0.5">Add a new Gmail with App Password</p>
            </div>
          </div>
        </Link>

        <Link href="/compose" className="group p-6 bg-[#12121a] border border-[#2a2a3a] rounded-xl hover:border-[#5c7cfa]/50 transition-all">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-lg bg-[#40c057]/10 flex items-center justify-center text-[#40c057] group-hover:bg-[#40c057]/20 transition-colors">
              <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
            </div>
            <div>
              <h3 className="text-white font-medium text-sm">Send Campaign</h3>
              <p className="text-[#6b7280] text-xs mt-0.5">Compose and distribute emails</p>
            </div>
          </div>
        </Link>

        <Link href="/leads" className="group p-6 bg-[#12121a] border border-[#2a2a3a] rounded-xl hover:border-[#fab005]/50 transition-all">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-lg bg-[#fab005]/10 flex items-center justify-center text-[#fab005] group-hover:bg-[#fab005]/20 transition-colors">
              <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <div>
              <h3 className="text-white font-medium text-sm">Outreach Dashboard</h3>
              <p className="text-[#6b7280] text-xs mt-0.5">Automated lead gen & email pipeline</p>
            </div>
          </div>
        </Link>
      </div>

      {/* Recent Campaigns */}
      <div className="bg-[#12121a] border border-[#2a2a3a] rounded-xl overflow-hidden">
        <div className="p-4 border-b border-[#2a2a3a]">
          <h2 className="text-sm font-semibold text-white">Recent Campaigns</h2>
        </div>
        {campaigns.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-[#6b7280] text-sm">No campaigns yet. Start by connecting accounts and composing your first email.</p>
          </div>
        ) : (
          <div className="divide-y divide-[#2a2a3a]">
            {campaigns.slice(-5).reverse().map((campaign, idx) => {
              const sent = campaign.results?.filter(r => r.status === 'sent').length || 0;
              const failed = campaign.results?.filter(r => r.status === 'failed').length || 0;
              const total = campaign.results?.length || 0;

              return (
                <div key={idx} className="p-4 flex items-center justify-between hover:bg-[#1a1a25] transition-colors">
                  <div>
                    <p className="text-sm text-white font-medium">{campaign.subject || 'Untitled Campaign'}</p>
                    <p className="text-xs text-[#6b7280] mt-0.5">
                      {new Date(campaign.timestamp).toLocaleString()} · {total} recipients
                    </p>
                  </div>
                  <div className="flex items-center gap-3 text-xs">
                    <span className="text-[#40c057]">{sent} sent</span>
                    {failed > 0 && <span className="text-[#fa5252]">{failed} failed</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, color, icon }) {
  return (
    <div className="p-5 bg-[#12121a] border border-[#2a2a3a] rounded-xl">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[#6b7280] text-xs uppercase tracking-wider">{label}</span>
        <span style={{ color }} className="opacity-60">{icon}</span>
      </div>
      <p className="text-2xl font-bold text-white">{value}</p>
    </div>
  );
}
