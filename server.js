// Dawalekh server: marketing site, accounts, stock, alerts, reminders and Razorpay billing.
const path = require('path');
const express = require('express');
const { makePool, migrate } = require('./db');
const A = require('./lib/auth');
const RZ = require('./lib/razorpay');
const MAIL = require('./lib/mailer');
const { PLANS, TRIAL_HOURS, PERIOD_DAYS, limitsFor } = require('./lib/plans');

const app = express();
const pool = makePool();
const PROD = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER);
const COOKIE = 'mk_session';
const SESSION_DAYS = 30;

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (PROD) res.set('Strict-Transport-Security', 'max-age=15552000');
  next();
});

// ---------- Razorpay webhook (needs the raw body, so it comes before express.json) ----------
app.post('/api/razorpay/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const c = RZ.config();
  if (!c.webhookSecret) return res.status(503).json({ error: 'webhook_not_configured' });
  const sig = req.get('x-razorpay-signature');
  const raw = req.body instanceof Buffer ? req.body : Buffer.from('');
  if (!sig || !RZ.verifyWebhookSignature(raw, sig, c.webhookSecret)) {
    return res.status(400).json({ error: 'bad_signature' });
  }
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch (e) { return res.status(400).json({ error: 'bad_json' }); }
  const eventId = req.get('x-razorpay-event-id') || `${body.event}:${body.created_at}:${raw.length}`;
  try {
    const seen = await pool.query('INSERT INTO webhook_events(event_id, event) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING event_id', [eventId, String(body.event || '')]);
    if (!seen.rowCount) return res.json({ ok: true, duplicate: true });
    if (body.event === 'order.paid' || body.event === 'payment.captured') {
      const payment = body.payload && body.payload.payment && body.payload.payment.entity;
      const orderId = (body.payload && body.payload.order && body.payload.order.entity && body.payload.order.entity.id) || (payment && payment.order_id);
      if (orderId) await markPaid(orderId, payment && payment.id, 'webhook');
    } else if (body.event === 'payment.failed') {
      const payment = body.payload && body.payload.payment && body.payload.payment.entity;
      if (payment && payment.order_id) {
        await pool.query("UPDATE payments SET status='failed' WHERE razorpay_order_id=$1 AND status='created'", [payment.order_id]);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('webhook error', e.message);
    await pool.query('DELETE FROM webhook_events WHERE event_id=$1', [eventId]).catch(() => {});
    res.status(500).json({ error: 'server_error' });
  }
});

app.use(express.json({ limit: '100kb' }));

// ---------- helpers ----------
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function setSessionCookie(res, token) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_DAYS * 86400}`];
  if (PROD) parts.push('Secure');
  res.set('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.set('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${PROD ? '; Secure' : ''}`);
}

// Behind Netlify's proxy the visitor's IP arrives in x-nf-client-connection-ip.
function clientIp(req) { return String(req.get('x-nf-client-connection-ip') || req.ip || 'unknown').slice(0, 64); }

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function accountStatus(u) {
  const now = Date.now();
  const trialEnds = new Date(u.trial_ends_at).getTime();
  const paidUntil = u.paid_until ? new Date(u.paid_until).getTime() : 0;
  if (paidUntil > now) {
    return { state: 'active', plan: u.plan, plan_name: (PLANS[u.plan] || {}).name || u.plan, paid_until: u.paid_until, ms_left: paidUntil - now };
  }
  if (trialEnds > now && !u.paid_until) {
    return { state: 'trial', plan: 'trial', plan_name: 'Free trial', trial_ends_at: u.trial_ends_at, ms_left: trialEnds - now };
  }
  return { state: 'expired', plan: u.plan, plan_name: u.paid_until ? ((PLANS[u.plan] || {}).name || u.plan) : 'Free trial', ended_at: u.paid_until || u.trial_ends_at, ms_left: 0 };
}

function effectiveLimits(u) {
  const s = accountStatus(u);
  return s.state === 'trial' ? limitsFor('trial') : limitsFor(u.plan);
}

function publicUser(u) {
  return { id: u.id, store_name: u.store_name, owner_name: u.owner_name, phone: u.phone, email: u.email, email_verified: Boolean(u.email && u.email_verified_at), city: u.city, created_at: u.created_at, status: accountStatus(u) };
}

async function loadUser(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const r = await pool.query('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()', [A.tokenHash(token)]);
  return r.rows[0] || null;
}

const requireUser = wrap(async (req, res, next) => {
  const u = await loadUser(req);
  if (!u) return res.status(401).json({ error: 'login_required', message: 'Please log in again.' });
  req.user = u;
  next();
});

