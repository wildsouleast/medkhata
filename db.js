const { Pool } = require('pg');

function makePool() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url) || url.startsWith('postgres:///');
  const clean = url.replace(/[?&]sslmode=[^&]*/, '').replace(/[?&]channel_binding=[^&]*/, '').replace(/\?$/, '');
  return new Pool({
    connectionString: local ? url : clean,
    ssl: local ? false : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
  });
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  store_name TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  city TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'trial',
  trial_ends_at TIMESTAMPTZ NOT NULL,
  paid_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS medicines (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  batch TEXT NOT NULL DEFAULT '',
  expiry DATE NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  price NUMERIC(10,2) NOT NULL DEFAULT 0,
  min_qty INTEGER NOT NULL DEFAULT 10,
  supplier TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS medicines_user_idx ON medicines(user_id);
CREATE TABLE IF NOT EXISTS reminders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  patient_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  medicine TEXT NOT NULL,
  every_days INTEGER NOT NULL DEFAULT 30,
  next_due DATE NOT NULL,
  last_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reminders_user_idx ON reminders(user_id);
CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,
  amount_paise INTEGER NOT NULL,
  razorpay_order_id TEXT UNIQUE,
  razorpay_payment_id TEXT,
  status TEXT NOT NULL DEFAULT 'created',
  live_mode BOOLEAN NOT NULL DEFAULT false,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS email_verifications (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS contact_messages (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  contact TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS store_address TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS gstin TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS drug_licence TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS bills (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bill_no INTEGER NOT NULL,
  customer_name TEXT NOT NULL DEFAULT '',
  customer_phone TEXT NOT NULL DEFAULT '',
  subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_type TEXT NOT NULL DEFAULT 'amount',
  discount_value NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  gst_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  gst_mode TEXT NOT NULL DEFAULT 'none',
  gst_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, bill_no)
);
CREATE INDEX IF NOT EXISTS bills_user_date_idx ON bills(user_id, created_at);
CREATE TABLE IF NOT EXISTS bill_items (
  id SERIAL PRIMARY KEY,
  bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  medicine_id INTEGER REFERENCES medicines(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  batch TEXT NOT NULL DEFAULT '',
  expiry DATE,
  qty INTEGER NOT NULL,
  price NUMERIC(10,2) NOT NULL,
  amount NUMERIC(12,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS bill_items_bill_idx ON bill_items(bill_id);
-- v2 (Oct 26 2026): purchase entry + udhaar khata. Additive only.
CREATE TABLE IF NOT EXISTS purchases (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  supplier TEXT NOT NULL,
  invoice_no TEXT NOT NULL DEFAULT '',
  purchase_date DATE NOT NULL,
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS purchases_user_date_idx ON purchases(user_id, purchase_date);
CREATE TABLE IF NOT EXISTS purchase_items (
  id SERIAL PRIMARY KEY,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  medicine_id INTEGER REFERENCES medicines(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  batch TEXT NOT NULL DEFAULT '',
  expiry DATE NOT NULL,
  qty INTEGER NOT NULL,
  rate NUMERIC(10,2) NOT NULL DEFAULT 0,
  mrp NUMERIC(10,2) NOT NULL DEFAULT 0,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS purchase_items_purchase_idx ON purchase_items(purchase_id);
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS purchase_rate NUMERIC(10,2);
CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customers_user_idx ON customers(user_id);
CREATE TABLE IF NOT EXISTS khata_entries (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('udhaar','payment')),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  note TEXT NOT NULL DEFAULT '',
  bill_id INTEGER REFERENCES bills(id) ON DELETE CASCADE,
  entry_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS khata_entries_customer_idx ON khata_entries(customer_id, entry_date);
CREATE UNIQUE INDEX IF NOT EXISTS khata_entries_bill_uq ON khata_entries(bill_id) WHERE bill_id IS NOT NULL;
-- v3 (Oct 26 2026): trial is 7 days, no free plan, read-only after the trial. One-time: every store that never paid
-- gets a fresh 7-day trial from the moment this migration first runs. Runs once (recorded in app_migrations).
CREATE TABLE IF NOT EXISTS app_migrations (name TEXT PRIMARY KEY, ran_at TIMESTAMPTZ NOT NULL DEFAULT now());
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_migrations WHERE name = 'v3_trial7_2026_10_26') THEN
    UPDATE users SET trial_ends_at = now() + interval '7 days' WHERE paid_until IS NULL;
    INSERT INTO app_migrations(name) VALUES ('v3_trial7_2026_10_26');
  END IF;
END $$;
`;

async function migrate(pool) {
  await pool.query(SCHEMA);
}

module.exports = { makePool, migrate };
