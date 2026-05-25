'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';

export default function LeadsPage() {
  const [stats, setStats] = useState(null);
  const [leads, setLeads] = useState([]);
  const [queue, setQueue] = useState(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [scraping, setScraping] = useState(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState('');

  const fetchData = useCallback(async () => {
    try {
      const [statsRes, leadsRes, queueRes] = await Promise.all([
        fetch('/api/leads?action=stats'),
        fetch(`/api/leads?action=list&limit=100${statusFilter ? `&status=${statusFilter}` : ''}`),
        fetch('/api/leads?action=queue'),
      ]);

      setStats(await statsRes.json());
      const leadsData = await leadsRes.json();
      setLeads(leadsData.leads || []);
      setQueue(await queueRes.json());
    } catch (err) {
      setMessage('Error loading data: ' + err.message);
    }
    setLoading(false);
  }, [statusFilter]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, [fetchData]);

  const triggerScrape = async () => {
    setScraping(true);
    setMessage('Scraping leads...');
    try {
      const res = await fetch('/api/cron/scrape');
      const data = await res.json();
      setMessage(`Scraped ${data.scrape?.rawLeads || 0} leads, qualified ${data.scrape?.qualifiedLeads || 0}, queued ${data.queue?.totalQueued || 0}`);
      fetchData();
    } catch (err) {
      setMessage('Scrape failed: ' + err.message);
    }
    setScraping(false);
  };

  const triggerSend = async () => {
    setSending(true);
    setMessage('Processing send queue...');
    try {
      const res = await fetch('/api/cron/send');
      const data = await res.json();
      setMessage(`Sent: ${data.sent}, Failed: ${data.failed}, Remaining: ${data.remaining}`);
      fetchData();
    } catch (err) {
      setMessage('Send failed: ' + err.message);
    }
    setSending(false);
  };

  const statusColors = {
    new: 'bg-gray-100 text-gray-700',
    qualified: 'bg-blue-100 text-blue-700',
    scheduled: 'bg-yellow-100 text-yellow-700',
    'sent-d0': 'bg-green-100 text-green-700',
    'sent-d3': 'bg-green-200 text-green-800',
    'sent-d7-complete': 'bg-emerald-100 text-emerald-700',
    replied: 'bg-purple-100 text-purple-700',
    unsubscribed: 'bg-red-100 text-red-700',
    bounced: 'bg-orange-100 text-orange-700',
    skipped: 'bg-gray-200 text-gray-500',
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center">
        <div className="text-lg">Loading outreach dashboard...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-7xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold">Outreach Dashboard</h1>
            <p className="text-gray-400 mt-1">Automated lead generation & email campaigns</p>
          </div>
          <Link href="/" className="px-4 py-2 bg-gray-800 rounded-lg hover:bg-gray-700 transition">
            Back to Home
          </Link>
        </div>

        {/* Stats Cards */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
            <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
              <div className="text-3xl font-bold text-white">{stats.totalLeads}</div>
              <div className="text-gray-400 text-sm">Total Leads</div>
            </div>
            <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
              <div className="text-3xl font-bold text-blue-400">{stats.qualified}</div>
              <div className="text-gray-400 text-sm">Qualified</div>
            </div>
            <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
              <div className="text-3xl font-bold text-green-400">{(stats.sentD0 || 0) + (stats.sentD3 || 0) + (stats.completed || 0)}</div>
              <div className="text-gray-400 text-sm">Emails Sent</div>
            </div>
            <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
              <div className="text-3xl font-bold text-purple-400">{stats.replied}</div>
              <div className="text-gray-400 text-sm">Replied</div>
            </div>
            <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
              <div className="text-3xl font-bold text-yellow-400">{stats.queuePending}</div>
              <div className="text-gray-400 text-sm">Queue Pending</div>
            </div>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex gap-4 mb-6">
          <button
            onClick={triggerScrape}
            disabled={scraping}
            className="px-6 py-3 bg-blue-600 rounded-lg font-medium hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {scraping ? 'Scraping...' : 'Scrape Leads Now'}
          </button>
          <button
            onClick={triggerSend}
            disabled={sending}
            className="px-6 py-3 bg-green-600 rounded-lg font-medium hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {sending ? 'Sending...' : 'Process Send Queue'}
          </button>
        </div>

        {/* Message */}
        {message && (
          <div className="mb-6 p-4 bg-gray-900 border border-gray-700 rounded-lg text-sm">
            {message}
          </div>
        )}

        {/* Queue Status */}
        {queue && queue.total > 0 && (
          <div className="mb-8 bg-gray-900 rounded-xl p-6 border border-gray-800">
            <h2 className="text-xl font-semibold mb-4">Today's Send Queue</h2>
            <div className="grid grid-cols-3 gap-4 mb-4">
              <div className="text-center">
                <div className="text-2xl font-bold text-yellow-400">{queue.pending}</div>
                <div className="text-gray-400 text-sm">Pending</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-green-400">{queue.sent}</div>
                <div className="text-gray-400 text-sm">Sent</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-red-400">{queue.failed}</div>
                <div className="text-gray-400 text-sm">Failed</div>
              </div>
            </div>

            {/* Queue progress bar */}
            <div className="w-full bg-gray-800 rounded-full h-3 mb-2">
              <div
                className="bg-green-500 h-3 rounded-full transition-all"
                style={{ width: `${queue.total > 0 ? ((queue.sent / queue.total) * 100) : 0}%` }}
              ></div>
            </div>
            <div className="text-gray-400 text-xs text-right">
              {queue.sent} / {queue.total} sent
            </div>
          </div>
        )}

        {/* Filter */}
        <div className="mb-4 flex gap-2 flex-wrap">
          {['', 'new', 'qualified', 'sent-d0', 'sent-d3', 'sent-d7-complete', 'replied', 'unsubscribed'].map(s => (
            <button
              key={s}
              onClick={() => { setStatusFilter(s); setLoading(true); }}
              className={`px-3 py-1 rounded-full text-sm transition ${
                statusFilter === s
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
              }`}
            >
              {s || 'All'}
            </button>
          ))}
        </div>

        {/* Leads Table */}
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-800 text-left text-gray-400 text-sm">
                  <th className="px-4 py-3">Company</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Industry</th>
                  <th className="px-4 py-3">City</th>
                  <th className="px-4 py-3">Score</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3">Sent</th>
                </tr>
              </thead>
              <tbody>
                {leads.length === 0 ? (
                  <tr>
                    <td colSpan="8" className="px-4 py-12 text-center text-gray-500">
                      No leads yet. Click "Scrape Leads Now" to get started.
                    </td>
                  </tr>
                ) : (
                  leads.map((lead, i) => (
                    <tr key={i} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition">
                      <td className="px-4 py-3 font-medium">{lead.company_name || '-'}</td>
                      <td className="px-4 py-3 text-gray-300 text-sm">{lead.email}</td>
                      <td className="px-4 py-3 text-sm capitalize">{lead.industry || '-'}</td>
                      <td className="px-4 py-3 text-sm text-gray-400">{lead.city || '-'}</td>
                      <td className="px-4 py-3">
                        <span className={`text-sm font-bold ${
                          lead.ai_score >= 9 ? 'text-green-400' :
                          lead.ai_score >= 8 ? 'text-blue-400' :
                          lead.ai_score >= 7 ? 'text-yellow-400' : 'text-gray-400'
                        }`}>
                          {lead.ai_score || '-'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                          statusColors[lead.status] || 'bg-gray-700 text-gray-300'
                        }`}>
                          {lead.status || 'new'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-400">{lead.source || '-'}</td>
                      <td className="px-4 py-3 text-sm text-gray-400">
                        {lead.sent_at ? new Date(lead.sent_at).toLocaleDateString() : '-'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