// Server-side trial / subscription gate.
function requireAccess(req, res, next) {
  const s = accountStatus(req.user);
  if (s.state === 'expired') {
    return res.status(402).json({ error: 'plan_required', message: 'Your free trial has ended. Choose a plan to continue. Your data is safe.' });
  }
  next();
}

async function startSession(res, userId) {
  const token = A.newToken();
  await pool.query("INSERT INTO sessions(token_hash, user_id, expires_at) VALUES ($1,$2, now() + ($3 || ' days')::interval)", [A.tokenHash(token), userId, String(SESSION_DAYS)]);
  setSessionCookie(res, token);
}

function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
function bad(res, message, field) { return res.status(400).json({ error: 'invalid', message, field }); }
// A real calendar date (rejects 2026-02-30, year 0000 etc.), between 2000 and 2099.
function isDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (y < 2000 || y > 2099) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

// ---------- public config ----------
app.get('/api/config', (req, res) => {
  const c = RZ.config();
  res.json({
    payments: { enabled: c.enabled, test_mode: c.enabled && !c.liveMode, key_id: c.enabled ? c.keyId : null },
    plans: Object.values(PLANS).map((p) => ({ id: p.id, name: p.name, price: p.price, features: p.features })),
    trial_hours: TRIAL_HOURS,
    email_enabled: MAIL.enabled(),
    business: {
      name: process.env.BRAND_NAME || 'Dawalekh',
      email: process.env.CONTACT_EMAIL || null,
      phone: process.env.CONTACT_PHONE || null,
      address: process.env.BUSINESS_ADDRESS || null,
    },
  });
});

app.get('/api/health', wrap(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
}));

// ---------- auth ----------

// ---------- email (welcome, verification, password reset) ----------
const PUBLIC_BASE = () => process.env.PUBLIC_URL || 'https://dawalekh.netlify.app';
async function sendVerification(user, welcome) {
  if (!MAIL.enabled() || !user.email) return false;
  const token = A.newToken();
  await pool.query('DELETE FROM email_verifications WHERE user_id=$1', [user.id]);
  await pool.query("INSERT INTO email_verifications(token_hash, user_id, email, expires_at) VALUES ($1,$2,$3, now() + interval '48 hours')", [A.tokenHash(token), user.id, user.email]);
  const link = `${PUBLIC_BASE()}/verify-email?token=${token}`;
  const m = welcome ? MAIL.welcomeVerify({ store: user.store_name, link }) : MAIL.verifyOnly({ link });
  const r = await MAIL.send({ to: user.email, ...m });
  return r.ok;
}

app.post('/api/signup', wrap(async (req, res) => {
  if (A.rateLimited(`signup:${clientIp(req)}`, 20, 60 * 60 * 1000)) return res.status(429).json({ error: 'rate_limited', message: 'Too many attempts. Please try again in a while.' });
  const b = req.body || {};
  const store = str(b.store_name, 80);
  const owner = str(b.owner_name, 60);
  const city = str(b.city, 60);
  const phone = A.normalizePhone(b.phone);
  const email = A.normalizeEmail(b.email);
  const password = String(b.password || '');
  if (store.length < 2) return bad(res, 'Please enter your store name.', 'store_name');
  if (owner.length < 2) return bad(res, 'Please enter the owner\'s name.', 'owner_name');
  if (!phone) return bad(res, 'Please enter a valid 10-digit Indian mobile number.', 'phone');
  if (email === null) return bad(res, 'Please enter a valid email address, or leave it empty.', 'email');
  if (city.length < 2) return bad(res, 'Please enter your city.', 'city');
  if (password.length < 8) return bad(res, 'Password must be at least 8 characters.', 'password');
  if (b.accept_terms !== true) return bad(res, 'Please accept the Terms and Privacy Policy.', 'accept_terms');
  const exists = await pool.query('SELECT 1 FROM users WHERE phone=$1 OR (email IS NOT NULL AND email=$2)', [phone, email || null]);
  if (exists.rowCount) return res.status(409).json({ error: 'exists', message: 'An account with this mobile number or email already exists. Please log in.' });
  const hash = A.hashPassword(password);
  const r = await pool.query(
    "INSERT INTO users(store_name, owner_name, phone, email, city, password_hash, trial_ends_at) VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' hours')::interval) RETURNING *",
    [store, owner, phone, email || null, city, hash, String(TRIAL_HOURS)]
  );
  await startSession(res, r.rows[0].id);
  let emailSent = false;
  if (r.rows[0].email) emailSent = await sendVerification(r.rows[0], true).catch((e) => { console.error('[mail] signup', e.message); return false; });
  res.status(201).json({ user: publicUser(r.rows[0]), email_sent: emailSent });
}));

