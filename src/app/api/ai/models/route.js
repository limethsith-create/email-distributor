// TEMP diagnostic — lists which Gemini models this key can use.
// Returns model names + the HTTP status of the list call. No key material is exposed.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return Response.json({ error: 'no key' });
  const out = { keyPrefix: key.slice(0, 4), keyLen: key.length };
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=200`,
      { signal: AbortSignal.timeout(10000) }
    );
    out.listStatus = res.status;
    if (res.ok) {
      const d = await res.json();
      out.count = (d.models || []).length;
      out.models = (d.models || [])
        .map((m) => ({ name: m.name, gen: (m.supportedGenerationMethods || []).join(',') }))
        .slice(0, 60);
    } else {
      out.body = (await res.text()).slice(0, 500);
    }
  } catch (e) {
    out.err = String((e && e.message) || e);
  }
  return Response.json(out);
}
