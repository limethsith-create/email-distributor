'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
// Old Gmail accounts page — replaced by /inboxes
export default function AccountsRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/inboxes'); }, [router]);
  return null;
}
