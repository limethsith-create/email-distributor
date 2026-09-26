/**
 * Client / prospect message templates for Stage B (SPEC §11).
 * Shape: { key: { subject, body, from: 'owner' | 'trial' } }. Slots are {name}.
 * The owner's docs have no wording for these four (the doc approves copy on a
 * live Build Session, which the spec replaced with the approval page), so the
 * text below is new, kept in the doc's voice — logged in
 * docs/assumptions/stage-b.md.
 */
export const TEMPLATES = {
  approval_link: {
    from: 'owner',
    subject: 'Your trial — the list and the emails, for your OK',
    body: `Hi {firstName},

Everything for your trial is ready for one look from you: the customer profile, 20 of the companies we found, and the four emails that will go out in {senderName}'s name.

It takes about five minutes: {approvalUrl}

Approve each part, or tell me what to change and I will fix it. First send is {day1Date}.

If there is no reply by {silenceDate}, I will take it as approved and keep to that date.

{ownerName}`,
  },
  approval_reminder: {
    from: 'owner',
    subject: 'Reminder — your trial emails are waiting for your OK',
    body: `Hi {firstName},

A quick nudge: the list and the four emails for your trial are waiting for your OK here: {approvalUrl}

First send is {day1Date}. If there is no reply by {silenceDate}, I will take the copy as approved so the date holds.

{ownerName}`,
  },
  approval_updated: {
    from: 'owner',
    subject: 'Your trial — the changes you asked for',
    body: `Hi {firstName},

I made the changes you asked for. The updated version is on the same page: {approvalUrl}

Approve it, or tell me what else to change. First send is {day1Date}.

{ownerName}`,
  },
  approved_by_silence: {
    from: 'owner',
    subject: 'Your trial emails are approved',
    body: `Hi {firstName},

I did not hear back on the list and the emails, so as agreed I have taken them as approved. First send is {day1Date}.

You can still see everything here: {approvalUrl}. If anything should change, reply to this email before then and I will change it.

{ownerName}`,
  },
  day1_moved: {
    from: 'owner',
    subject: 'Your trial — first send moves to {day1Date}',
    body: `Hi {firstName},

A short change of date: the first send moves to {day1Date}, and Day 30 moves to {day30Date}.

Why: {reason}. We only start when everything is ready, because a rushed start costs more replies than one day does.

{waitingLine}

{ownerName}`,
  },
};
