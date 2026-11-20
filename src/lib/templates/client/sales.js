/**
 * Sales calls booked on the public website's "Book a call" form
 * (systems/salescall.js, docs/CALENDAR.md "Sales calls"). Sent from the
 * onboarding-call inbox, so their reply lands where the owner reads.
 *
 * Slots: {firstName} {ownerName} {when} {whenShort} {minutes} {linkLine}
 *        {company} {planLine} {guaranteeLine}
 */
export const TEMPLATES = {
  sales_call_confirmed: {
    from: 'onboard',
    subject: 'Confirmed: our call {whenShort}',
    body: `Hi {firstName},

You're booked. Our {minutes}-minute call is {when}.

{linkLine}

I've attached a calendar invite so it's on your calendar.

What we'll cover:
- Whether cold email is a good fit for {company} (if it isn't, you'll hear it straight away)
- {planLine}
- Who we'd target and why

{guaranteeLine}

If the time stops working, just reply to this email and we'll find another.

{ownerName}`,
  },

  sales_call_tomorrow: {
    from: 'onboard',
    subject: 'Our call tomorrow',
    body: `Hi {firstName},

A quick reminder: our {minutes}-minute call is tomorrow, {when}.

{linkLine}

To get the most from it, have your best two or three customers in mind; we'll aim for more like them.

Need a different time? Reply to this email.

{ownerName}`,
  },

  sales_call_soon: {
    from: 'onboard',
    subject: 'Our call in 1 hour',
    body: `Hi {firstName},

Our call starts in about an hour, {when}.

{linkLine}

See you shortly.

{ownerName}`,
  },

  sales_call_now: {
    from: 'onboard',
    subject: 'Starting in 5 minutes',
    body: `Hi {firstName},

Just a quick heads-up: our call starts in 5 minutes.

{linkLine}

See you soon.

{ownerName}`,
  },

  sales_call_moved: {
    from: 'onboard',
    subject: 'New time: {whenShort}',
    body: `Hi {firstName},

Our call has moved to {when}.

{linkLine}

I've attached an updated calendar invite. If the new time doesn't work, reply to this email.

{ownerName}`,
  },
  // After a yes on the sales call (systems/agreementsend.js): the service agreement, then the month-one invoice.
  service_agreement: {
    from: 'onboard',
    subject: 'Your Aviance agreement',
    body: `Hi {firstName},

Thanks for the call. Here's our agreement for {company} on the {planName} plan: {calls} booked calls a month for {priceText} a month. It's below and attached as a page you can keep.

To accept, reply "I agree", or just pay the invoice. It comes in a separate email, and paying it counts as accepting.

{agreementText}

{ownerName}`,
  },

  agreement_invoice: {
    from: 'onboard',
    subject: 'Invoice {invoiceNo}',
    body: `Hi {firstName},

Here's the invoice for your first month.

Invoice {invoiceNo} · issued {issuedDate} · due now
{planName} plan: {calls} booked calls a month
Month one: {priceText}
Setup: $0
Total due: {priceText}

Pay by:
{paymentLines}

Once it's paid, I'll email you a link to book our onboarding call.

{ownerName}`,
  },
  agreement_invoice_chase: {
    from: 'onboard',
    subject: 'Quick note about invoice {invoiceNo}',
    body: `Hi {firstName},

Just a friendly note: I sent your agreement and invoice {invoiceNo} ({priceText}, {planName} plan) yesterday, and I haven't seen the payment yet.

Pay by:
{paymentLines}

If it's already on its way, ignore this, and thank you. Once it's in, I'll email you a link to book our onboarding call.

{ownerName}`,
  },
};
