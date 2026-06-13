'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
// Old Meta chatbot messages page — removed from the app
export default function MessagesRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/'); }, [router]);
  return null;
}
