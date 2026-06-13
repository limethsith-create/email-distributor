'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
// Old upload page — replaced by /leads
export default function UploadRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/leads'); }, [router]);
  return null;
}
