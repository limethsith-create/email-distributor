/**
 * Owner alert catalogue (SPEC §11 "To the owner"). `urgent` alerts also go to
 * Telegram. Each alert fires at most once per day per (key, scope) unless
 * `repeatDaily` is false and `everyHour` is set.
 *
 * Every alert body has the same shape: what happened, what the system already
 * did, and a Mission Control link — so the owner never has to investigate
 * before deciding.
 */

export const ALERTS = {
  // Watchdog / scheduler
  job_failing: { urgent: true, title: 'Job failing: {job} ({scope})' },
  send_stalled: { urgent: true, everyHour: true, title: 'No email sent for {minutes} min during US hours' },
  heartbeat_gap: { urgent: true, title: 'Heartbeat gap: last tick {minutes} min ago' },
  usage_80: { urgent: false, title: '{service} at {pct}% of the free monthly limit' },
  usage_95: { urgent: true, title: '{service} at {pct}% — non-essential jobs stopped' },
  report_blocked: { urgent: true, title: 'Report blocked: {report} for {clientId}' },
  gatekeeper_error: { urgent: true, title: 'Application needs a manual answer: {email}' },
  market_small: { urgent: true, title: 'Market too small for {clientId}: {estimate}' },
  config_missing: { urgent: true, title: 'Setting not filled in: {key}' },
  // Setup
  shopping_list: { urgent: true, title: 'Shopping list ready: {clientId}' },
  purchase_reminder: { urgent: true, title: 'Still to buy: {clientId} ({hours} h)' },
  dns_fail: { urgent: true, title: 'DNS record wrong for {domain}' },
  inbox_auth_fail: { urgent: true, title: 'Inbox login failed: {email}' },
  loopback_fail: { urgent: true, title: 'Loopback test failed: {domain}' },
  blacklisted: { urgent: true, title: '{domain} is blacklisted' },
  redirect_missing: { urgent: false, title: '{domain} does not redirect to the main site' },
  autobuy_failed: { urgent: false, title: 'Auto-buy failed for {domain}' },
  // Deliverability
  warmup_stalled: { urgent: false, title: 'Warm-up stalled: {clientId}' },
  inbox_rate_low: { urgent: false, title: 'Inbox rate low: {email} {rate}' },
  placement_low: { urgent: true, title: 'Inbox placement low: {clientId} {rate}' },
  dmarc_degraded: { urgent: true, title: 'DMARC pass rate low: {domain} {rate}' },
  emergency: { urgent: true, title: 'Emergency stop: {clientId} — {trigger}' },
  domain_burned: { urgent: true, title: 'Domain burned: {domain}' },
  // List + copy
  leadfinder_failed: { urgent: false, title: 'Lead Finder failed: {clientId}' },
  list_short: { urgent: false, title: 'List short: {clientId} has {count}' },
  list_quality: { urgent: false, title: 'List batch rejected: {clientId}' },
  customer_hit: { urgent: true, title: 'We emailed a customer of {clientId}' },
  copy_blocked: { urgent: false, title: 'Copy blocked: {clientId} — {rule}' },
  change_requested: { urgent: false, title: 'Copy change requested: {clientId}' },
  compliance_block: { urgent: true, title: 'Compliance blocks: {clientId}' },
  // Replies + calls
  angry_reply: { urgent: true, title: 'Angry reply: {clientId}' },
  legal_reply: { urgent: true, title: 'LEGAL reply: {clientId} — sending paused' },
  dispute: { urgent: false, title: 'Call disputed: {clientId}' },
  client_noshow: { urgent: false, title: 'Client missed a call: {clientId}' },
  noshow_high: { urgent: false, title: 'No-show rate high: {clientId}' },
  client_quiet_warning: { urgent: false, title: 'Client quiet: {clientId}' },
  paused_quiet: { urgent: true, title: 'Paused — client quiet: {clientId}' },
  trial_stopped_by_client: { urgent: false, title: 'Client stopped the trial: {clientId}' },
  // Stage D
  extension_started: { urgent: false, title: 'Extension started: {clientId}' },
  talk_request: { urgent: true, title: '{clientId} wants to talk' },
  converted: { urgent: false, title: 'Converted: {clientId} on {plan}' },
  cancel_inboxes: { urgent: true, title: 'Cancel the inboxes for {clientId}' },
  // Scheduled
  morning_digest: { urgent: false, title: 'Morning digest — {date}' },
  monday_digest: { urgent: false, title: 'Monday KPIs — {date}' },
  test: { urgent: true, title: 'Test alert from Mission Control' },
  // ── Stage A additions ──
  market_unavailable: { urgent: true, title: 'Market count could not run: {clientId}' },
  autorenew_on: { urgent: true, title: 'Auto-renew is not confirmed off for {domain}' },
  promo_expired: { urgent: false, title: 'Promo expired: {registrar} {code}' },
  booking_link_broken: { urgent: false, title: 'Booking link problem: {clientId}' },
  new_application: { urgent: true, title: 'New trial application: {company}' },
  application_scored: { urgent: false, title: 'Fit score for {company}: {score}' },
  research_failed: { urgent: false, title: 'Applicant research could not finish: {clientId}' },
  // ── end Stage A ──
  // ── Stage B additions ──
  warmup_pool_small: { urgent: false, title: 'Warm-up pool has {count} members (needs {min})' },
  helper_unhealthy: { urgent: false, title: 'Warm-up helper not working: {email}' },
  warmup_errors: { urgent: false, title: 'Warm-up sends failing: {email}' },
  canary_incomplete: { urgent: false, title: 'Canary test incomplete: {clientId}' },
  day1_slid: { urgent: false, title: 'Day 1 moved for {clientId} to {date}' },
  approved_by_silence: { urgent: false, title: 'Copy approved by silence: {clientId}' },
  // Deliverability v2
  spam_score_low: { urgent: true, title: 'Spam test {score}/10 for {email} ({clientId})' },
  placement_test_failed: { urgent: false, title: 'Spam test could not run: {clientId}' },
  bounce_pause: { urgent: true, title: 'Bounces at {rate} — caps halved: {clientId}' },
  bounce_pause_lifted: { urgent: false, title: 'Bounces back under the pause line: {clientId}' },
  blacklist_warning: { urgent: false, title: 'An address near {domain} is on a blacklist (not blocking)' },
  // ── end Stage B ──
  // ── Stage C additions ──
  hot_lead_failed: { urgent: true, title: 'Hot lead NOT delivered to {clientId}' },
  prospect_send_failed: { urgent: false, title: 'Reply to a prospect failed: {clientId} ({template})' },
  competitor_booked: { urgent: false, title: 'A competitor booked a call: {clientId}' },
  emergency_resolved: { urgent: false, title: 'Deliverability back to normal: {clientId}' },
  booking_unmatched: { urgent: false, title: 'Booking could not be matched to a prospect: {clientId}' },
  trial_ended_quiet: { urgent: true, title: 'Trial ended — client quiet 14 business days: {clientId}' },
  // Leads + Copy v2
  verify_no_keys: { urgent: true, title: 'No email verifier key set — {clientId} has no sendable leads' },
  verify_failing: { urgent: false, title: 'Email verifier not answering: {service}' },
  verify_budget_out: { urgent: false, title: 'Free verification credits used up today ({pending} leads waiting)' },
  // ── end Stage C ──
  // ── Stage D additions ──
  build_behind: { urgent: false, title: 'Build behind at Day −7: {clientId} — {what}' },
  invoice_unpaid: { urgent: false, title: 'Invoice still unpaid: {clientId} ({days} days)' },
  decision_made: { urgent: false, title: '{clientId} chose: {choice}' },
  new_inquiry: { urgent: true, title: 'New plan inquiry: {company} — call {when}' },
  // ── end Stage D ──
  // ── Google Meet (docs/REPLYBOT-MEET.md §3) ── once per broken connection (not urgent: calls
  // are still confirmed, their emails just carry no Meet link until he reconnects).
  google_disconnected: { urgent: false, title: 'Google Meet disconnected ({account}) — reconnect it in Settings' },
  // ── end Google Meet ──
  // ── Onboarding call (docs/ONBOARD-CALL.md) ── phone + email (not urgent: the hub's own
  // to-do for the trial clears itself once answered/booked, an urgent alert would linger).
  // Scope is per message / booking, so each one alerts exactly once.
  onboard_reply: { urgent: false, title: '{person} replied about the onboarding call' },
  onboard_booked: { urgent: false, title: 'Onboarding call booked: {person}, {when}' },
  onboard_overdue: { urgent: false, title: 'Onboarding call not booked yet: {person}' },
  onboard_cancelled: { urgent: false, title: 'Onboarding call cancelled: {person}' },
  // ── end onboarding call ──
  // ── Calendar (docs/CALENDAR.md) ── phone + email, not urgent for the same reason: the
  // Calendar's "waiting for your yes" list and the trial's to-do carry it until answered.
  // {who} = "Sam (eCreek IT)", {when} = "Tue 30 Sep 2:00 pm ET = 11:30 pm Colombo".
  meeting_requested: { urgent: false, title: '{who} asked for {when} — say yes in the Calendar' },
  meeting_accepted: { urgent: false, title: '{who} said yes to {when}' },
  // ── end calendar ──
};
