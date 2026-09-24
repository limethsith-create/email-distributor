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
  // ── end Stage A ──
  // ── Stage B additions ──
  // ── end Stage B ──
  // ── Stage C additions ──
  // ── end Stage C ──
  // ── Stage D additions ──
  // ── end Stage D ──
};
