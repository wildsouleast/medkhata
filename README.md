# MedKhata

Stock, expiry and refill tracking for medical stores and clinics in India.

- Marketing site + legal pages (Privacy, Terms, Refund & Cancellation, Shipping & Delivery, Contact)
- Accounts with mobile number/email + password (scrypt hashed), cookie sessions
- 2-day free trial that starts at signup and is enforced on the server
- Dashboard: medicines (name, batch, expiry, quantity, price, low-stock level, supplier), expiry alerts (30/60/90 days), low-stock alerts, refill reminders with WhatsApp click-to-chat links, CSV export
- Plans: Basic ₹299, Pro ₹599, Clinic+ ₹999 per 30 days, paid through Razorpay Orders (checkout + server-side signature check + webhook)

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