app.post('/api/login', wrap(async (req, res) => {
  const b = req.body || {};
  const id = str(b.login, 120);
  if (A.rateLimited(`login:${clientIp(req)}`, 30, 15 * 60 * 1000) || A.isLimited(`login-id:${id.toLowerCase()}`, 8, 15 * 60 * 1000)) {
    return res.status(429).json({ error: 'rate_limited', message: 'Too many attempts. Please wait 15 minutes and try again.' });
  }
  const phone = A.normalizePhone(id);
  const email = A.normalizeEmail(id);
  const r = phone ? await pool.query('SELECT * FROM users WHERE phone=$1', [phone])
    : email ? await pool.query('SELECT * FROM users WHERE email=$1', [email]) : { rows: [] };
  const u = r.rows[0];
  if (!u || !A.verifyPassword(String(b.password || ''), u.password_hash)) {
    A.rateLimited(`login-id:${id.toLowerCase()}`, 8, 15 * 60 * 1000);
    return res.status(401).json({ error: 'bad_login', message: 'Mobile number/email or password is incorrect.' });
  }
  A.clearLimit(`login-id:${id.toLowerCase()}`);
  pool.query('DELETE FROM sessions WHERE expires_at < now()').catch(() => {});
  await startSession(res, u.id);
  res.json({ user: publicUser(u) });
}));

app.post('/api/logout', wrap(async (req, res) => {
  const token = parseCookies(req)[COOKIE];
  if (token) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [A.tokenHash(token)]);
  clearSessionCookie(res);
  res.json({ ok: true });
}));

// Quiet check used by the login/signup pages (always 200, so no error in the browser console).
app.get('/api/session', wrap(async (req, res) => {
  const u = await loadUser(req);
  res.json({ logged_in: Boolean(u) });
}));

app.get('/api/me', requireUser, (req, res) => {
  res.json({ user: publicUser(req.user), limits: effectiveLimits(req.user) });
});

app.put('/api/me', requireUser, wrap(async (req, res) => {
  const b = req.body || {};
  const store = str(b.store_name, 80);
  const owner = str(b.owner_name, 60);
  const city = str(b.city, 60);
  if (store.length < 2 || owner.length < 2 || city.length < 2) return bad(res, 'Store name, owner name and city are required.');
  const r = await pool.query('UPDATE users SET store_name=$1, owner_name=$2, city=$3 WHERE id=$4 RETURNING *', [store, owner, city, req.user.id]);
  res.json({ user: publicUser(r.rows[0]) });
}));

app.post('/api/me/password', requireUser, wrap(async (req, res) => {
  const b = req.body || {};
  if (!A.verifyPassword(String(b.current || ''), req.user.password_hash)) return res.status(400).json({ error: 'invalid', message: 'Current password is incorrect.' });
  if (String(b.next || '').length < 8) return bad(res, 'New password must be at least 8 characters.');
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [A.hashPassword(String(b.next)), req.user.id]);
  // Log out every other device; keep this one.
  const token = parseCookies(req)[COOKIE];
  await pool.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2', [req.user.id, A.tokenHash(token || '')]);
  res.json({ ok: true });
}));

// ---------- medicines ----------
const MED_COLS = "id, name, batch, to_char(expiry,'YYYY-MM-DD') AS expiry, qty, price::float AS price, min_qty, supplier, (expiry - (now() AT TIME ZONE 'Asia/Kolkata')::date) AS days_left";

function readMedicine(b) {
  const m = {
    name: str(b.name, 100), batch: str(b.batch, 40), expiry: str(b.expiry, 10), supplier: str(b.supplier, 80),
    qty: Number(b.qty), price: Number(b.price), min_qty: b.min_qty === '' || b.min_qty == null ? 10 : Number(b.min_qty),
  };
  if (m.name.length < 2) return { error: 'Please enter the medicine name.' };
  if (!isDate(m.expiry)) return { error: 'Please choose a valid expiry date.' };
  if (!Number.isInteger(m.qty) || m.qty < 0 || m.qty > 1000000) return { error: 'Quantity must be a whole number (0 or more).' };
  if (!Number.isFinite(m.price) || m.price < 0 || m.price > 1000000) return { error: 'Please enter a valid price.' };
  if (!Number.isInteger(m.min_qty) || m.min_qty < 0 || m.min_qty > 100000) return { error: 'Low-stock level must be a whole number.' };
  return { m };
}

app.get('/api/medicines', requireUser, requireAccess, wrap(async (req, res) => {
  const r = await pool.query(`SELECT ${MED_COLS} FROM medicines WHERE user_id=$1 ORDER BY expiry ASC, name ASC`, [req.user.id]);
  res.json({ medicines: r.rows });
}));

