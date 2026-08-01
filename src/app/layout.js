'use client';

import './globals.css';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV = [
  {
    href: '/', label: 'Dashboard',
    icon: <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25A2.25 2.25 0 0113.5 8.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />,
  },
  {
    href: '/inboxes', label: 'Inboxes',
    icon: <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />,
  },
  {
    href: '/leads', label: 'Leads',
    icon: <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />,
  },
  {
    href: '/scout', label: 'Scout',
    icon: <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />,
  },
  {
    href: '/offer', label: 'Offer',
    icon: <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z" />,
  },
];

function Icon({ children }) {
  return (
    <svg width="19" height="19" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.6">
      {children}
    </svg>
  );
}

function Sidebar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => { setMobileOpen(false); }, [pathname]);

  const Brand = (
    <div className="flex items-center gap-2.5">
      <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
           style={{ background: 'linear-gradient(135deg,#6e56cf,#9d7bf0)' }}>
        <span className="text-white font-bold text-sm">A</span>
      </div>
      <div className="leading-tight">
        <div className="text-[13px] font-semibold" style={{ color: 'var(--fg)' }}>Aviance</div>
        <div className="text-[11px]" style={{ color: 'var(--fg-dim)' }}>Outreach</div>
      </div>
    </div>
  );

  const NavList = ({ onNav }) => (
    <nav className="flex-1 py-3 px-2.5 space-y-0.5">
      {NAV.map((link) => {
        const active = pathname === link.href;
        return (
          <Link key={link.href} href={link.href} onClick={onNav}
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-[14px] transition-all"
            style={active
              ? { background: 'var(--accent-soft)', color: 'var(--accent)' }
              : { color: 'var(--fg-muted)' }}
            onMouseEnter={(e) => { if (!active) { e.currentTarget.style.background = 'var(--card-hover)'; e.currentTarget.style.color = 'var(--fg)'; } }}
            onMouseLeave={(e) => { if (!active) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--fg-muted)'; } }}>
            <Icon>{link.icon}</Icon>
            <span>{link.label}</span>
          </Link>
        );
      })}
    </nav>
  );

  return (
    <>
      <div className="md:hidden fixed top-0 inset-x-0 h-14 z-50 flex items-center px-4 gap-3"
           style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
        <button onClick={() => setMobileOpen(!mobileOpen)} className="p-1.5" style={{ color: 'var(--fg-muted)' }}>
          <svg width="22" height="22" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            {mobileOpen
              ? <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              : <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />}
          </svg>
        </button>
        {Brand}
      </div>

      {mobileOpen && <div className="md:hidden fixed inset-0 bg-black/40 z-40" onClick={() => setMobileOpen(false)} />}

      <aside className="hidden md:flex fixed top-0 left-0 h-screen w-60 z-50 flex-col"
             style={{ background: 'var(--bg-subtle)', borderRight: '1px solid var(--border)' }}>
        <div className="p-4" style={{ borderBottom: '1px solid var(--border)' }}>{Brand}</div>
        <NavList />
        <div className="p-3 text-[11px]" style={{ color: 'var(--fg-dim)', borderTop: '1px solid var(--border)' }}>
          Cold email · warmup active
        </div>
      </aside>

      <aside className={`md:hidden fixed top-14 left-0 h-[calc(100vh-3.5rem)] w-64 z-50 transition-transform duration-300 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}
             style={{ background: 'var(--bg-subtle)', borderRight: '1px solid var(--border)' }}>
        <NavList onNav={() => setMobileOpen(false)} />
      </aside>
    </>
  );
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <title>Aviance Outreach</title>
        <meta name="description" content="Automated cold email outreach with warmup" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
      </head>
      <body>
        <Sidebar />
        <main className="relative z-10 pt-14 md:pt-0 md:ml-60 min-h-screen p-4 md:p-8">
          <div className="max-w-[1080px]">{children}</div>
        </main>
      </body>
    </html>
  );
}
