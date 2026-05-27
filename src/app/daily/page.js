'use client';

import { useState, useEffect } from 'react';

function StatBadge({ label, value, color }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`w-2 h-2 rounded-full ${color}`} />
      <span className="text-xs text-[#6b7280]">{label}</span>
      <span className={`text-sm font-semibold ${color.replace('bg-', 'text-')}`}>{value}</span>
    </div>
  );
}

function DayCard({ day, isExpanded, onToggle }) {
  const { date, summary, sent, opens, replies, bounces, accountBreakdown } = day;

  const dateObj = new Date(date + 'T00:00:00');
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  let dateLabel = dateObj.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
  if (date === today) dateLabel = 'Today — ' + dateLabel;
  else if (date === yesterday) dateLabel = 'Yesterday — ' + dateLabel;

  return (
    <div className="bg-[#12121a] border border-[#2a2a3a] rounded-xl overflow-hidden transition-all">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between p-5 hover:bg-[#1a1a25] transition-colors"
      >
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-[#5c7cfa]/20 to-[#7c3aed]/20 flex items-center justify-center border border-[#5c7cfa]/30">
            <span className="text-sm font-bold text-[#91a7ff]">{dateObj.getDate()}</span>
          </div>
          <div className="text-left">
            <p className="text-sm font-medium text-white">{dateLabel}</p>
            <div className="flex items-center gap-4 mt-1">
              <StatBadge label="Sent" value={summary.totalSent} color="bg-[#40c057]" />
              <StatBadge label="Opens" value={summary.totalOpens} color="bg-[#fab005]" />
              <StatBadge label="Replies" value={summary.totalReplies} color="bg-[#5c7cfa]" />
              {summary.totalBounces > 0 && (
                <StatBadge label="Bounced" value={summary.totalBounces} color="bg-[#fa5252]" />
              )}
            </div>
          </div>
        </div>
        <svg
          width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"
          className={`text-[#6b7280] transition-transform ${isExpanded ? 'rotate-180' : ''}`}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isExpanded && (
        <div className="border-t border-[#2a2a3a] p-5 space-y-5">
          {Object.keys(accountBreakdown).length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-[#6b7280] uppercase tracking-wider mb-3">Sends per Account</h4>
              <div className="flex flex-wrap gap-2">
                {Object.entries(accountBreakdown).map(([account, count]) => (
                  <span key={account} className="px-3 py-1.5 bg-[#0a0a0f] border border-[#2a2a3a] rounded-lg text-xs text-[#e8e8ed]">
                    {account.split('@')[0]} <span className="text-[#40c057] font-semibold ml-1">{count}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {sent.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-[#6b7280] uppercase tracking-wider mb-3">Emails Sent ({sent.length})</h4>
              <div className="space-y-1.5 max-h-64 overflow-y-auto">
                {sent.map((email, i) => (
                  <div key={i} className="flex items-center gap-3 py-2 px-3 rounded-lg bg-[#0a0a0f]">
                    <span className="w-2 h-2 rounded-full bg-[#40c057] flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-white truncate">{email.to}</p>
                      <p className="text-xs text-[#4a4a5a] truncate">
                        {email.company && <span>{email.company} · </span>}
                        {email.industry && <span>{email.industry} · </span>}
                        via {email.from?.split('@')[0] || 'unknown'}
                        {email.timestamp && <span> · {new Date(email.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</span>}
                      </p>
                    </div>
                    <span className="text-xs text-[#40c057]">sent</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {opens.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-[#6b7280] uppercase tracking-wider mb-3">Opens Tracked ({opens.length})</h4>
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {opens.map((open, i) => (
                  <div key={i} className="flex items-center gap-3 py-2 px-3 rounded-lg bg-[#0a0a0f]">
                    <span className="w-2 h-2 rounded-full bg-[#fab005] flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-white truncate">{open.email}</p>
                      <p className="text-xs text-[#4a4a5a]">
                        Opened {open.count}x
                        {open.lastOpenedAt && <span> · Last: {new Date(open.lastOpenedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</span>}
                      </p>
                    </div>
                    <span className="text-xs text-[#fab005]">{open.count}x</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {replies.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-[#6b7280] uppercase tracking-wider mb-3">Replies Received ({replies.length})</h4>
              <div className="space-y-1.5">
                {replies.map((reply, i) => (
                  <div key={i} className="flex items-center gap-3 py-2 px-3 rounded-lg bg-[#0a0a0f] border border-[#5c7cfa]/20">
                    <span className="w-2 h-2 rounded-full bg-[#5c7cfa] flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-white truncate">{reply.from}</p>
                      <p className="text-xs text-[#4a4a5a] truncate">
                        {reply.subject || reply.snippet || 'Reply received'}
                        {reply.company && <span> · {reply.company}</span>}
                      </p>
                    </div>
                    <span className="text-xs text-[#5c7cfa]">replied</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {bounces.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-[#6b7280] uppercase tracking-wider mb-3">Bounces Detected ({bounces.length})</h4>
              <div className="space-y-1.5">
                {bounces.map((bounce, i) => (
                  <div key={i} className="flex items-center gap-3 py-2 px-3 rounded-lg bg-[#0a0a0f] border border-[#fa5252]/20">
                    <span className="w-2 h-2 rounded-full bg-[#fa5252] flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-white truncate">{bounce.email}</p>
                      <p className="text-xs text-[#4a4a5a] truncate">
                        {bounce.reason || 'Delivery failed'}
                        {bounce.account && <span> · via {bounce.account.split('@')[0]}</span>}
                      </p>
                    </div>
                    <span className="text-xs text-[#fa5252]">bounced</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {sent.length === 0 && opens.length === 0 && replies.length === 0 && bounces.length === 0 && (
            <p className="text-xs text-[#6b7280] text-center py-4">No detailed activity for this day.</p>
          )}
        </div>
      )}
    </div>
  );
}

export default function DailyLogPage() {
  const [days, setDays] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedDay, setExpandedDay] = useState(null);

  useEffect(() => { fetchDailyLog(); }, []);

  async function fetchDailyLog() {
    setLoading(true);
    try {
      const res = await fetch('/api/daily-log');
      const data = await res.json();
      if (data.success) {
        setDays(data.days);
        if (data.days.length > 0) setExpandedDay(data.days[0].date);
      } else {
        setError(data.error || 'Failed to load');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const totals = days.reduce(
    (acc, day) => ({
      sent: acc.sent + day.summary.totalSent,
      opens: acc.opens + day.summary.totalOpens,
      replies: acc.replies + day.summary.totalReplies,
      bounces: acc.bounces + day.summary.totalBounces,
    }),
    { sent: 0, opens: 0, replies: 0, bounces: 0 }
  );

  const openRate = totals.sent > 0 ? ((totals.opens / totals.sent) * 100).toFixed(1) : '0.0';
  const replyRate = totals.sent > 0 ? ((totals.replies / totals.sent) * 100).toFixed(1) : '0.0';
  const bounceRate = totals.sent > 0 ? ((totals.bounces / totals.sent) * 100).toFixed(1) : '0.0';

  return (
    <div className="max-w-4xl animate-fade-in">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white mb-1">Daily Activity Log</h1>
          <p className="text-[#6b7280] text-sm">Day-by-day breakdown of your outreach activity</p>
        </div>
        <button
          onClick={fetchDailyLog}
          className="px-4 py-2 bg-[#5c7cfa]/10 text-[#91a7ff] hover:bg-[#5c7cfa]/20 text-sm rounded-lg transition-colors border border-[#5c7cfa]/20"
        >
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <div className="p-4 bg-[#12121a] border border-[#2a2a3a] rounded-xl">
          <p className="text-xs text-[#6b7280] uppercase tracking-wider mb-1">Total Sent</p>
          <p className="text-2xl font-bold text-[#40c057]">{totals.sent}</p>
        </div>
        <div className="p-4 bg-[#12121a] border border-[#2a2a3a] rounded-xl">
          <p className="text-xs text-[#6b7280] uppercase tracking-wider mb-1">Open Rate</p>
          <p className="text-2xl font-bold text-[#fab005]">{openRate}%</p>
          <p className="text-xs text-[#4a4a5a] mt-1">{totals.opens} opens</p>
        </div>
        <div className="p-4 bg-[#12121a] border border-[#2a2a3a] rounded-xl">
          <p className="text-xs text-[#6b7280] uppercase tracking-wider mb-1">Reply Rate</p>
          <p className="text-2xl font-bold text-[#5c7cfa]">{replyRate}%</p>
          <p className="text-xs text-[#4a4a5a] mt-1">{totals.replies} replies</p>
        </div>
        <div className="p-4 bg-[#12121a] border border-[#2a2a3a] rounded-xl">
          <p className="text-xs text-[#6b7280] uppercase tracking-wider mb-1">Bounce Rate</p>
          <p className="text-2xl font-bold text-[#fa5252]">{bounceRate}%</p>
          <p className="text-xs text-[#4a4a5a] mt-1">{totals.bounces} bounced</p>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16">
          <div className="w-6 h-6 border-2 border-[#5c7cfa] border-t-transparent rounded-full animate-spin" />
          <span className="ml-3 text-sm text-[#6b7280]">Loading activity log...</span>
        </div>
      )}

      {error && (
        <div className="p-4 bg-[#fa5252]/10 border border-[#fa5252]/20 rounded-xl text-sm text-[#fa5252]">
          Error: {error}
        </div>
      )}

      {!loading && !error && (
        <div className="space-y-3">
          {days.length === 0 ? (
            <div className="p-12 bg-[#12121a] border border-[#2a2a3a] rounded-xl text-center">
              <p className="text-[#6b7280] text-sm">No activity recorded yet.</p>
            </div>
          ) : (
            days.map((day) => (
              <DayCard
                key={day.date}
                day={day}
                isExpanded={expandedDay === day.date}
                onToggle={() => setExpandedDay(expandedDay === day.date ? null : day.date)}
              />
            ))
          )}
        </div>
      )}

      {!loading && days.length > 0 && (
        <p className="text-xs text-[#4a4a5a] text-center mt-6">
          Showing {days.length} day{days.length !== 1 ? 's' : ''} of activity
        </p>
      )}
    </div>
  );
}
