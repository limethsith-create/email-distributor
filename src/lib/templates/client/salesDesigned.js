/**
 * The designed (branded) HTML for the website sales-call emails: the
 * confirmation and the day-before, 1-hour and 5-minute reminders. Same look
 * as aviance.online — black / white / red #E0290F, the cube logo, one big
 * button. The plain-text body from templates/client/sales.js still goes with
 * every message (text part), so nothing is lost where HTML is off.
 *
 * Email-safe: tables + inline styles only, no web fonts required (Inter Tight
 * where the reader has it, else Helvetica/Arial), the logo as a hosted PNG.
 *
 * designedSalesHtml(key, ctx) → string, or null for any other template key.
 * ctx: { firstName, when, whenShort, minutes, link, company, planLine,
 *        guaranteeLine, ownerName, replyTo, start, end }
 */

const RED = '#E0290F';
const LOGO = 'https://www.aviance.online/logo-180.png';
const SITE = 'https://www.aviance.online/';
const FONT = "'Inter Tight',Helvetica,Arial,sans-serif";
const MONO = "'JetBrains Mono','Courier New',monospace";

const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A Google Calendar "add event" link for the call — works without any account setup on our side. */
export function googleCalendarUrl({ start, end, title, details }) {
  const t = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const s = Date.parse(start);
  if (!Number.isFinite(s)) return null;
  const e = Number.isFinite(Date.parse(end)) ? Date.parse(end) : s + 15 * 60e3;
  const q = new URLSearchParams({ action: 'TEMPLATE', text: title, dates: `${t(s)}/${t(e)}`, details: details || '' });
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}

const mailto = (to, subject) => (to ? `mailto:${to}?subject=${encodeURIComponent(subject)}` : null);

function button(label, href, { dark = false } = {}) {
  if (!href) return '';
  const bg = dark ? '#000000' : RED;
  const shadow = dark ? RED : '#000000';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 0">
<tr><td style="background:${shadow};padding:0 6px 6px 0">
<a href="${esc(href)}" target="_blank" style="display:block;background:${bg};color:#ffffff;text-decoration:none;font-family:${FONT};font-weight:900;font-size:22px;letter-spacing:-0.3px;text-align:center;padding:22px 16px;border:2px solid #000000">${esc(label)}</a>
</td></tr></table>`;
}

function whenBox(label, main, sub) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0;border:1.5px solid #000000">
<tr><td width="92" style="background:#000000;color:#ffffff;font-family:${MONO};font-size:10px;letter-spacing:1px;text-transform:uppercase;padding:14px 12px;vertical-align:middle">${esc(label)}</td>
<td style="padding:12px 16px;font-family:${FONT};font-size:18px;font-weight:800;line-height:1.25;color:#000000">${esc(main)}${sub ? `<div style="font-weight:400;font-size:12px;color:#5C5C5C;margin-top:3px">${esc(sub)}</div>` : ''}</td></tr></table>`;
}

const kicker = (t) => `<div style="font-family:${MONO};font-size:11px;letter-spacing:1px;text-transform:uppercase;color:${RED};margin:0 0 14px">${esc(t)}</div>`;
const h1 = (black, red) => `<h1 style="margin:0;font-family:${FONT};font-size:40px;line-height:1.02;font-weight:900;letter-spacing:-1.5px;color:#000000">${esc(black)}${red ? ` <span style="color:${RED}">${esc(red)}</span>` : ''}</h1>`;
const para = (html) => `<p style="margin:18px 0 0;font-family:${FONT};font-size:16px;line-height:1.55;color:#222222">${html}</p>`;
const under = (t) => `<div style="font-family:${MONO};font-size:10px;letter-spacing:0.8px;text-transform:uppercase;color:#5C5C5C;text-align:center;margin-top:14px">${esc(t)}</div>`;
const big = (t) => `<div style="font-family:${FONT};font-size:96px;line-height:0.9;font-weight:900;letter-spacing:-4px;color:${RED};margin:0 0 12px">${esc(t)}</div>`;

