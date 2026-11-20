/**
 * IMAP clients that never crash the function. A refused sign-in (a wrong Gmail app password, say)
 * left the connection dead, and logging out of it rejected outside our try/catch → "Unhandled
 * Rejection" and the whole function exited. guardImap() swallows the client's own error events;
 * closeImap() only logs out of a live connection and otherwise just closes the socket.
 */
export function guardImap(client) {
  try { client.on('error', () => {}); } catch {}
  return client;
}

export async function closeImap(client, ms = 2000) {
  if (!client) return;
  if (client.usable) {
    let t;
    const p = client.logout().catch(() => {});
    await Promise.race([p, new Promise((r) => { t = setTimeout(r, ms); })]).finally(() => clearTimeout(t));
  }
  try { client.close(); } catch {}
}