app.post('/api/medicines', requireUser, requireAccess, wrap(async (req, res) => {
  const { m, error } = readMedicine(req.body || {});
  if (error) return bad(res, error);
  if (req.body.allow_duplicate !== true) {
    const d = await pool.query(`SELECT ${MED_COLS} FROM medicines WHERE user_id=$1 AND lower(name)=lower($2) AND lower(batch)=lower($3) LIMIT 1`, [req.user.id, m.name, m.batch]);
    if (d.rowCount) {
      const x = d.rows[0];
      return res.status(409).json({ error: 'duplicate', message: `${x.name}${x.batch ? ' (batch ' + x.batch + ')' : ''} is already in your stock with quantity ${x.qty}. You can edit that entry instead.`, existing: x });
    }
  }
  const lim = effectiveLimits(req.user);
  if (lim.maxMedicines) {
    const c = await pool.query('SELECT count(*)::int AS n FROM medicines WHERE user_id=$1', [req.user.id]);
    if (c.rows[0].n >= lim.maxMedicines) return res.status(403).json({ error: 'limit', message: `Your ${lim.name} plan allows up to ${lim.maxMedicines} medicines. Upgrade to Pro for unlimited.` });
  }
  const r = await pool.query(
    `INSERT INTO medicines(user_id, name, batch, expiry, qty, price, min_qty, supplier) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${MED_COLS}`,
    [req.user.id, m.name, m.batch, m.expiry, m.qty, m.price, m.min_qty, m.supplier]
  );
  res.status(201).json({ medicine: r.rows[0] });
}));

app.put('/api/medicines/:id', requireUser, requireAccess, wrap(async (req, res) => {
  const { m, error } = readMedicine(req.body || {});
  if (error) return bad(res, error);
  const r = await pool.query(
    `UPDATE medicines SET name=$1, batch=$2, expiry=$3, qty=$4, price=$5, min_qty=$6, supplier=$7, updated_at=now() WHERE id=$8 AND user_id=$9 RETURNING ${MED_COLS}`,
    [m.name, m.batch, m.expiry, m.qty, m.price, m.min_qty, m.supplier, Number(req.params.id) || 0, req.user.id]
  );
  if (!r.rowCount) return res.status(404).json({ error: 'not_found', message: 'Medicine not found.' });
  res.json({ medicine: r.rows[0] });
}));

app.delete('/api/medicines/:id', requireUser, requireAccess, wrap(async (req, res) => {
  const r = await pool.query('DELETE FROM medicines WHERE id=$1 AND user_id=$2', [Number(req.params.id) || 0, req.user.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'not_found', message: 'Medicine not found.' });
  res.json({ ok: true });
}));

