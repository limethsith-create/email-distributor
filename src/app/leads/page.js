'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';

export default function LeadsPage() {
  const [stats, setStats] = useState(null);
  const [leads, setLeads] = useState([]);
  const [sentLog, setSentLog] = useState([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [activeTab, setActiveTab] = useState('sent'); // 'sent', 'leads'
  const [loading, setLoading] = useState(true);
  const [expandedRow, setExpandedRow] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      const [statsRes, leadsRes, logRes] = await Promise.all([
        fetch('/api/leads?action=stats'),
        fetch(`/api/leads?action=list&limit=200${statusFilter ? `&status=${statusFilter}` : ''}`),
        fetch('/api/leads?action=sent_log&limit=200'),
      ]);

      setStats(await statsRes.json());
      const leadsData = await leadsRes.json();
      setLeads(leadsData.leads || []);
      const logData = await logRes.json();
      setSentLog(logData.log || []);
    } catch (err) {
      console.error('Fetch error:', err);
    }
    setLoading(false);
  }, [statusFilter]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 15000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const statusColors = {
    new: 'bg-gray-700 text-gray-300',
    qualified: 'bg-blue-900/50 text-blue-400',
    'sent-d0': 'bg-green-900/50 text-green-400',
    'sent-d3': 'bg-green-800/50 text-green-300',
    'sent-d7-complete': 'bg-emerald-900/50 text-emerald-400',
    replied: 'bg-purple-900/50 text-purple-400',
    unsubscribed: 'bg-red-900/50 text-red-400',
    bounced: 'bg-orange-900/50 text-orange-400',
    skipped: 'bg-gray-800 text-gray-500',
  };

  // Per-account stats from sent log
  const accountStats = {};
  sentLog.forEach(entry => {
    if (!entry.from) return;
    if (!accountStats[entry.from]) accountStats[entry.from] = { sent: 0, failed: 0 };
    if (entry.status === 'sent') accountStats[entry.from].sent++;
    else accountStats[entry.from].failed++;
  });

  if (loading) {
    return (
      <div className="max-w-7xl animate-fade-in p-8">
        <div className="text-[#6b7280] text-sm">Loading outreach dashboard...</div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Outreach Dashboard</h1>
          <p className="text-[#6b7280] text-sm mt-1">Live lead pipeline & email activity</p>
        </div>
        <Link href="/" className="px-4 py-2 bg-[#1a1a25] border border-[#2a2a3a] rounded-lg text-sm text-[#6b7280] hover:text-white transition">
          Back to Home
        </Link>
      </div>

      {/* Stats Row */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-6">
          <MiniStat label="Total Leads" value={stats.totalLeads} color="#5c7cfa" />
          <MiniStat label="Qualified" value={stats.qualified} color="#3b82f6" />
          <MiniStat label="Sent" value={stats.totalSent} color="#40c057" />
          <MiniStat label="Failed" value={stats.totalFailed} color="#fa5252" />
          <MiniStat label="Replied" value={stats.replied} color="#be4bdb" />
          <MiniStat label="Scraped" value={stats.totalScraped} color="#fab005" />
        </div>
      )}

      {/* Account Breakdown */}
      <div className="bg-[#12121a] border border-[#2a2a3a] rounded-xl p-4 mb-6">
        <h3 className="text-xs font-semibold text-[#6b7280] uppercase tracking-wider mb-3">Per-Account Activity</h3>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
          {Object.entries(accountStats).map(([acc, data]) => (
            <div key={acc} className="flex items-center justify-between p-3 bg-[#0d0d14] rounded-lg">
              <div>
                <p className="text-xs text-[#6b7280]">{acc.split('@')[0]}</p>
                <p className="text-sm font-bold text-white">{data.sent} sent</p>
              </div>
              {data.failed > 0 && (
                <span className="text-xs text-[#fa5252]">{data.failed} failed</span>
              )}
            </div>
          ))}
          {Object.keys(accountStats).length === 0 && (
            <p className="text-xs text-[#4b5563] col-span-5">No sends recorded yet</p>
          )}
        </div>
      </div>

      {/* Tab Toggle */}
      <div className="flex gap-1 mb-4 bg-[#0d0d14] p-1 rounded-lg w-fit">
        <button
          onClick={() => setActiveTab('sent')}
          className={`px-4 py-2 rounded-md text-sm font-medium transition ${
            activeTab === 'sent' ? 'bg-[#5c7cfa] text-white' : 'text-[#6b7280] hover:text-white'
          }`}
        >
          Sent Emails ({sentLog.length})
        </button>
        <button
          onClick={() => setActiveTab('leads')}
          className={`px-4 py-2 rounded-md text-sm font-medium transition ${
            activeTab === 'leads' ? 'bg-[#5c7cfa] text-white' : 'text-[#6b7280] hover:text-white'
          }`}
        >
          All Leads ({leads.length})
        </button>
      </div>

      {/* Sent Emails Tab */}
      {activeTab === 'sent' && (
        <div className="bg-[#12121a] border border-[#2a2a3a] rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[#2a2a3a] text-left text-[#6b7280] text-xs uppercase tracking-wider">
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">To</th>
                  <th className="px-4 py-3">Company</th>
                  <th className="px-4 py-3">Industry</th>
                  <th className="px-4 py-3">From Account</th>
                  <th className="px-4 py-3">Subject</th>
                  <th className="px-4 py-3">Time</th>
                </tr>
              </thead>
              <tbody>
                {sentLog.length === 0 ? (
                  <tr>
                    <td colSpan="7" className="px-4 py-12 text-center text-[#4b5563] text-sm">
                      No emails sent yet. The scheduled tasks will start sending automatically.
                    </td>
                  </tr>
                ) : (
                  sentLog.map((entry, i) => (
                    <>
                      <tr
                        key={i}
                        className="border-b border-[#2a2a3a]/50 hover:bg-[#1a1a25] transition cursor-pointer"
                        onClick={() => setExpandedRow(expandedRow === i ? null : i)}
                      >
                        <td className="px-4 py-3">
                          <span className={`w-2 h-2 rounded-full inline-block ${entry.status === 'sent' ? 'bg-[#40c057]' : 'bg-[#fa5252]'}`}></span>
                        </td>
                        <td className="px-4 py-3 text-sm text-white">{entry.to}</td>
                        <td className="px-4 py-3 text-sm text-[#9ca3af]">{entry.company || '-'}</td>
                        <td className="px-4 py-3 text-sm text-[#9ca3af] capitalize">{entry.industry || '-'}</td>
                        <td className="px-4 py-3 text-sm text-[#6b7280]">{entry.from?.split('@')[0]}</td>
                        <td className="px-4 py-3 text-sm text-[#6b7280] max-w-[200px] truncate">{entry.subject || '-'}</td>
                        <td className="px-4 py-3 text-xs text-[#4b5563] whitespace-nowrap">
                          {entry.timestamp ? new Date(entry.timestamp).toLocaleString() : '-'}
                        </td>
                      </tr>
                      {expandedRow === i && entry.bodyPreview && (
                        <tr key={`exp-${i}`}>
                          <td colSpan="7" className="px-6 py-4 bg-[#0d0d14] border-b border-[#2a2a3a]">
                            <div className="text-xs text-[#6b7280] mb-1">Message Preview:</div>
                            <div className="text-sm text-[#9ca3af] whitespace-pre-wrap">{entry.bodyPreview}</div>
                            {entry.messageId && (
                              <div className="text-xs text-[#4b5563] mt-2">Message ID: {entry.messageId}</div>
                            )}
                          </td>
                        </tr>
                      )}
                    </>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Leads Tab */}
      {activeTab === 'leads' && (
        <>
          {/* Status Filter */}
          <div className="mb-4 flex gap-2 flex-wrap">
            {['', 'new', 'qualified', 'sent-d0', 'sent-d3', 'sent-d7-complete', 'replied', 'unsubscribed'].map(s => (
              <button
                key={s}
                onClick={() => { setStatusFilter(s); setLoading(true); }}
                className={`px-3 py-1 rounded-full text-xs transition ${
                  statusFilter === s
                    ? 'bg-[#5c7cfa] text-white'
                    : 'bg-[#1a1a25] text-[#6b7280] hover:text-white'
                }`}
              >
                {s || 'All'}
              </button>
            ))}
          </div>

          <div className="bg-[#12121a] border border-[#2a2a3a] rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[#2a2a3a] text-left text-[#6b7280] text-xs uppercase tracking-wider">
                    <th className="px-4 py-3">Company</th>
                    <th className="px-4 py-3">Email</th>
                    <th className="px-4 py-3">Industry</th>
                    <th className="px-4 py-3">City</th>
                    <th className="px-4 py-3">Score</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Account Used</th>
                    <th className="px-4 py-3">Sent At</th>
                  </tr>
                </thead>
                <tbody>
                  {leads.length === 0 ? (
                    <tr>
                      <td colSpan="8" className="px-4 py-12 text-center text-[#4b5563] text-sm">
                        No leads yet. Leads will appear here as the system scrapes and sends.
                      </td>
                    </tr>
                  ) : (
                    leads.map((lead, i) => (
                      <tr key={i} className="border-b border-[#2a2a3a]/50 hover:bg-[#1a1a25] transition">
                        <td className="px-4 py-3 text-sm font-medium text-white">{lead.company_name || '-'}</td>
                        <td className="px-4 py-3 text-sm text-[#9ca3af]">{lead.email}</td>
                        <td className="px-4 py-3 text-sm text-[#9ca3af] capitalize">{lead.industry || '-'}</td>
                        <td className="px-4 py-3 text-sm text-[#6b7280]">{lead.city || '-'}</td>
                        <td className="px-4 py-3">
                          <span className={`text-sm font-bold ${
                            (lead.ai_score || 0) >= 9 ? 'text-[#40c057]' :
                            (lead.ai_score || 0) >= 8 ? 'text-[#5c7cfa]' :
                            (lead.ai_score || 0) >= 7 ? 'text-[#fab005]' : 'text-[#6b7280]'
                          }`}>
                            {lead.ai_score || '-'}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                            statusColors[lead.status] || 'bg-[#2a2a3a] text-[#6b7280]'
                          }`}>
                            {lead.status || 'new'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-[#6b7280]">
                          {lead.account_used ? lead.account_used.split('@')[0] : '-'}
                        </td>
                        <td className="px-4 py-3 text-xs text-[#4b5563]">
                          {lead.sent_at ? new Date(lead.sent_at).toLocaleString() : '-'}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function MiniStat({ label, value, color }) {
  return (
    <div className="p-4 bg-[#12121a] border border-[#2a2a3a] rounded-xl">
      <span className="text-[#6b7280] text-xs">{label}</span>
      <p className="text-xl font-bold mt-1" style={{ color }}>{value || 0}</p>
    </div>
  );
}
