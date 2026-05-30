# Afternoon Outreach Run — May 29, 2026

## Status: LEADS FOUND, EMAILS NOT SENT

### Why emails weren't sent
- **Chrome browser**: Extension not connected (required for JavaScript execution on the blast endpoint)
- **Sandbox shell**: Proxy blocks outbound requests to `email-distributor.vercel.app` (403 Forbidden — not on allowlist)

### Action needed
Send these leads manually or re-run this task when Chrome is connected. Each lead should be sent individually to `POST /api/outreach/blast` with 15-30 min spacing.

---

## Verified Leads (13 total)

All emails confirmed on real company websites via web search + page fetch.

### Construction (7)
| Email | Company | City |
|-------|---------|------|
| info@edcc.lk | EDCC (Engineering Design & Construction) | Kadawatha |
| info@distinction.lk | Distinction Construction | Kurunegala |
| info@ncc.lk | Nazeeha Construction Company | Eravur |
| info@urbance.lk | Urban Constructions | Athurugiriya |
| info@dvconstruction.lk | DV Construction | Kaduwela |
| info@mkcc.lk | MK Construction & Consultants | Colombo |
| info@sec.lk | SEC Construction | Maharagama |

### Engineering (1)
| Email | Company | City |
|-------|---------|------|
| info@laugfsengineering.lk | LAUGFS Engineering | Sri Lanka |

### Apparel (2)
| Email | Company | City |
|-------|---------|------|
| info@timexsl.com | Timex Garments (Pvt) Ltd | Colombo |
| info@pinklineapparel.com | Pinkline Apparel | Colombo |

### Education (1)
| Email | Company | City |
|-------|---------|------|
| info@edulinkintl.com | Edulink International | Colombo |

### IT/Software (2)
| Email | Company | City |
|-------|---------|------|
| info@winterfel.lk | Winterfel Software | Homagama |
| info@exesmart.com | Exesmart | Rajagiriya |

---

## JSON payload (ready to use)

```json
[
  {"email": "info@edcc.lk", "company_name": "EDCC", "industry": "Construction", "city": "Kadawatha"},
  {"email": "info@distinction.lk", "company_name": "Distinction Construction", "industry": "Construction", "city": "Kurunegala"},
  {"email": "info@ncc.lk", "company_name": "Nazeeha Construction Company", "industry": "Construction", "city": "Eravur"},
  {"email": "info@urbance.lk", "company_name": "Urban Constructions", "industry": "Construction", "city": "Athurugiriya"},
  {"email": "info@dvconstruction.lk", "company_name": "DV Construction", "industry": "Construction", "city": "Kaduwela"},
  {"email": "info@mkcc.lk", "company_name": "MK Construction and Consultants", "industry": "Construction", "city": "Colombo"},
  {"email": "info@sec.lk", "company_name": "SEC Construction", "industry": "Construction", "city": "Maharagama"},
  {"email": "info@laugfsengineering.lk", "company_name": "LAUGFS Engineering", "industry": "Engineering", "city": "Sri Lanka"},
  {"email": "info@timexsl.com", "company_name": "Timex Garments Pvt Ltd", "industry": "Apparel", "city": "Colombo"},
  {"email": "info@pinklineapparel.com", "company_name": "Pinkline Apparel", "industry": "Apparel", "city": "Colombo"},
  {"email": "info@edulinkintl.com", "company_name": "Edulink International", "industry": "Education", "city": "Colombo"},
  {"email": "info@winterfel.lk", "company_name": "Winterfel Software", "industry": "IT", "city": "Homagama"},
  {"email": "info@exesmart.com", "company_name": "Exesmart", "industry": "IT", "city": "Rajagiriya"}
]
```

## Stats
- **Leads found**: 13
- **Emails sent**: 0
- **Industries covered**: Construction, Engineering, Apparel, Education, IT/Software
- **Reason for 0 sends**: Browser disconnected + sandbox network restrictions
