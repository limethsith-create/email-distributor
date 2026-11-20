import { redirect } from 'next/navigation';

// The old outreach dashboard is gone; the owner works in the Aviance Hub, and
// Mission Control (/mc) holds the full control panel.
export default function Home() {
  redirect('/mc');
}
