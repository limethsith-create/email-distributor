# Fit Score — decisions (2026-09-25)

The owner asked for automatic research on every trial applicant that rates
how well the business fits Aviance's perfect customer, "without any Claude
getting involved". `systems/fitsignals.js` reads the words on their website;
`systems/fitscore.js` scores them with their answers. Fixed rules only.

**Yardstick = the owner's own fit gate** ("The 30-Day Trial" §2): US B2B
company already selling to strangers; 5–50 people; a customer worth ≥ $2,000
in year one; ≥ 1,000 reachable companies; three dream customers; meets within
five business days; five slots a week; nobody else emailing the list; not a
lead-gen / outbound agency; not a market everyone emails.

**Six parts, 100 points** (FITSCORE.weights, editable in /mc/config):
sells to businesses 20 · deal size 20 · size and age 15 · already wins
strangers 15 · market 15 · ready for calls 15. Five to six dimensions is the
usual shape (Kilroy: 5 × 20; DigitalApplied: 6 buckets; Salesforce grading:
start with 4–5 criteria).

**Unknown = left out, not punished.** Score = points earned ÷ points that
could be checked; `confidence` = how many of the 100 could be checked; each
unknown becomes a question for the call. Below 50 checkable points, or when
the website is blank / unreadable, the label is "Needs a look" instead of a
grade (Selworthy, SalesforceBen: empty fields are unknown, not negative;
route low-coverage records to a human).

**Dealbreakers before points** (sources: hard exclusions beat negative
points): an agency or cold-outreach seller; an industry the sending tools ban
(Instantly / lemlist sending policies, Mailchimp AUP: gambling, cannabis/CBD,
payday loans, crypto, forex, MLM, …); not US; sells to consumers only; under
$2,000 a customer; never sold to strangers; cannot meet within five days; a
Google-counted market under 500; buyers everyone emails (SaaS founders,
agencies); a repeat trial. The rough OpenStreetMap name count never turns
anyone down.

**Grades** A ≥ 80, B ≥ 65, C ≥ 50, D below (between DigitalApplied's 80/60
and Kilroy's 90/75/60/40). Sources say to tune cut-offs against real closed
deals — revisit after the first ten trials.

**Tested live** (2026-09-25) on burgesscpas.com (Good fit), smartlead.ai
(Not a fit — cold-email software sold to agencies; first version wrongly gave
it 100) and example.com (Needs a look — a 21-word page).

Sources: timkilroy.com/blog/icp-scoring-rubric-template ·
digitalapplied.com/blog/b2b-icp-scoring-framework-2026-lead-qualification-playbook ·
salesforceben.com/guide-to-pardot-grading · selworthy.com (HubSpot lead scoring) ·
help.madkudu.com (customer fit) · instantly.ai/instantly-sending-policy ·
lemlist.com/legal/sending-policy · mailchimp.com/legal/acceptable_use ·
buzzlead.io (cold email agency decision guide) · leadium.com/blog/cold-email-marketing-agency.
