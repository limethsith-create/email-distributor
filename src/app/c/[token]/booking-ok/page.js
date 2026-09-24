'use client';

/**
 * /c/{token}/booking-ok — the one-tap "It worked" button from the booking
 * link test (SPEC §6.7). The tap is a POST so link scanners cannot fire it.
 */

import { useState } from 'react';
import { box, btn, Eyebrow } from '@/app/mc/_ui/ui';

export default function BookingOk({ params }) {
  const [state, setState] = useState({ done: false, msg: '' });

  async function tap() {
    setState({ done: false, msg: 'Saving…' });
    const res = await fetch('/api/c/booking-ok', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: params.token }) });
    const j = await res.json().catch(() => ({}));
    setState(res.ok ? { done: true, msg: 'Thank you — noted. Please cancel the test booking if you have not yet.' } : { done: false, msg: j.error || 'Something went wrong.' });
  }

  return (
    <div style={{ maxWidth: 560, margin: '0 auto', display: 'grid', gap: 16 }}>
      <Eyebrow>Aviance 30-Day Trial</Eyebrow>
      <div style={{ ...box, display: 'grid', gap: 12 }}>
        <p style={{ margin: 0 }}>Did the test booking go through from a personal email address?</p>
        {!state.done && <button style={btn} onClick={tap}>It worked</button>}
        {state.msg && <p style={{ margin: 0 }}>{state.msg}</p>}
      </div>
    </div>
  );
}