function csvCell(v) {
  const s = String(v == null ? '' : v);
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

app.get('/api/medicines.csv', requireUser, requireAccess, wrap(async (req, res) => {
  if (!effectiveLimits(req.user).csvExport) return res.status(403).json({ error: 'limit', message: 'CSV download is part of the Pro and Clinic+ plans.' });
  const r = await pool.query(`SELECT ${MED_COLS} FROM medicines WHERE user_id=$1 ORDER BY expiry ASC, name ASC`, [req.user.id]);
  const lines = [['Medicine', 'Batch', 'Expiry', 'Days left', 'Quantity', 'Price (Rs)', 'Low-stock level', 'Supplier'].join(',')];
  r.rows.forEach((m) => lines.push([m.name, m.batch, m.expiry, m.days_left, m.qty, m.price, m.min_qty, m.supplier].map(csvCell).join(',')));
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="dawalekh-stock.csv"');
  res.send('\ufeff' + lines.join('\n'));
}));

// ---------- alerts ----------
app.get('/api/alerts', requireUser, requireAccess, wrap(async (req, res) => {
  const r = await pool.query(`SELECT ${MED_COLS} FROM medicines WHERE user_id=$1 ORDER BY expiry ASC`, [req.user.id]);
  const meds = r.rows;
  const rem = await pool.query("SELECT count(*)::int AS n FROM reminders WHERE user_id=$1 AND next_due <= (now() AT TIME ZONE 'Asia/Kolkata')::date", [req.user.id]);
  res.json({
    expired: meds.filter((m) => m.days_left < 0),
    within30: meds.filter((m) => m.days_left >= 0 && m.days_left <= 30),
    within60: meds.filter((m) => m.days_left > 30 && m.days_left <= 60),
    within90: meds.filter((m) => m.days_left > 60 && m.days_left <= 90),
    lowStock: meds.filter((m) => m.qty <= m.min_qty),
    totals: {
      medicines: meds.length,
      units: meds.reduce((a, m) => a + m.qty, 0),
      stockValue: Math.round(meds.filter((m) => m.days_left >= 0).reduce((a, m) => a + m.qty * m.price, 0) * 100) / 100,
      expiredValue: Math.round(meds.filter((m) => m.days_left < 0).reduce((a, m) => a + m.qty * m.price, 0) * 100) / 100,
      outOfStock: meds.filter((m) => m.qty === 0).length,
      remindersDue: rem.rows[0].n,
    },
  });
}));

// ---------- refill reminders ----------
const REM_COLS = "id, patient_name, phone, medicine, every_days, to_char(next_due,'YYYY-MM-DD') AS next_due, last_sent_at, (next_due - (now() AT TIME ZONE 'Asia/Kolkata')::date) AS days_left";

function readReminder(b) {
  const r = {
    patient_name: str(b.patient_name, 80), phone: A.normalizePhone(b.phone), medicine: str(b.medicine, 120),
    every_days: Number(b.every_days), next_due: str(b.next_due, 10),
  };
  if (r.patient_name.length < 2) return { error: 'Please enter the patient\'s name.' };
  if (!r.phone) return { error: 'Please enter a valid 10-digit mobile number for the patient.' };
  if (r.medicine.length < 2) return { error: 'Please enter the medicine.' };
  if (!Number.isInteger(r.every_days) || r.every_days < 1 || r.every_days > 365) return { error: 'Refill cycle must be between 1 and 365 days.' };
  if (!isDate(r.next_due)) return { error: 'Please choose the next refill date.' };
  return { r };
}

app.get('/api/reminders', requireUser, requireAccess, wrap(async (req, res) => {
  const r = await pool.query(`SELECT ${REM_COLS} FROM reminders WHERE user_id=$1 ORDER BY next_due ASC, patient_name ASC`, [req.user.id]);
  res.json({ reminders: r.rows });
}));

app.post('/api/reminders', requireUser, requireAccess, wrap(async (req, res) => {
  const { r, error } = readReminder(req.body || {});
  if (error) return bad(res, error);
  const lim = effectiveLimits(req.user);
  if (lim.maxReminders) {
    const c = await pool.query('SELECT count(*)::int AS n FROM reminders WHERE user_id=$1', [req.user.id]);
    if (c.rows[0].n >= lim.maxReminders) return res.status(403).json({ error: 'limit', message: `Your ${lim.name} plan allows up to ${lim.maxReminders} refill reminders. Upgrade for more.` });
  }
  const q = await pool.query(
    `INSERT INTO reminders(user_id, patient_name, phone, medicine, every_days, next_due) VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${REM_COLS}`,
    [req.user.id, r.patient_name, r.phone, r.medicine, r.every_days, r.next_due]
  );
  res.status(201).json({ reminder: q.rows[0] });
}));

app.put('/api/reminders/:id', requireUser, requireAccess, wrap(async (req, res) => {
  const { r, error } = readReminder(req.body || {});
  if (error) return bad(res, error);
  const q = await pool.query(
    `UPDATE reminders SET patient_name=$1, phone=$2, medicine=$3, every_days=$4, next_due=$5 WHERE id=$6 AND user_id=$7 RETURNING ${REM_COLS}`,
    [r.patient_name, r.phone, r.medicine, r.every_days, r.next_due, Number(req.params.id) || 0, req.user.id]
  );
  if (!q.rowCount) return res.status(404).json({ error: 'not_found', message: 'Reminder not found.' });
  res.json({ reminder: q.rows[0] });
}));

// Called after the store taps "Send on WhatsApp": moves the next due date forward by one cycle.
app.post('/api/reminders/:id/sent', requireUser, requireAccess, wrap(async (req, res) => {
  const q = await pool.query(
    `UPDATE reminders SET last_sent_at=now(), next_due = GREATEST(next_due, (now() AT TIME ZONE 'Asia/Kolkata')::date) + every_days WHERE id=$1 AND user_id=$2 RETURNING ${REM_COLS}`,
    [Number(req.params.id) || 0, req.user.id]
  );
  if (!q.rowCount) return res.status(404).json({ error: 'not_found', message: 'Reminder not found.' });
  res.json({ reminder: q.rows[0] });
}));

app.delete('/api/reminders/:id', requireUser, requireAccess, wrap(async (req, res) => {
  const q = await pool.query('DELETE FROM reminders WHERE id=$1 AND user_id=$2', [Number(req.params.id) || 0, req.user.id]);
  if (!q.rowCount) return res.status(404).json({ error: 'not_found', message: 'Reminder not found.' });
  res.json({ ok: true });
}));

app.get('/api/reminders.csv', requireUser, requireAccess, wrap(async (req, res) => {
  if (req.user.plan !== 'clinic' && accountStatus(req.user).state !== 'trial') return res.status(403).json({ error: 'limit', message: 'Reminder download is part of the Clinic+ plan.' });
  const q = await pool.query(`SELECT ${REM_COLS} FROM reminders WHERE user_id=$1 ORDER BY next_due ASC`, [req.user.id]);
  const lines = [['Patient', 'Mobile', 'Medicine', 'Every (days)', 'Next refill'].join(',')];
  q.rows.forEach((r) => lines.push([r.patient_name, r.phone, r.medicine, r.every_days, r.next_due].map(csvCell).join(',')));
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="dawalekh-reminders.csv"');
  res.send('\ufeff' + lines.join('\n'));
}));

// ---------- billing ----------
async function markPaid(orderId, paymentId, source) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const p = await client.query('SELECT * FROM payments WHERE razorpay_order_id=$1 FOR UPDATE', [orderId]);
    const pay = p.rows[0];
    if (!pay) { await client.query('ROLLBACK'); return { ok: false, reason: 'unknown_order' }; }
    if (pay.status === 'paid') { await client.query('COMMIT'); return { ok: true, already: true }; }
    await client.query("UPDATE payments SET status='paid', razorpay_payment_id=COALESCE($2, razorpay_payment_id), paid_at=now() WHERE id=$1", [pay.id, paymentId || null]);
    await client.query(
      `UPDATE users SET plan=$1, paid_until = GREATEST(COALESCE(paid_until, trial_ends_at), now()) + ($2 || ' days')::interval WHERE id=$3`,
      [pay.plan, String(PERIOD_DAYS), pay.user_id]
    );
    await client.query('COMMIT');
    console.log(`payment marked paid via ${source}: order ${orderId}`);
    return { ok: true };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

app.post('/api/billing/order', requireUser, wrap(async (req, res) => {
  const c = RZ.config();
  if (!c.enabled) return res.status(503).json({ error: 'payments_not_connected', message: 'Online payments are not connected yet. Please try again later.' });
  const plan = PLANS[String((req.body || {}).plan || '')];
  if (!plan) return bad(res, 'Please choose a plan.');
  if (A.rateLimited(`order:${req.user.id}`, 15, 60 * 60 * 1000)) return res.status(429).json({ error: 'rate_limited', message: 'Too many attempts. Please try again later.' });
  const amountPaise = plan.price * 100;
  const order = await RZ.createOrder({
    amountPaise,
    receipt: `mk_${req.user.id}_${Date.now()}`,
    notes: { user_id: String(req.user.id), plan: plan.id, store: req.user.store_name.slice(0, 200) },
  });
  await pool.query('INSERT INTO payments(user_id, plan, amount_paise, razorpay_order_id, live_mode) VALUES ($1,$2,$3,$4,$5)', [req.user.id, plan.id, amountPaise, order.id, c.liveMode]);
  res.json({
    key_id: c.keyId, order_id: order.id, amount: amountPaise, currency: 'INR', plan: { id: plan.id, name: plan.name, price: plan.price },
    test_mode: !c.liveMode,
    prefill: { name: req.user.owner_name, contact: `+91${req.user.phone}`, email: req.user.email || undefined },
  });
}));

app.post('/api/billing/verify', requireUser, wrap(async (req, res) => {
  const c = RZ.config();
  if (!c.enabled) return res.status(503).json({ error: 'payments_not_connected' });
  const b = req.body || {};
  const orderId = str(b.razorpay_order_id, 64);
  const paymentId = str(b.razorpay_payment_id, 64);
  const signature = str(b.razorpay_signature, 128);
  const own = await pool.query('SELECT 1 FROM payments WHERE razorpay_order_id=$1 AND user_id=$2', [orderId, req.user.id]);
  if (!own.rowCount) return res.status(404).json({ error: 'not_found', message: 'Order not found.' });
  if (!RZ.verifyPaymentSignature(orderId, paymentId, signature, c.keySecret)) {
    return res.status(400).json({ error: 'bad_signature', message: 'We could not verify this payment. If money was deducted, it will be confirmed shortly or refunded by Razorpay.' });
  }
  await markPaid(orderId, paymentId, 'checkout');
  const u = await pool.query('SELECT * FROM users WHERE id=$1', [req.user.id]);
  res.json({ ok: true, user: publicUser(u.rows[0]) });
}));

app.get('/api/billing/history', requireUser, wrap(async (req, res) => {
  const r = await pool.query("SELECT plan, amount_paise, status, razorpay_payment_id, live_mode, paid_at, created_at FROM payments WHERE user_id=$1 AND status <> 'created' ORDER BY created_at DESC LIMIT 50", [req.user.id]);
  res.json({ payments: r.rows });
}));

// ---------- contact form ----------
app.post('/api/contact', wrap(async (req, res) => {
  if (A.rateLimited(`contact:${clientIp(req)}`, 5, 60 * 60 * 1000)) return res.status(429).json({ error: 'rate_limited', message: 'Too many messages. Please try again later.' });
  const b = req.body || {};
  const name = str(b.name, 80);
  const contact = str(b.contact, 120);
  const message = str(b.message, 2000);
  if (name.length < 2) return bad(res, 'Please enter your name.');
  if (!A.normalizePhone(contact) && !A.normalizeEmail(contact)) return bad(res, 'Please enter a valid mobile number or email so we can reply.');
  if (message.length < 5) return bad(res, 'Please write your message.');
  await pool.query('INSERT INTO contact_messages(name, contact, message) VALUES ($1,$2,$3)', [name, contact, message]);
  res.status(201).json({ ok: true });
}));

// ---------- owner admin (protected by ADMIN_KEY) ----------
function adminOk(req) {
  const key = process.env.ADMIN_KEY || '';
  const given = String(req.get('x-admin-key') || '');
  if (!key || key.length < 12) return false;
  return require('crypto').timingSafeEqual(Buffer.from(A.tokenHash(given)), Buffer.from(A.tokenHash(key)));
}


app.post('/api/email/verify', wrap(async (req, res) => {
  if (A.rateLimited(`verify:${clientIp(req)}`, 20, 60 * 60 * 1000)) return res.status(429).json({ error: 'rate_limited', message: 'Too many attempts. Please try again later.' });
  const r = await pool.query('DELETE FROM email_verifications WHERE token_hash=$1 AND expires_at > now() RETURNING user_id, email', [A.tokenHash(String((req.body || {}).token || ''))]);
  if (!r.rowCount) return res.status(400).json({ error: 'bad_token', message: 'This link is invalid or has expired. Log in and ask for a new confirmation email.' });
  const u = await pool.query('UPDATE users SET email_verified_at=now() WHERE id=$1 AND email=$2 RETURNING id', [r.rows[0].user_id, r.rows[0].email]);
  if (!u.rowCount) return res.status(400).json({ error: 'bad_token', message: 'This link is for an old email address. Log in and ask for a new confirmation email.' });
  res.json({ ok: true, message: 'Email confirmed. Thank you!' });
}));

app.post('/api/email/resend', requireUser, wrap(async (req, res) => {
  if (!MAIL.enabled()) return res.status(503).json({ error: 'email_off', message: 'Email is not available right now.' });
  if (!req.user.email) return bad(res, 'No email address is saved on this account.');
  if (req.user.email_verified_at) return res.json({ ok: true, message: 'Your email is already confirmed.' });
  if (A.rateLimited(`resend:${req.user.id}`, 3, 60 * 60 * 1000)) return res.status(429).json({ error: 'rate_limited', message: 'Please wait a while before asking for another email.' });
  const ok = await sendVerification(req.user, false);
  if (!ok) return res.status(502).json({ error: 'send_failed', message: 'Could not send the email right now. Please try again later.' });
  res.json({ ok: true, message: `Confirmation email sent to ${req.user.email}. Check your inbox (and spam folder).` });
}));

// ---------- forgot / reset password ----------
// With an email provider configured (lib/mailer.js), accounts with an email get the reset link by email automatically.
// Otherwise (or for accounts without email) a reset works like this:
// 1) the store asks on /forgot (saved as a request, same answer whether or not the account exists);
// 2) the Dawalekh team checks the request and creates a one-time link (admin key, valid 2 hours);
// 3) the team sends that link to the store's registered mobile on WhatsApp; the store sets a new password on /reset.
app.post('/api/password/forgot', wrap(async (req, res) => {
  if (A.rateLimited(`forgot:${clientIp(req)}`, 5, 60 * 60 * 1000)) return res.status(429).json({ error: 'rate_limited', message: 'Too many requests. Please try again later.' });
  const id = str((req.body || {}).login, 120);
  const phone = A.normalizePhone(id);
  const email = A.normalizeEmail(id);
  if (!phone && !email) return bad(res, 'Please enter the mobile number or email you signed up with.', 'login');
  const r = phone ? await pool.query('SELECT id, email FROM users WHERE phone=$1', [phone]) : await pool.query('SELECT id, email FROM users WHERE email=$1', [email]);
  const u = r.rows[0];
  let emailed = false;
  if (u && u.email && MAIL.enabled() && !A.rateLimited(`forgotmail:${u.id}`, 3, 60 * 60 * 1000)) {
    const token = A.newToken();
    await pool.query('DELETE FROM password_resets WHERE user_id=$1', [u.id]);
    await pool.query("INSERT INTO password_resets(token_hash, user_id, expires_at) VALUES ($1,$2, now() + interval '1 hour')", [A.tokenHash(token), u.id]);
    const m = MAIL.resetMail({ link: `${PUBLIC_BASE()}/reset?token=${token}` });
    emailed = (await MAIL.send({ to: u.email, ...m })).ok;
  }
  if (u && !emailed) {
    await pool.query('INSERT INTO contact_messages(name, contact, message) VALUES ($1,$2,$3)', ['Password reset request', phone || email, `User #${u.id} asked to reset their password.`]);
  }
  // Same answer whether or not the account exists (no account guessing).
  const msg = MAIL.enabled()
    ? 'Request received. If an account exists with an email address, we have emailed it a reset link (valid 1 hour; check the spam folder too). Accounts without an email get the link from the Dawalekh team on their registered mobile number on WhatsApp, usually within a few hours.'
    : 'Request received. If an account exists for this number or email, the Dawalekh team will send a reset link to your registered mobile number on WhatsApp, usually within a few hours.';
  res.json({ ok: true, message: msg });
}));

app.post('/api/admin/reset-link', wrap(async (req, res) => {
  if (!adminOk(req)) { await new Promise((r) => setTimeout(r, 600)); return res.status(403).json({ error: 'forbidden' }); }
  const id = str((req.body || {}).login, 120);
  const phone = A.normalizePhone(id);
  const email = A.normalizeEmail(id);
  const r = phone ? await pool.query('SELECT id, phone, store_name FROM users WHERE phone=$1', [phone])
    : email ? await pool.query('SELECT id, phone, store_name FROM users WHERE email=$1', [email]) : { rows: [] };
  const u = r.rows[0];
  if (!u) return res.status(404).json({ error: 'not_found' });
  const token = A.newToken();
  await pool.query('DELETE FROM password_resets WHERE user_id=$1', [u.id]);
  await pool.query("INSERT INTO password_resets(token_hash, user_id, expires_at) VALUES ($1,$2, now() + interval '2 hours')", [A.tokenHash(token), u.id]);
  const base = process.env.PUBLIC_URL || 'https://dawalekh.netlify.app';
  res.json({ store_name: u.store_name, phone: u.phone, link: `${base}/reset?token=${token}`, expires_in_hours: 2 });
}));

app.post('/api/password/reset', wrap(async (req, res) => {
  if (A.rateLimited(`reset:${clientIp(req)}`, 10, 60 * 60 * 1000)) return res.status(429).json({ error: 'rate_limited', message: 'Too many attempts. Please try again later.' });
  const b = req.body || {};
  const password = String(b.password || '');
  if (password.length < 8) return bad(res, 'Password must be at least 8 characters.', 'password');
  const r = await pool.query('DELETE FROM password_resets WHERE token_hash=$1 AND expires_at > now() RETURNING user_id', [A.tokenHash(String(b.token || ''))]);
  if (!r.rowCount) return res.status(400).json({ error: 'bad_token', message: 'This reset link is invalid or has expired. Please ask for a new one.' });
  const userId = r.rows[0].user_id;
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [A.hashPassword(password), userId]);
  await pool.query('DELETE FROM sessions WHERE user_id=$1', [userId]);
  await startSession(res, userId);
  res.json({ ok: true });
}));

