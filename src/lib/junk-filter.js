// Junk / non-reply detection for the Replies tab.
// Bounce (DSN) notifications, mailer-daemon noise, out-of-office acks, and raw
// MIME fragments were ingested as "replies" before the reply-checker gained its
// bounce filter. This module hides any such leftover entries from the dashboard
// so the Replies tab only ever shows real, human prospect conversations.
// Display-side only: it never deletes anything. The /api/replies/cleanup route
// uses the same predicates to purge the leftovers from KV permanently.

const JUNK_SENDER_RE = /mailer-daemon|postmaster|no-?reply|do-?not-?reply|donotreply|bounce/i;

const JUNK_SUBJECT_RE = /delivery status|undeliverable|mail delivery failed|mail delivery subsystem|returned mail|failure notice|delivery has failed|message not delivered|could not be delivered|delivery incomplete|out of office|automatic reply|auto-reply|autoreply/i;

const MIME_NOISE_RE = /content-type\s*:|multipart\/alternative|multipart\/mixed|multipart\/related|multipart\/report|boundary=|content-transfer-encoding|mime-version|--[0-9a-f]{12,}/i;

function textLooksLikeNoise(s) {
    const t = String(s || '').trim();
    if (!t) return false;
    if (MIME_NOISE_RE.test(t)) return true;
    const letters = (t.match(/[a-z]/gi) || []).length;
    if (t.length > 40 && letters / t.length < 0.35) return true;
    return false;
}

export function isJunkText(subject, preview) {
    if (JUNK_SUBJECT_RE.test(String(subject || ''))) return true;
    if (textLooksLikeNoise(preview)) return true;
    if (textLooksLikeNoise(subject)) return true;
    return false;
}

export function isJunkReply(r) {
    if (!r) return true;
    const from = String(r.from || r.leadEmail || '');
    if (JUNK_SENDER_RE.test(from)) return true;
    return isJunkText(r.subject, r.preview);
}

export function isJunkConversation(c) {
    if (!c || !Array.isArray(c.messages) || c.messages.length === 0) return true;
    if (JUNK_SENDER_RE.test(String(c.email || ''))) return true;
    if (c.messages.some(function (m) { return m && m.dir === 'out'; })) return false;
    const inbound = c.messages.filter(function (m) { return m && m.dir === 'in'; });
    if (inbound.length === 0) return true;
    return inbound.every(function (m) { return isJunkText(m.subject, m.text); });
}
