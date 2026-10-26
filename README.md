# Dawalekh (formerly MedKhata)

Stock, expiry and refill tracking for medical stores and clinics in India.

- Marketing site + legal pages (Privacy, Terms, Refund & Cancellation, Shipping & Delivery, Contact)
- Accounts with mobile number/email + password (scrypt hashed), cookie sessions
- 14-day free trial (all features) that starts at signup; afterwards the store drops to the Free plan (100 medicines, 50 bills/month, 20 refill reminders), enforced on the server
- Dashboard: medicines (name, batch, expiry, quantity, price, low-stock level, supplier), expiry alerts (30/60/90 days), low-stock alerts, refill reminders with WhatsApp click-to-chat links, CSV export
- Paid plan: Pro ₹149 / 30 days or ₹1,499 / 365 days (lib/plans.js), paid through Razorpay Orders (checkout + server-side signature check + webhook)

## Run

Node 18+ and a Postgres database.

```
npm install
DATABASE_URL=postgres://... npm start
```

Tables are created automatically on start.

## Environment variables

| Name | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Razorpay API keys (test or live). Empty = payments show "not connected yet" |
| `RAZORPAY_WEBHOOK_SECRET` | Secret set on the Razorpay webhook (URL: `/api/razorpay/webhook`, events: `order.paid`, `payment.failed`) |
| `BUSINESS_NAME`, `CONTACT_EMAIL`, `CONTACT_PHONE`, `BUSINESS_ADDRESS` | Shown on the Contact and legal pages |
| `ADMIN_KEY` | Optional key for `/api/admin/overview` |

## Tests

```
TEST_DATABASE_URL=postgres://... npm test
```


## v2 (Oct 26 2026)
- Purchase entry: /api/purchases (supplier, bill no, date, items with batch/expiry/qty/rate/MRP). Saving adds to stock (same name+batch -> qty up; else new medicine). Edit/delete reverse the stock (never below 0). Supplier-wise totals.
- Udhaar khata: /api/khata (customers + entries udhaar/payment, running balance, total due). A bill can go on udhaar at save time (udhaar: true) or later from the bill view; cancelling a bill removes its udhaar line.
- Frontend also served by tab.bot worker (deploy/tabbot-worker) that proxies /api/* to Render, same as Netlify's _redirects.
