// TEMP diagnostic: inspect due follow-ups and optionally force-send ONE.
// GET /api/cron/fu-debug?k=aviance-debug            -> report only
// GET /api/cron/fu-debug?k=aviance-debug&send=1&to=<email> -> send that one follow-up
import { kv } from '@vercel/kv';
import { sendEmail } from '@/lib/mailer';
import { getEmailForSequenceDay } from '@/lib/personalize';
import { flyerHtml } from '@/lib/flyer';
import { getSmtpAccounts } from '@/lib/smtp-accounts';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request) {
  const url = new URL(request.url);
  if (url.searchParams.get('k') !== 'aviance-debug') {
    return Response.json({ error: 'no' }, { status: 401 });
  }
  const doSend = url.searchParams.get('send') === '1';
  const target = (url.searchParams.get('to') || '').toLowerCase();

  const accounts = getSmtpAccounts();
  const all = await kv.hgetall('leads');
  const now = Date.now();
  const T = 3 * 24 * 60 * 60 * 1000;
  const due = [];
  for (const l of Object.values(all || {})) {
    if (!l.email || !l.sent_at) continue;
    const s = (l.status || '').toLowerCase();
    if (s === 'sent-d0' && now - new Date(l.sent_at).getTime() >= T) {
      due.push({ ...l, nextSequenceDay: 3 });
    } else if (s === 'sent-d3') {
      const d3 = l.d3_sent_at ? new Date(l.d3_sent_at).getTime() : new Date(l.sent_at).getTime() + T;
      if (now - d3 >= T) due.push({ ...l, nextSequenceDay: 7 });
    }
  }
  const report = due.slice(0, 25).map((l) => ({
    e: l.email,
    day: l.nextSequenceDay,
    acct: l.account_used,
    acctFound: !!accounts.find((a) => a.email === l.account_used),
  }));

  let sendResult = null;
  if (doSend && target) {
    const fu = due.find((l) => l.email.toLowerCase() === target);
    if (!fu) {
      sendResult = { err: 'target not in due list' };
    } else {
      const acc = accounts.find((a) => a.email === fu.account_used);
      if (!acc) {
        sendResult = { err: 'account not found: ' + fu.account_used };
      } else {
        const q = {
          ...fu,
          email: fu.email.toLowerCase().trim(),
          industry: fu.industry || 'business',
          company_name: fu.company || fu.company_name || 'your company',
          city: fu.city || 'USA',
          first_name: fu.first_name || (fu.name ? fu.name.split(/[\s,]/)[0] : null),
        };
        let ec = null;
        let html = null;
        let err = null;
        try {
          ec = getEmailForSequenceDay(q, fu.nextSequenceDay);
          html = fu.nextSequenceDay === 3 ? flyerHtml(q) : '<p>' + ec.body + '</p>';
        } catch (e) {
          err = 'template: ' + e.message;
        }
        if (!err) {
          try {
            sendResult = await sendEmail(acc, {
              to: q.email,
              subject: ec.subject,
              html,
              text: ec.body,
              inReplyTo: fu.original_message_id || undefined,
              references: fu.original_message_id || undefined,
            });
          } catch (e) {
            err = 'send threw: ' + e.message;
          }
        }
        sendResult = { ...(sendResult || {}), err, htmlLen: html ? html.length : 0, subject: ec ? ec.subject : null };
      }
    }
  }

  return Response.json({
    accounts: accounts.map((a) => a.email),
    dueCount: due.length,
    fuCounterToday: await kv.hget('daily_sends', '__followups__:' + new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())),
    report,
    sendResult,
  });
}
