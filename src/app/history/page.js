'use client';

import { useState, useEffect } from 'react';

export default function HistoryPage() {
  const [campaigns, setCampaigns] = useState([]);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    const history = localStorage.getItem('mail-distro-campaigns');
    if (history) setCampaigns(JSON.parse(history).reverse());
  }, []);

  const clearHistory = () => {
    localStorage.removeItem('mail-distro-campaigns');
    setCampaigns([]);
    setSelected(null);
  };

  return (
    <div className="max-w-5xl animate-fade-in">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white mb-1">Campaign History</h1>
          <p className="text-[#6b7280] text-sm">View past campaigns and their results</p>
        </div>
        {campaigns.length > 0 && (
          <button
            onClick={clearHistory}
            className="px-4 py-2 text-[#fa5252] hover:bg-[#fa5252]/10 text-sm rounded-lg transition-colors border border-[#fa5252]/20"
          >
            Clear History
          </button>
        )}
      </div>

      {campaigns.length === 0 ? (
        <div className="p-12 bg-[#12121a] border border-[#2a2a3a] rounded-xl text-center">
          <p className="text-[#6b7280] text-sm">No campaigns sent yet.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Campaign List */}
          <div className="space-y-3">
            {campaigns.map((campaign, idx) => {
              const sent = campaign.results?.filter(r => r.status === 'sent').length || 0;
              const failed = campaign.results?.filter(r => r.status === 'failed').length || 0;
              const total = campaign.results?.length || campaign.recipientCount || 0;

              return (
                <button
                  key={idx}
                  onClick={() => setSelected(campaign)}
                  className={`w-full text-left p-4 bg-[#12121a] border rounded-xl transition-all ${
                    selected === campaign ? 'border-[#5c7cfa]/50' : 'border-[#2a2a3a] hover:border-[#3a3a4a]'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm text-white font-medium truncate max-w-[200px]">
                      {campaign.subject || 'Untitled'}
                    </p>
                    <span className="text-xs text-[#6b7280]">
                      {new Date(campaign.timestamp).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs">
                    <span className="text-[#40c057]">{sent} sent</span>
                    {failed > 0 && <span className="text-[#fa5252]">{failed} failed</span>}
                    <span className="text-[#6b7280]">{total} total</span>
                  </div>
                  {campaign.accountsUsed && (
                    <p className="text-xs text-[#4a4a5a] mt-2 truncate">
                      via {campaign.accountsUsed.join(', ')}
                    </p>
                  )}
                </button>
              );
            })}
          </div>

          {/* Campaign Detail */}
          {selected && (
            <div className="p-5 bg-[#12121a] border border-[#2a2a3a] rounded-xl sticky top-8">
              <h3 className="text-sm font-semibold text-white mb-4">
                {selected.subject || 'Untitled Campaign'}
              </h3>
              <p className="text-xs text-[#6b7280] mb-4">
                {new Date(selected.timestamp).toLocaleString()}
              </p>

              {selected.results && selected.results.length > 0 ? (
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {selected.results.map((r, i) => (
                    <div key={i} className="flex items-center gap-3 py-2 px-3 rounded-lg bg-[#0a0a0f]">
                      <span className={`w-2 h-2 rounded-full ${r.status === 'sent' ? 'bg-[#40c057]' : 'bg-[#fa5252]'}`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-white truncate">{r.to}</p>
                        <p className="text-xs text-[#4a4a5a]">via {r.from}</p>
                      </div>
                      <span className={`text-xs ${r.status === 'sent' ? 'text-[#40c057]' : 'text-[#fa5252]'}`}>
                        {r.status}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-[#6b7280]">No detailed results available</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
