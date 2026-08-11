'use client';

import './globals.css';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV = [
  { href: '/', label: 'Dashboard' },
  { href: '/inboxes', label: 'Inboxes' },
  { href: '/leads', label: 'Leads' },
  { href: '/replies', label: 'Replies' },
  { href: '/activity', label: 'Activity' },
  { href: '/offer', label: 'Offer' },
];

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2.5" style={{ textDecoration: 'none' }}>
      {/* red mark */}
      <span style={{
        width: 26, height: 26, background: 'var(--accent)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        transform: 'rotate(45deg)', border: '1.5px solid #0a0a0a',
      }}>
        <span style={{ transform: 'rotate(-45deg)', color: '#fff', fontWeight: 800, fontSize: 13, lineHeight: 1 }}>A</span>
      </span>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ color: 'var(--fg)', fontWeight: 800, fontSize: 17, letterSpacing: '0.02em' }}>AVIANCE</span>
        <span className="mono" style={{ color: 'var(--fg-dim)', fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase' }}>Outreach</span>
      </span>
    </Link>
  );
}

function TopNav() {
  const pathname = usePathname();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    window.addEventListener('scroll', onScroll);
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header style={{
      position: 'sticky', top: 0, zIndex: 50, background: 'rgba(255,255,255,0.92)',
      backdropFilter: 'saturate(180%) blur(8px)', WebkitBackdropFilter: 'saturate(180%) blur(8px)',
      borderBottom: '1px solid #111',
      boxShadow: scrolled ? '0 1px 0 rgba(0,0,0,0.04)' : 'none',
    }}>
      <div style={{
        maxWidth: 1280, margin: '0 auto', height: 62, padding: '0 24px',
        display: 'flex', alignItems: 'center', gap: 24,
      }}>
        <Brand />

        <nav style={{
          display: 'flex', alignItems: 'stretch', gap: 4, marginLeft: 'auto',
          overflowX: 'auto', height: '100%',
        }}>
          {NAV.map((link, i) => {
            const active = pathname === link.href;
            return (
              <Link key={link.href} href={link.href}
                className="mono"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 7,
                  padding: '0 12px', height: '100%',
                  textDecoration: 'none', whiteSpace: 'nowrap',
                  fontSize: 12, letterSpacing: '0.12em', textTransform: 'uppercase',
                  color: active ? 'var(--fg)' : 'var(--fg-muted)',
                  borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
                  transition: 'color .15s',
                }}
                onMouseEnter={(e) => { if (!active) e.currentTarget.style.color = 'var(--fg)'; }}
                onMouseLeave={(e) => { if (!active) e.currentTarget.style.color = 'var(--fg-muted)'; }}>
                <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{String(i).padStart(2, '0')}</span>
                <span>{link.label}</span>
              </Link>
            );
          })}
        </nav>

        <a href="https://www.aviance.online" target="_blank" rel="noopener noreferrer"
          className="mono"
          style={{
            flexShrink: 0, background: '#0a0a0a', color: '#fff', textDecoration: 'none',
            padding: '10px 16px', fontSize: 11.5, fontWeight: 600, letterSpacing: '0.12em',
            textTransform: 'uppercase', display: 'inline-flex', alignItems: 'center', gap: 8,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = '#0a0a0a'; }}>
          aviance.online <span aria-hidden>→</span>
        </a>
      </div>
    </header>
  );
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <title>Aviance Outreach</title>
        <meta name="description" content="Done-for-you cold email — guaranteed booked calls" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <TopNav />
        <main style={{ minHeight: '100vh' }}>
          <div style={{ maxWidth: 1280, margin: '0 auto', padding: '32px 24px 64px' }}>
            {children}
          </div>
        </main>
      </body>
    </html>
  );
}
