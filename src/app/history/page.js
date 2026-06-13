'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
// Old history page — folded into Leads
export default function HistoryRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/leads'); }, [router]);
  return null;
}
