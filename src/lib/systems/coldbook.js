/**
 * Cold-call booking: the owner books a sales call himself, from the hub Calendar, while on the phone.
 * (docs/HUB-API.md "cold-call booking".) The booking goes through the same path as a website booking
 * (inquiries.js saveInquiry → Calendar sales call, confirmation email, reminders, alert, research);
 * this file holds only what is new: the pure helpers (free-mail list, website from the email, time zone
 * from the state or the phone's area code, the "when" wording) and the check that previews a booking.
 */

import { zoneForState, zoneInfo, meetingsBetween, clashWith, inCallHours, calendarSettings } from '@/lib/systems/calendar';
import { normaliseWebsite, normalisePhone, saveInquiry } from '@/lib/systems/inquiries';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DAY_MS = 86400e3;

/** Mail providers whose address says nothing about the person's own website. */
export const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com', 'aol.com',
  'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me', 'gmx.com', 'gmx.net', 'gmx.de',
  'zoho.com', 'zohomail.com', 'mail.com', 'yandex.com', 'yandex.ru',
]);
const isFreeMail = (d) => FREE_MAIL.has(d) || /^(outlook|hotmail|live|yahoo)\.[a-z.]+$/.test(d);

/** 'bob@stoneroofing.com' → 'https://stoneroofing.com'; null for a free mail domain or a bad address. */
export function websiteFromEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(e)) return null;
  const domain = e.split('@')[1];
  return isFreeMail(domain) ? null : normaliseWebsite(domain) || null;
}

// ─── US area code → time zone (by zone; split states use the zone most of the state is in) ───

const zoneCodes = (tz, list) => list.trim().split(/\s+/).map((c) => [c, tz]);
export const AREA_TZ = Object.fromEntries([
  ...zoneCodes('America/New_York', `
    203 475 860 959 302 202 771 239 305 321 324 352 386 407 561 645 656 689 727 754 772 786 813 863 904 941 954
    229 404 470 678 706 762 770 912 943 317 463 574 765 812 930 502 606 859 207 227 240 301 410 443 667
    339 351 413 508 617 774 781 857 978 231 248 269 313 517 586 616 679 734 810 906 947 989 603
    201 551 609 640 732 848 856 862 908 973 212 315 332 347 363 516 518 585 607 631 646 680 716 718 838 845 914 917 929 934
    252 336 704 743 828 910 919 980 984 216 220 234 330 380 419 440 513 567 614 740 937
    215 223 267 272 412 445 484 570 582 610 717 724 814 835 878 401 803 821 839 843 854 864 423 865 802
    276 434 540 571 703 757 804 826 948 304 681`),
  ...zoneCodes('America/Chicago', `
    205 251 256 334 659 938 479 501 870 850 448 217 224 309 312 331 618 630 708 773 779 815 847 872 219
    319 515 563 641 712 316 620 785 913 270 364 225 318 337 504 985 218 320 507 612 651 763 952
    228 601 662 769 314 417 557 573 636 660 816 975 308 402 531 701 405 539 572 580 918 605
    615 629 731 901 931 210 214 254 281 325 346 361 409 430 432 469 512 682 713 726 737 806 817 830 832 903 936 940 956 972 979
    262 274 414 534 608 715 920`),
  ...zoneCodes('America/Denver', '303 719 720 970 983 208 986 406 505 575 385 435 801 307 915'),
  ...zoneCodes('America/Phoenix', '480 520 602 623 928'),
  ...zoneCodes('America/Los_Angeles', `
    209 213 279 310 323 341 350 369 408 415 424 442 510 530 559 562 619 626 628 650 657 661 669 707 714 747 760 805 818 820
    831 840 858 909 916 925 949 951 702 725 775 458 503 541 971 206 253 360 425 509 564`),
  ...zoneCodes('America/Anchorage', '907'),
  ...zoneCodes('Pacific/Honolulu', '808'),
]);

/** A US phone number → its area code (+1 and punctuation ignored); null when it does not look like one. */
export function areaCodeOf(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  return d.length === 10 ? d.slice(0, 3) : null;
}
export const zoneForPhone = (phone) => AREA_TZ[areaCodeOf(phone)] || null;

const validZone = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

/** Their zone: entered, else the state, else the phone's area code, else US Eastern. → { tz, from } */
export function theirZoneFor({ theirTz, state, phone } = {}) {
  const entered = String(theirTz || '').trim();
  if (entered && validZone(entered)) return { tz: entered, from: 'entered' };
  const byState = zoneForState(state);
  if (byState) return { tz: byState, from: 'state' };
  const byPhone = zoneForPhone(phone);
  if (byPhone) return { tz: byPhone, from: 'phone' };
  return { tz: 'America/New_York', from: 'default' };
}