function shell({ step, preheader, body, footLeft }) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only">
<link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;800;900&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet"></head>
<body style="margin:0;padding:0;background:#f3f3f3">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f3f3"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border:1.5px solid #000000">
<tr><td style="padding:22px 28px 14px;border-bottom:1.5px solid #000000">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="font-family:${FONT};font-weight:800;font-size:18px;letter-spacing:-0.3px;text-transform:uppercase;color:#000000"><a href="${SITE}" style="color:#000000;text-decoration:none"><img src="${LOGO}" width="28" height="28" alt="" style="vertical-align:middle;border:0;margin-right:8px">Aviance</a></td>
<td align="right" style="font-family:${MONO};font-size:10px;letter-spacing:1px;text-transform:uppercase;color:${RED}">${esc(step)}</td>
</tr></table></td></tr>
<tr><td style="padding:34px 28px 34px">${body}</td></tr>
<tr><td style="padding:12px 28px;border-top:1px solid #dddddd;font-family:${MONO};font-size:10px;letter-spacing:0.8px;text-transform:uppercase;color:#5C5C5C">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td>${esc(footLeft)}</td><td align="right"><a href="${SITE}" style="color:#5C5C5C;text-decoration:none">aviance.online</a></td></tr></table>
</td></tr></table></td></tr></table></body></html>`;
}

export function designedSalesHtml(key, c = {}) {
  const name = c.firstName || 'there';
  const join = c.link || null;
  const noLinkHref = mailto(c.replyTo, 'Video link for our call');
  if (key === 'sales_call_confirmed') {
    const cal = googleCalendarUrl({ start: c.start, end: c.end, title: `Aviance call${c.company ? ` · ${c.company}` : ''}`, details: join ? `Join: ${join}` : 'Video link to follow by email.' });
    return shell({
      step: 'You’re booked',
      preheader: `Our ${c.minutes || 15}-minute call is ${c.when}.`,
      footLeft: 'Live in 2 weeks · Double back in month one',
      body: kicker(`You’re in, ${name} ✓`) + h1('You’re booked.', 'Let’s talk growth.')
        + whenBox('Your call', c.when, `${c.minutes || 15} minutes · ${join ? 'video link below' : 'video link sent before the call'}`)
        + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px">${[
          `Whether cold email fits ${c.company || 'your business'} (if not, you’ll hear it straight away)`,
          c.planLine, 'Think of your best 2–3 customers — we’ll aim for more like them',
        ].filter(Boolean).map((t) => `<tr><td width="22" valign="top" style="font-family:${FONT};font-weight:800;color:${RED};font-size:15px;padding:4px 0">→</td><td style="font-family:${FONT};font-size:14px;line-height:1.45;color:#222222;padding:4px 0">${esc(t)}</td></tr>`).join('')}</table>`
        + button('Add it to my calendar ✓', cal, { dark: true })
        + (join ? button('Join link →', join) : '')
        + under('Calendar invite attached too · Need another time? Just reply')
        + (c.guaranteeLine ? para(`<span style="font-size:13px;color:#5C5C5C">${esc(c.guaranteeLine)}</span>`) : '')
        + para(esc(c.ownerName || 'The Aviance team')),
    });
  }
  if (key === 'sales_call_tomorrow') {
    return shell({
      step: 'The day before',
      preheader: `Our call is ${c.when}.`,
      footLeft: 'Aviance · Guaranteed booked sales calls',
      body: kicker(`Quick reminder, ${name}`) + h1('See you', 'tomorrow.')
        + whenBox('Tomorrow', c.whenShort || c.when, `${c.minutes || 15} minutes · ${join ? 'join with the link below' : 'we’ll send the video link'}`)
        + para('One thing to bring: your best 2–3 customers. In 15 minutes we’ll show you how we’d find more just like them.')
        + button('I’ll be there 👍', mailto(c.replyTo, 'See you tomorrow'))
        + under('Need a different time? Just reply to this email'),
    });
  }
  if (key === 'sales_call_soon') {
    return shell({
      step: '1 hour before',
      preheader: `Our call starts in about an hour (${c.whenShort || c.when}).`,
      footLeft: 'Aviance',
      body: big('1h') + h1('Our call starts', 'in an hour.')
        + whenBox('Today', c.whenShort || c.when, `${c.minutes || 15} minutes`)
        + (join ? button('Join the call →', join) : button('Send me the video link →', noLinkHref))
        + under(join ? 'See you shortly' : 'Reply and we’ll send it straight away'),
    });
  }
  if (key === 'sales_call_now') {
    return shell({
      step: '5 minutes before',
      preheader: 'We’re starting in 5 minutes.',
      footLeft: 'Aviance',
      body: big('5:00') + h1('We’re starting', 'in 5 minutes.')
        + para(`Hi ${esc(name)}, just a heads-up. Grab a coffee and jump in.`)
        + (join ? button('Join now →', join) : button('Send me the video link →', noLinkHref))
        + under(join ? 'See you in a minute' : 'No link yet? Reply and we’ll send it straight away'),
    });
  }
  return null;
}
