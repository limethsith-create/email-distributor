'use client';

import { useState, useEffect, useMemo } from 'react';

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [sentLog, setSentLog] = useState([]);
  const [totalReplies, setTotalReplies] = useState(0);
  const [warmupAccounts, setWarmupAccounts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const [statsRes, logRes, repliesRes, warmupRes] = await Promise.all([
          fetch('/api/leads?action=stats'),
          fetch('/api/leads?action=sent_log&limit=500'),
          fetch('/api/replies'),
          fetch('/api/warmup').catch(() => null),
        ]);
        setStats(await statsRes.json());
        const logData = await logRes.json();
        setSentLog(logData.log || []);
        const repliesData = await repliesRes.json();
        if (repliesData.success) {
          setTotalReplies(repliesData.totalReplies || 0);
        }
        if (warmupRes && warmupRes.ok) {
          const warmupData = await warmupRes.json();
          if (warmupData.success) setWarmupAccounts(warmupData.accounts || []);
        }
      } catch (err) {
        console.error('Dashboard fetch error:', err);
      }
      setLoading(false);
    }
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, []);

  // Compute chart data: group sends by date
  const chartData = useMemo(() => {
    const byDate = {};
    sentLog.forEach((entry) => {
      if (!entry.timestamp) return;
      const d = new Date(entry.timestamp).toISOString().slice(0, 10);
      if (!byDate[d]) byDate[d] = { sent: 0, bounced: 0, replied: 0 };
      byDate[d].sent += 1;
      if (entry.status === 'bounced') byDate[d].bounced += 1;
      if (entry.status === 'replied') byDate[d].replied += 1;
    });
    return Object.entries(byDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, counts]) => ({ date, ...counts }));
  }, [sentLog]);

  const totalSent = stats?.totalSent || 0;
  const totalLeads = stats?.totalLeads || 0;
  const bounced = stats?.bounced || stats?.totalBounced || 0;
  const replied = stats?.replied || totalReplies || 0;
  const replyRate = totalSent > 0 ? ((replied / totalSent) * 100).toFixed(1) : '0.0';
  const bounceRate = totalSent > 0 ? ((bounced / totalSent) * 100).toFixed(1) : '0.0';

  const now = new Date();
  const monthName = now.toLocaleString('default', { month: 'long', year: 'numeric' });

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-gray-400 text-sm">Loading dashboard...</div>
      </div>
    );
  }

  return (
    <div className="max-w-[1200px]">
      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Main Dashboard</h1>
          <p className="text-gray-500 text-sm mt-1">Full overview of your current workspace</p>
        </div>
        <div className="text-right">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-white border border-gray-200 rounded-lg shadow-sm">
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5" className="text-gray-400">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
            </svg>
            <span className="text-sm text-gray-700 font-medium">{monthName}</span>
          </div>
        </div>
      </div>

      {/* Stat Cards Row 1 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        <StatCard
          label="Emails Sent"
          value={totalSent}
          icon={<SendIcon />}
          iconBg="bg-blue-50"
          iconColor="text-blue-600"
        />
        <StatCard
          label="Total People Contacted"
          value={totalLeads}
          icon={<UsersIcon />}
          iconBg="bg-indigo-50"
          iconColor="text-indigo-600"
        />
        <StatCard
          label="Total Opens"
          value={0}
          badge={null}
          icon={<EyeIcon />}
          iconBg="bg-amber-50"
          iconColor="text-amber-600"
          sublabel="Tracking coming soon"
        />
        <StatCard
          label="Unique Opens"
          value={0}
          badge="0%"
          badgeColor="bg-gray-100 text-gray-500"
          icon={<CursorIcon />}
          iconBg="bg-gray-50"
          iconColor="text-gray-500"
          sublabel="Tracking coming soon"
        />
      </div>

      {/* Stat Cards Row 2 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard
          label="Replies"
          value={replied}
          badge={`${replyRate}%`}
          badgeColor={parseFloat(replyRate) > 2 ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}
          icon={<ReplyIcon />}
          iconBg="bg-green-50"
          iconColor="text-green-600"
        />
        <StatCard
          label="Bounced"
          value={bounced}
          badge={`${bounceRate}%`}
          badgeColor={parseFloat(bounceRate) > 5 ? 'bg-red-100 text-red-700' : 'bg-orange-100 text-orange-700'}
          icon={<BounceIcon />}
          iconBg="bg-red-50"
          iconColor="text-red-600"
        />
        <StatCard
          label="Unsubscribed"
          value={0}
          badge={null}
          icon={<UnsubIcon />}
          iconBg="bg-gray-50"
          iconColor="text-gray-400"
          sublabel="Not tracked yet"
        />
        <StatCard
          label="Interested"
          value={replied}
          badge={replied > 0 ? 'Active' : null}
          badgeColor="bg-green-100 text-green-700"
          icon={<StarIcon />}
          iconBg="bg-emerald-50"
          iconColor="text-emerald-600"
        />
      </div>

      {/* Chart Section */}
      <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-6 mb-8">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-base font-semibold text-gray-900">Email Activity</h2>
          <div className="flex items-center gap-4 text-xs text-gray-500">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-blue-400 inline-block"></span> Sent
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-red-400 inline-block"></span> Bounced
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-green-400 inline-block"></span> Replied
            </span>
          </div>
        </div>
        <AreaChart data={chartData} />
      </div>

      {/* Warmup Section */}
      {warmupAccounts.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-base font-semibold text-gray-900">Account Warmup</h2>
            <span className="text-xs text-gray-500">{warmupAccounts.length} account{warmupAccounts.length !== 1 ? 's' : ''}</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {warmupAccounts.map((acc, i) => (
              <WarmupCard key={acc.email || i} account={acc} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Stat Card ── */
function StatCard({ label, value, badge, badgeColor, icon, iconBg, iconColor, sublabel }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-4">
      <div className="flex items-start justify-between mb-3">
        <div className={`w-9 h-9 rounded-lg ${iconBg} flex items-center justify-center ${iconColor}`}>
          {icon}
        </div>
        {badge != null && (
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${badgeColor}`}>
            {badge}
          </span>
        )}
      </div>
      <p className="text-2xl font-bold text-gray-900">{value.toLocaleString?.() ?? value}</p>
      <p className="text-xs text-gray-500 mt-1">{label}</p>
      {sublabel && <p className="text-[10px] text-gray-400 mt-0.5">{sublabel}</p>}
    </div>
  );
}

/* ── Area Chart (pure SVG) ── */
function AreaChart({ data }) {
  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-400 text-sm">
        No send data to display yet
      </div>
    );
  }

  const W = 800, H = 200, padL = 45, padR = 20, padT = 10, padB = 40;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const maxVal = Math.max(...data.map((d) => d.sent), 1);
  const yTicks = 5;

  const x = (i) => padL + (i / Math.max(data.length - 1, 1)) * chartW;
  const y = (v) => padT + chartH - (v / maxVal) * chartH;

  // Build sent area path
  let linePath = `M ${x(0)} ${y(data[0].sent)}`;
  for (let i = 1; i < data.length; i++) linePath += ` L ${x(i)} ${y(data[i].sent)}`;
  const areaPath = linePath + ` L ${x(data.length - 1)} ${y(0)} L ${x(0)} ${y(0)} Z`;

  // Show max ~8 x-axis labels
  const step = Math.max(1, Math.floor(data.length / 8));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" preserveAspectRatio="xMidYMid meet">
      {/* Y gridlines */}
      {Array.from({ length: yTicks + 1 }, (_, i) => {
        const val = Math.round((maxVal / yTicks) * i);
        const yPos = y(val);
        return (
          <g key={`y-${i}`}>
            <line x1={padL} x2={W - padR} y1={yPos} y2={yPos} stroke="#f0f0f0" strokeWidth="1" />
            <text x={padL - 8} y={yPos + 3} textAnchor="end" className="text-[10px]" fill="#9ca3af">{val}</text>
          </g>
        );
      })}
      {/* Area fill */}
      <path d={areaPath} fill="rgba(59,130,246,0.1)" />
      {/* Line */}
      <path d={linePath} fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinejoin="round" />
      {/* Dots */}
      {data.map((d, i) => (
        <circle key={i} cx={x(i)} cy={y(d.sent)} r="3" fill="#3b82f6" />
      ))}
      {/* Bounced dots */}
      {data.map((d, i) =>
        d.bounced > 0 ? <circle key={`b-${i}`} cx={x(i)} cy={y(d.bounced)} r="2.5" fill="#f87171" /> : null
      )}
      {/* Replied dots */}
      {data.map((d, i) =>
        d.replied > 0 ? <circle key={`r-${i}`} cx={x(i)} cy={y(d.replied)} r="2.5" fill="#4ade80" /> : null
      )}
      {/* X axis labels */}
      {data.map((d, i) =>
        i % step === 0 ? (
          <text key={`x-${i}`} x={x(i)} y={H - 8} textAnchor="middle" className="text-[10px]" fill="#9ca3af">
            {d.date.slice(5)}
          </text>
        ) : null
      )}
    </svg>
  );
}

/* ── Warmup Card ── */
function WarmupCard({ account }) {
  const { email, displayName, stageName, stageColor, daysSinceFirst, maxPerDay, totalSent } = account;
  const progress = maxPerDay > 0 ? Math.min((totalSent / (maxPerDay * 30)) * 100, 100) : 0;

  return (
    <div className="border border-gray-200 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">{displayName || email}</p>
          <p className="text-xs text-gray-500 truncate">{email}</p>
        </div>
        <span
          className="text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap"
          style={{
            backgroundColor: (stageColor || '#3b82f6') + '20',
            color: stageColor || '#3b82f6',
          }}
        >
          {stageName || 'Warming'}
        </span>
      </div>
      <div className="flex items-center justify-between text-xs text-gray-500 mb-2">
        <span>Day {daysSinceFirst ?? 0}</span>
        <span>{maxPerDay ?? 0}/day limit</span>
      </div>
      <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: `${progress}%`,
            backgroundColor: stageColor || '#3b82f6',
          }}
        />
      </div>
      <p className="text-[10px] text-gray-400 mt-1.5">{totalSent ?? 0} total warmup emails sent</p>
    </div>
  );
}

/* ── Icons ── */
function SendIcon() {
  return (
    <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
    </svg>
  );
}
function UsersIcon() {
  return (
    <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
    </svg>
  );
}
function EyeIcon() {
  return (
    <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}
function CursorIcon() {
  return (
    <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.042 21.672L13.684 16.6m0 0l-2.51 2.225.569-9.47 5.227 7.917-3.286-.672zM12 2.25V4.5m5.834.166l-1.591 1.591M20.25 10.5H18M7.757 14.743l-1.59 1.59M6 10.5H3.75m4.007-4.243l-1.59-1.59" />
    </svg>
  );
}
function ReplyIcon() {
  return (
    <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
    </svg>
  );
}
function BounceIcon() {
  return (
    <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
    </svg>
  );
}
function UnsubIcon() {
  return (
    <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M22 10.5h-6m-2.25-4.125a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zM4 19.235v-.11a6.375 6.375 0 0112.75 0v.109A12.318 12.318 0 0110.374 21c-2.331 0-4.512-.645-6.374-1.766z" />
    </svg>
  );
}
function StarIcon() {
  return (
    <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
    </svg>
  );
}