/** 'Wednesday, November 18, 2026 at 9:00 AM CST' (zone name on) or '… at 8:30 PM' (off): the wording a website booking stores. */
export function whenText(startMs, tz, { zone = true } = {}) {
  const f = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).format(new Date(startMs));
  const day = f({ weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const time = f({ hour: 'numeric', minute: '2-digit', hour12: true });
  const name = zone ? f({ timeZoneName: 'short' }).split(' ').pop() : '';
  return `${day} at ${time}${name ? ` ${name}` : ''}`;
}

class BookError extends Error { constructor(message, status = 400, extra = {}) { super(message); this.status = status; Object.assign(this, extra); } }

/** The booking as typed → clean fields, or throws a plain-words BookError (400). */
export function cleanBooking(b = {}) {
  const t = (v, n) => String(v ?? '').trim().slice(0, n);
  const name = t(b.name, 120);
  const email = t(b.email, 200).toLowerCase();
  if (!name) throw new BookError('Add their name.');
  if (!email) throw new BookError('Add their email address.');
  if (!EMAIL_RE.test(email)) throw new BookError('That email address does not look right.');
  if (!b.start) throw new BookError('Pick a date and time for the call.');
  const ms = Date.parse(b.start);
  if (!Number.isFinite(ms)) throw new BookError('That date and time does not look right.');
  const minutes = Math.min(120, Math.max(10, Math.round(Number(b.minutes)) || 15));
  const website = b.website ? normaliseWebsite(b.website) : '';
  if (b.website && !website) throw new BookError('That website address does not look right.');
  return {
    name, email, startMs: ms, minutes, website, company: t(b.company, 160), theirTz: t(b.theirTz, 60), state: t(b.state, 40),
    phone: normalisePhone(b.phone), sells: t(b.sells, 800), plan: ['starter', 'growth', 'scale'].includes(t(b.plan, 20).toLowerCase()) ? t(b.plan, 20).toLowerCase() : null,
    notes: t(b.notes, 1000),
  };
}

/** Preview of a booking, nothing saved. → { ok:true, theirTz, tzFrom, website, websiteFrom, whenHost, whenTheirs, warnings } (throws BookError 400). */
export async function bookCheck(booking, { now = new Date() } = {}) {
  const b = cleanBooking(booking);
  if (b.startMs <= now.getTime()) throw new BookError('That time has already passed. Pick a time ahead.');
  const s = await calendarSettings();
  const z = theirZoneFor(b);
  const fromEmail = b.website ? null : websiteFromEmail(b.email);
  const website = b.website || fromEmail || null;
  const around = await meetingsBetween(b.startMs - DAY_MS, b.startMs + DAY_MS);
  const warnings = [];
  const clash = clashWith(around, b.startMs, b.minutes);
  if (clash) warnings.push({ code: 'clash', message: `This overlaps "${clash.title || 'another meeting'}" in your Calendar.` });
  if (!inCallHours(b.startMs, b.minutes, s)) warnings.push({ code: 'outside_hours', message: 'This is outside your call hours (or on a closed day).' });
  return {
    ok: true, theirTz: z.tz, tzFrom: z.from, website, websiteFrom: b.website ? 'entered' : fromEmail ? 'email' : null,
    whenHost: whenText(b.startMs, s.ownerZone, { zone: false }), whenTheirs: whenText(b.startMs, z.tz), theirZoneName: zoneInfo(z.tz).name, warnings, _clean: b,
  };
}

/** Save it. Warnings and no `force` → { status: 409, warnings }. → { ok:true, id, emailed, inquiry } (throws BookError). */
export async function bookCall(booking, { force = false, now = new Date(), defer = null } = {}) {
  const { _clean: b, ...pre } = await bookCheck(booking, { now });
  if (pre.warnings.length && !force) throw new BookError('This time has a warning. Check it, or book it anyway.', 409, { warnings: pre.warnings });
  const raw = {
    name: b.name, email: b.email, company: b.company || b.name, website: pre.website || '', sells: b.sells, plan: b.plan, phone: b.phone,
    slotStart: new Date(b.startMs).toISOString(), slotEnd: new Date(b.startMs + b.minutes * 60e3).toISOString(),
    theirTz: pre.theirTz, whenTheirs: pre.whenTheirs, whenHost: pre.whenHost, utm_source: 'cold_call',
  };
  const r = await saveInquiry(raw, { source: 'cold_call', now, defer, loose: true, strict: !force, notes: b.notes });
  if (r.ok && r.duplicate) throw new BookError('This person already has a call booked at that time.', 409, { warnings: [] });
  if (!r.ok && r.code) throw new BookError('Someone else now holds that time. Pick another, or check your Calendar.', 409, { warnings: [{ code: r.code === 'outside_hours' ? 'outside_hours' : 'clash', message: r.error }] });
  if (!r.ok) throw new BookError(Object.values(r.errors || {})[0] || 'The booking could not be saved.');
  const { getInquiry } = await import('@/lib/systems/inquiries');
  return { ok: true, id: r.id, emailed: r.emailed, inquiry: await getInquiry(r.id) };
}

export { BookError };
