import { redirect } from 'next/navigation';

// The Mission Control board is gone: the owner works in the Aviance Hub. /mc stays as a door to the
// settings page, which the hub's "Full control panel" button and old bookmarks still open.
export default function Mission() {
  redirect('/mc/config');
}