app.get('/api/admin/overview', wrap(async (req, res) => {
  if (!adminOk(req)) {
    await new Promise((r) => setTimeout(r, 600));
    return res.status(403).json({ error: 'forbidden' });
  }
  const users = await pool.query('SELECT id, store_name, owner_name, phone, email, city, plan, trial_ends_at, paid_until, created_at FROM users ORDER BY created_at DESC LIMIT 200');
  const pays = await pool.query("SELECT p.created_at, p.paid_at, p.plan, p.amount_paise, p.status, p.live_mode, u.store_name FROM payments p JOIN users u ON u.id=p.user_id WHERE p.status <> 'created' ORDER BY p.created_at DESC LIMIT 100");
  const msgs = await pool.query('SELECT name, contact, message, created_at FROM contact_messages ORDER BY created_at DESC LIMIT 100');
  res.json({ users: users.rows.map((u) => ({ ...u, status: accountStatus(u).state })), payments: pays.rows, messages: msgs.rows });
}));

// ---------- static site ----------
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: PROD ? '1h' : 0 }));

app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', '404.html')));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  if (res.headersSent) return;
  const status = err.status && err.status < 500 ? 502 : 500;
  res.status(status).json({ error: 'server_error', message: status === 502 ? 'Payment service error. Please try again.' : 'Something went wrong. Please try again.' });
});

const PORT = Number(process.env.PORT) || 3000;
if (require.main === module) {
  migrate(pool).then(() => {
    app.listen(PORT, () => console.log(`Dawalekh listening on ${PORT}`));
  }).catch((e) => {
    console.error('Database setup failed:', e.message);
    process.exit(1);
  });
}

module.exports = { app, pool, migrate: () => migrate(pool), accountStatus };
