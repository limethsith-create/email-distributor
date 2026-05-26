'use client';

import './globals.css';
import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  const links = [
    {
      href: '/',
      label: 'Dashboard',
      icon: (
        <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
        </svg>
      ),
    },
    {
      href: '/accounts',
      label: 'Accounts',
      icon: (
        <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
        </svg>
      ),
    },
    {
      href: '/compose',
      label: 'Compose',
      icon: (
        <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
        </svg>
      ),
    },
    {
      href: '/upload',
      label: 'Upload',
      icon: (
        <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
        </svg>
      ),
    },
    {
      href: '/history',
      label: 'History',
      icon: (
        <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
    },
  ];

  return (
    <aside
      className={`fixed left-0 top-0 h-screen bg-[#0d0d14] border-r border-[#2a2a3a] transition-all duration-300 z-50 flex flex-col ${
        collapsed ? 'w-16' : 'w-56'
      }`}
    >
      <div className="p-4 border-b border-[#2a2a3a] flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#5c7cfa] to-[#7c3aed] flex items-center justify-center flex-shrink-0">
          <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="white" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
        </div>
        {!collapsed && (
          <span className="text-sm font-semibold text-white tracking-wide">MailDistro</span>
        )}
      </div>

      <nav className="flex-1 py-4 px-2 space-y-1">
        {links.map((link) => {
          const isActive = pathname === link.href;
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all ${
                isActive
                  ? 'bg-[#5c7cfa]/15 text-[#91a7ff]'
                  : 'text-[#6b7280] hover:text-[#e8e8ed] hover:bg-[#1a1a25]'
              }`}
            >
              <span className="flex-shrink-0">{link.icon}</span>
              {!collapsed && <span>{link.label}</span>}
            </Link>
          );
        })}
      </nav>

      <button
        onClick={() => setCollapsed(!collapsed)}
        className="p-4 border-t border-[#2a2a3a] text-[#6b7280] hover:text-white transition-colors"
      >
        <svg
          width="16"
          height="16"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="2"
          className={`transition-transform ${collapsed ? 'rotate-180' : ''}`}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
      </button>
    </aside>
  );
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <title>MailDistro - Email Distribution System</title>
        <meta name="description" content="Multi-account Gmail email distribution system" />
      </head>
      <body className="antialiased">
        <Sidebar />
        <main className="ml-56 min-h-screen p-8">
          {children}
        </main>
      </body>
    </html>
  );
}
