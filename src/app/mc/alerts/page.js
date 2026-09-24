'use client';

import { useEffect, useState } from 'react';
import { box, btnGhost, api, Eyebrow, ago } from '../_ui/ui';

export default function Alerts() {
  const [alerts, setAlerts] = useState(null);
  const load = () => api('/api/mc/alerts').then((r) => setAlerts(r.alerts));
  useEffect(() => { load(); }, []);
  if (!alerts) return <p>Loading…</p>;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <Eyebrow>Mission Control / Alerts</Eyebrow>
      {alerts.length === 0 && <p>No alerts yet.</p>}
      {alerts.map((a) => (
        <div key={a.id} style={{ ...box, opacity: a.acknowledged ? 0.5 : 1, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ color: a.urgent ? 'var(--danger)' : 'var(--fg-muted)', fontWeight: 700 }}>{a.urgent ? 'URGENT' : 'info'}</span>
          <span style={{ flex: 1, minWidth: 200 }}>{a.title}</span>
          <span className="mono" style={{ fontSize: 12 }}>{ago(a.at)} · {a.delivered ? 'delivered' : 'NOT delivered'}</span>
          {!a.acknowledged && <button style={btnGhost} onClick={() => api('/api/mc/alerts', { action: 'ack', id: a.id }).then(load)}>Acknowledge</button>}
        </div>
      ))}
    </div>
  );
}
