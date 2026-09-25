/**
 * The public booking page (docs/CALENDAR.md), as plain server-rendered HTML:
 * it works on any phone with no script at all (radio buttons + one submit
 * button; the zone switcher is a GET form, and a one-line script only saves
 * the extra tap). Pure: data in, HTML out, every value escaped.
 *
 * Plain words, big buttons, one thing to do per screen.
 */

/** Headers for every booking page answer: HTML, never cached (it shows live times), never indexed. */
export const HTML_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, private', 'X-Robots-Tag': 'noindex' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STYLE = `
  *{box-sizing:border-box}
  body{margin:0;padding:24px 16px 48px;font:17px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;background:#f6f5f1}
  main{max-width:560px;margin:0 auto}
  .eyebrow{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#6b6b6b;margin:0 0 6px}
  h1{font-size:26px;line-height:1.25;margin:0 0 10px}
  h2{font-size:16px;margin:22px 0 8px;color:#333}
  p{margin:0 0 12px}
  .card{background:#fff;border:1px solid #e2e0da;border-radius:10px;padding:18px 18px 8px;margin:16px 0}
  .flash{border-radius:10px;padding:14px 16px;margin:16px 0;font-weight:600}
  .ok{background:#e8f5ec;border:1px solid #9fd3ae}
  .warn{background:#fff4e0;border:1px solid #f0c77a}
  .zone{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0 4px;font-size:15px}
  select{font-size:16px;padding:8px 10px;border:1px solid #bbb;border-radius:8px;background:#fff}
  .slots{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:8px}
  .slot{position:relative;display:block}
  .slot input{position:absolute;opacity:0;width:1px;height:1px}
  .slot span{display:block;text-align:center;padding:14px 6px;border:1.5px solid #c9c6bd;border-radius:10px;background:#fff;font-weight:600;cursor:pointer}
  .slot input:checked + span{background:#111;border-color:#111;color:#fff}
  .slot input:focus-visible + span{outline:3px solid #6aa0ff;outline-offset:2px}
  label.note{display:block;font-weight:600;margin:22px 0 6px}
  textarea{width:100%;font:inherit;font-size:16px;padding:10px 12px;border:1px solid #bbb;border-radius:10px;min-height:84px}
  .go{display:block;width:100%;margin:18px 0 8px;padding:16px;font-size:18px;font-weight:700;color:#fff;background:#111;border:0;border-radius:12px;cursor:pointer}
  .ghost{display:inline-block;margin:6px 0 12px;padding:12px 16px;font-size:16px;font-weight:600;color:#111;background:#fff;border:1.5px solid #111;border-radius:12px;text-decoration:none;cursor:pointer}
  .small{font-size:14px;color:#666}
  .when{font-size:20px;font-weight:700}
`;

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="eyebrow">Aviance · onboarding call</p>
${body}
</main>
</body>
</html>`;
}

/** A page with one message (bad link, closed page, done). `link` = { href, text } for one button. */
export function messagePage(title, text, link = null) {
  return page(title, `<h1>${esc(title)}</h1>
<p>${esc(text)}</p>
${link ? `<a class="ghost" href="${esc(link.href)}">${esc(link.text)}</a>` : ''}`);
}

const FLASH = {
  sent: ['ok', "Got it — I'll confirm by email shortly."],
  taken: ['warn', 'Sorry — that time was just taken. Please pick another.'],
  limit: ['warn', 'Too many tries for now — please wait a few minutes, or reply to my email.'],
  gone: ['warn', 'Sorry — that time has gone. Please pick another.'],
  error: ['warn', 'Something went wrong — please try again, or reply to my email.'],
  pick: ['warn', 'Pick one of the times first.'],
};

/**
 * The booking page. `data` from calendar.bookingPageData; `token` is the raw
 * link token (it only ever goes back to this site); `flash` one of FLASH;
 * `change` shows the times again under an existing request or booking.
 */
export function bookingPage(data, { token, flash = null, change = false } = {}) {
  const base = `/c/${encodeURIComponent(token)}/book`;
  if (data.held) return messagePage('Our call is done', 'Thank you for your time. Reply to my last email if you need anything.');
  if (data.closed) return messagePage('This page is closed', 'Reply to my last email and we\'ll sort out a time.');
  const ex = data.existing;
  const parts = [];
  const f = Object.hasOwn(FLASH, String(flash)) ? FLASH[flash] : null;
  if (f) parts.push(`<div class="flash ${f[0]}" role="status">${esc(f[1])}</div>`);

  let showSlots = true;
  if (ex && ex.status === 'confirmed') {
    parts.push(`<h1>You're booked</h1>
<div class="card"><p class="when">${esc(ex.label)}</p><p>${esc(data.zoneName)} · ${esc(ex.minutes)} minutes. The calendar invite is in your email.</p>${data.meetingLink ? `<p>Join here: <a href="${esc(data.meetingLink)}">${esc(data.meetingLink)}</a></p>` : ''}</div>`);
    if (!change) { parts.push(`<a class="ghost" href="${esc(`${base}?change=1&tz=${encodeURIComponent(data.zone)}`)}">Ask for a different time</a>`); showSlots = false; }
  } else if (ex && ex.status === 'requested' && ex.proposed) {
    parts.push(`<h1>How about this time?</h1>
<div class="card"><p>You asked for ${esc(ex.label)}. I suggested instead:</p><p class="when">${esc(ex.proposedLabel)}</p><p>${esc(data.zoneName)} · ${esc(ex.minutes)} minutes.</p>
<form method="post" action="${esc(`${base}/accept?m=${encodeURIComponent(ex.id)}`)}"><button class="go" type="submit">Yes, that works</button></form></div>
<h2>Or pick another time</h2>`);
  } else if (ex && ex.status === 'requested') {
    parts.push(`<h1>Thanks — you asked for a time</h1>
<div class="card"><p class="when">${esc(ex.label)}</p><p>${esc(data.zoneName)}. I'll confirm by email shortly.</p></div>`);
    if (!change) { parts.push(`<a class="ghost" href="${esc(`${base}?change=1&tz=${encodeURIComponent(data.zone)}`)}">Ask for a different time</a>`); showSlots = false; }
  } else {
    parts.push(`<h1>Pick a time for our call</h1>
<p>${data.firstName ? `Hi ${esc(data.firstName)} — c` : 'C'}hoose a time that suits you for our ${esc(data.callMinutes)}-minute onboarding call. I'll confirm by email.</p>`);
  }

  if (showSlots) {
    const options = data.zones.map((z) => `<option value="${esc(z.tz)}"${z.tz === data.zone ? ' selected' : ''}>${esc(z.name)}</option>`).join('');
    parts.push(`<form class="zone" method="get" action="${esc(base)}">${change ? '<input type="hidden" name="change" value="1">' : ''}<label for="tz">Times shown in</label>
<select id="tz" name="tz" onchange="this.form.submit()">${options}</select><noscript><button class="ghost" type="submit">Show</button></noscript></form>`);
    if (!data.days.length) {
      parts.push(`<div class="card"><p>No open times in the next ${esc(data.daysAhead)} days right now. Reply to my email and we'll find one.</p></div>`);
    } else {
      const days = data.days.map((d) => `<h2>${esc(d.label)}</h2>
<div class="slots">${d.slots.map((s) => `<label class="slot"><input type="radio" name="start" value="${esc(s.start)}" required><span>${esc(s.label)}</span></label>`).join('')}</div>`).join('\n');
      parts.push(`<form method="post" action="/api/c/book">
<input type="hidden" name="token" value="${esc(token)}">
<input type="hidden" name="tz" value="${esc(data.zone)}">
${days}
<label class="note" for="note">Anything I should know? (optional)</label>
<textarea id="note" name="note" maxlength="500"></textarea>
<button class="go" type="submit">${ex ? 'Ask for this time instead' : 'Ask for this time'}</button>
</form>
<p class="small">Times are in ${esc(data.zoneName)}. Nothing here works? Reply to my email.</p>`);
    }
  }
  return page('Book your onboarding call', parts.join('\n'));
}

/** The one-click answer to an owner's suggested time: one big button (a form POST, so link scanners cannot press it). */
export function acceptPage({ token, meeting, zoneName, done = false, flash = null }) {
  const book = `/c/${encodeURIComponent(token)}/book`;
  if (done) {
    return page("You're booked", `<h1>You're booked</h1>
<div class="card"><p class="when">${esc(meeting.label)}</p><p>${esc(zoneName)} · ${esc(meeting.minutes)} minutes. A calendar invite is on its way to your inbox.</p></div>
<a class="ghost" href="${esc(book)}">See your booking</a>`);
  }
  const f = Object.hasOwn(FLASH, String(flash)) ? FLASH[flash] : null;
  return page('How about this time?', `${f ? `<div class="flash ${f[0]}" role="status">${esc(f[1])}</div>` : ''}<h1>How about this time?</h1>
<div class="card"><p class="when">${esc(meeting.proposedLabel)}</p><p>${esc(zoneName)} · ${esc(meeting.minutes)} minutes.</p>
<form method="post" action="${esc(`${book}/accept?m=${encodeURIComponent(meeting.id)}`)}"><button class="go" type="submit">Yes, that works</button></form></div>
<a class="ghost" href="${esc(book)}">Pick a different time</a>`);
}
