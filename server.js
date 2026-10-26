// Dawalekh server: marketing site, accounts, stock, alerts, reminders and Razorpay billing.
const path = require('path');
const express = require('express');
const { makePool, migrate } = require('./db');
const A = require('./lib/auth');
const RZ = require('./lib/razorpay');
const MAIL = require('./lib/mailer');
const { PLANS, BASIC, READ_ONLY, TRIAL_DAYS, TRIAL_HOURS, planName, planDays, planTier, limitsFor } = require('./lib/plans');

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


// Own-domain frontend (GitHub Pages, e.g. https://dawalekh.publicvm.com) calls this API directly. It sends the
// session as "Authorization: Bearer <token>" (no third-party cookies), so CORS needs no credentials.
const CORS_ORIGINS = new Set(['https://dawalekh.publicvm.com', 'https://www.dawalekh.publicvm.com', 'https://dawalekh1.publicvm.com', 'https://dawa-lekh.publicvm.com', 'https://wildsouleast.github.io', 'http://localhost:8765']
  .concat(String(process.env.EXTRA_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean)));
app.use('/api', (req, res, next) => {
  const o = req.get('origin');
  if (o && CORS_ORIGINS.has(o)) {
    res.set('Access-Control-Allow-Origin', o);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Token-Auth');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.set('Access-Control-Expose-Headers', 'Content-Disposition');
    res.set('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.status(204).end();
  }
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
    return { state: 'active', plan: u.plan, tier: planTier(u.plan), plan_name: planName(u.plan), paid_until: u.paid_until, ms_left: paidUntil - now };
  }
  if (trialEnds > now && !u.paid_until) {
    return { state: 'trial', plan: 'trial', plan_name: 'Free trial', trial_ends_at: u.trial_ends_at, ms_left: trialEnds - now };
  }
  // Trial or paid period over, no payment: the store is READ-ONLY (view + download everything, add nothing). Nothing is deleted.
  return { state: 'expired', plan: 'expired', plan_name: 'Read-only', read_only: true, ended_at: u.paid_until || u.trial_ends_at, ended: u.paid_until ? 'paid' : 'trial', ms_left: 0 };
}

function effectiveLimits(u) {
  return limitsFor(accountStatus(u).state, u.plan);
}

// Bills made this calendar month (India time); the Basic plan allows BASIC.maxBillsPerMonth.
async function billsThisMonth(db, userId) {
  const r = await db.query(
    `SELECT count(*)::int AS n FROM bills WHERE user_id=$1
      AND created_at >= (date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`, [userId]);
  return r.rows[0].n;
}

async function usageFor(u) {
  const m = await pool.query('SELECT count(*)::int AS n FROM medicines WHERE user_id=$1', [u.id]);
  const r = await pool.query('SELECT count(*)::int AS n FROM reminders WHERE user_id=$1', [u.id]);
  return { medicines: m.rows[0].n, bills_this_month: await billsThisMonth(pool, u.id), reminders: r.rows[0].n };
}

function publicUser(u) {
  return { id: u.id, store_name: u.store_name, owner_name: u.owner_name, phone: u.phone, email: u.email, email_verified: Boolean(u.email && u.email_verified_at), city: u.city, store_address: u.store_address || '', gstin: u.gstin || '', drug_licence: u.drug_licence || '', created_at: u.created_at, status: accountStatus(u) };
}

function bearer(req) {
  const m = /^Bearer\s+([A-Za-z0-9_\-.]{20,200})$/.exec(String(req.get('authorization') || ''));
  return m ? m[1] : null;
}
async function loadUser(req) {
  const token = bearer(req) || parseCookies(req)[COOKIE];
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

// Server-side trial / subscription gate. An expired store is read-only: GET (view, CSV download) works, every change is refused.
const READ_ONLY_MSG = 'Aapka free trial / plan khatam ho gaya. Store abhi read-only hai: sab dekh sakte hain aur download kar sakte hain, par naya bill, purchase ya badlav ke liye plan lein (Basic ₹49/mahina se). Aapka data safe hai, kuch delete nahi hoga. / Your trial or plan has ended; the store is read-only until you choose a plan. Your data is safe.';
function requireAccess(req, res, next) {
  const s = accountStatus(req.user);
  if (s.state === 'expired' && req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(402).json({ error: 'plan_required', read_only: true, message: READ_ONLY_MSG });
  }
  next();
}

// Pro-only features (purchase entry, udhaar khata): available in the trial and on Pro; Basic can view what it already has.
function proRequired(res, what) {
  return res.status(403).json({ error: 'pro_required', message: `${what} Pro plan mein hai (₹149/mahina ya ₹1,499/saal). Basic plan (₹49) mein ye nahi hai. / ${what} needs the Pro plan.` });
}
function requirePro(what) {
  return (req, res, next) => (effectiveLimits(req.user).purchases ? next() : proRequired(res, what));
}
function limitMsg(lim, what) {
  return `${lim.name} plan mein ${what} tak. Unlimited ke liye Pro lein (₹149/mahina). / The ${lim.name} plan allows up to ${what}.`;
}

async function startSession(res, userId) {
  const token = A.newToken();
  await pool.query("INSERT INTO sessions(token_hash, user_id, expires_at) VALUES ($1,$2, now() + ($3 || ' days')::interval)", [A.tokenHash(token), userId, String(SESSION_DAYS)]);
  setSessionCookie(res, token);
  return token;
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
    plans: Object.values(PLANS).map((p) => ({ id: p.id, tier: p.tier, name: p.name, price: p.price, period: p.period, days: p.days, features: p.features })),
    basic: { name: BASIC.name, max_medicines: BASIC.maxMedicines, max_bills_per_month: BASIC.maxBillsPerMonth, max_reminders: BASIC.maxReminders },
    after_trial: 'read_only',
    trial_hours: TRIAL_HOURS,
    trial_days: TRIAL_DAYS,
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
const PUBLIC_BASE = () => process.env.PUBLIC_URL || 'https://dawalekh.publicvm.com';
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
  const tok = await startSession(res, r.rows[0].id);
  let emailSent = false;
  if (r.rows[0].email) emailSent = await sendVerification(r.rows[0], true).catch((e) => { console.error('[mail] signup', e.message); return false; });
  res.status(201).json(Object.assign({ user: publicUser(r.rows[0]), email_sent: emailSent }, req.get('x-token-auth') === '1' ? { token: tok } : {}));
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
  const tok = await startSession(res, u.id);
  res.json(Object.assign({ user: publicUser(u) }, req.get('x-token-auth') === '1' ? { token: tok } : {}));
}));

app.post('/api/logout', wrap(async (req, res) => {
  const token = bearer(req) || parseCookies(req)[COOKIE];
  if (token) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [A.tokenHash(token)]);
  clearSessionCookie(res);
  res.json({ ok: true });
}));

// Quiet check used by the login/signup pages (always 200, so no error in the browser console).
app.get('/api/session', wrap(async (req, res) => {
  const u = await loadUser(req);
  res.json({ logged_in: Boolean(u) });
}));

app.get('/api/me', requireUser, wrap(async (req, res) => {
  res.json({ user: publicUser(req.user), limits: effectiveLimits(req.user), usage: await usageFor(req.user) });
}));

app.put('/api/me', requireUser, wrap(async (req, res) => {
  const b = req.body || {};
  const store = str(b.store_name, 80);
  const owner = str(b.owner_name, 60);
  const city = str(b.city, 60);
  if (store.length < 2 || owner.length < 2 || city.length < 2) return bad(res, 'Store name, owner name and city are required.');
  // Bill header details (optional). A field left out of the request keeps its saved value.
  const address = b.store_address === undefined ? (req.user.store_address || '') : str(b.store_address, 200);
  const gstin = b.gstin === undefined ? (req.user.gstin || '') : str(b.gstin, 20).toUpperCase();
  const licence = b.drug_licence === undefined ? (req.user.drug_licence || '') : str(b.drug_licence, 120);
  if (gstin && !/^[0-9A-Z]{15}$/.test(gstin)) return bad(res, 'GSTIN should be 15 letters/numbers (e.g. 10ABCDE1234F1Z5). Leave it empty if you do not have one.', 'gstin');
  const r = await pool.query('UPDATE users SET store_name=$1, owner_name=$2, city=$3, store_address=$4, gstin=$5, drug_licence=$6 WHERE id=$7 RETURNING *', [store, owner, city, address, gstin, licence, req.user.id]);
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
    if (c.rows[0].n >= lim.maxMedicines) return res.status(403).json({ error: 'limit', message: limitMsg(lim, `${lim.maxMedicines} dawai`) });
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
  if (!effectiveLimits(req.user).csvExport) return res.status(403).json({ error: 'limit', message: 'CSV download Pro plan mein hai (₹149/mahina). / CSV download is part of the Pro plan.' });
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

// ---------- customer bills ----------
// Available in every plan, including the free trial (requireAccess only blocks expired accounts).
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const BILL_COLS = "b.id, b.bill_no, b.customer_name, b.customer_phone, b.subtotal::float AS subtotal, b.discount_type, b.discount_value::float AS discount_value, b.discount_amount::float AS discount_amount, b.gst_percent::float AS gst_percent, b.gst_mode, b.gst_amount::float AS gst_amount, b.total::float AS total, b.created_at";

function cleanPhone(v) {
  let d = String(v == null ? '' : v).replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
}

function istDate(offsetDays) {
  const d = new Date(Date.now() + 5.5 * 3600e3 + (offsetDays || 0) * 864e5);
  return d.toISOString().slice(0, 10);
}

app.get('/api/bills', requireUser, requireAccess, wrap(async (req, res) => {
  const from = isDate(req.query.from) ? req.query.from : istDate(0);
  const to = isDate(req.query.to) ? req.query.to : from;
  if (to < from) return bad(res, 'The "to" date is before the "from" date.');
  const q = await pool.query(
    `SELECT ${BILL_COLS}, (SELECT count(*)::int FROM bill_items i WHERE i.bill_id=b.id) AS item_count
       FROM bills b WHERE b.user_id=$1 AND (b.created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2 AND $3
       ORDER BY b.created_at DESC LIMIT 500`, [req.user.id, from, to]);
  const sum = await pool.query(
    `SELECT count(*)::int AS count, COALESCE(sum(total),0)::float AS total FROM bills
      WHERE user_id=$1 AND (created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2 AND $3`, [req.user.id, from, to]);
  const today = await pool.query(
    `SELECT count(*)::int AS count, COALESCE(sum(total),0)::float AS total FROM bills
      WHERE user_id=$1 AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = $2`, [req.user.id, istDate(0)]);
  res.json({ from, to, bills: q.rows, summary: sum.rows[0], today: today.rows[0] });
}));

app.get('/api/bills/:id', requireUser, requireAccess, wrap(async (req, res) => {
  const b = await pool.query(`SELECT ${BILL_COLS} FROM bills b WHERE b.id=$1 AND b.user_id=$2`, [Number(req.params.id) || 0, req.user.id]);
  if (!b.rowCount) return res.status(404).json({ error: 'not_found', message: 'Bill not found.' });
  const items = await pool.query("SELECT id, medicine_id, name, batch, to_char(expiry,'YYYY-MM-DD') AS expiry, qty, price::float AS price, amount::float AS amount FROM bill_items WHERE bill_id=$1 ORDER BY id", [b.rows[0].id]);
  res.json({ bill: { ...b.rows[0], items: items.rows } });
}));

app.post('/api/bills', requireUser, requireAccess, wrap(async (req, res) => {
  const body = req.body || {};
  const customerName = str(body.customer_name, 80);
  const customerPhone = cleanPhone(body.customer_phone);
  if (customerPhone && !/^[6-9]\d{9}$/.test(customerPhone)) return bad(res, 'Customer mobile number should be 10 digits (or leave it empty).', 'customer_phone');
  const raw = Array.isArray(body.items) ? body.items : [];
  if (!raw.length) return bad(res, 'Add at least one medicine to the bill.');
  if (raw.length > 100) return bad(res, 'A bill can have up to 100 lines.');
  const lines = [];
  for (const it of raw) {
    const id = Number(it && it.medicine_id), qty = Number(it && it.qty), price = Number(it && it.price);
    if (!Number.isInteger(id) || id <= 0) return bad(res, 'Please pick each medicine from your stock.');
    if (!Number.isInteger(qty) || qty < 1 || qty > 100000) return bad(res, 'Quantity must be a whole number (1 or more).');
    if (!Number.isFinite(price) || price < 0 || price > 10000000) return bad(res, 'Please enter a valid price.');
    lines.push({ id, qty, price: round2(price) });
  }
  const dType = body.discount_type === 'percent' ? 'percent' : 'amount';
  const dValue = body.discount_value === '' || body.discount_value == null ? 0 : Number(body.discount_value);
  if (!Number.isFinite(dValue) || dValue < 0 || (dType === 'percent' && dValue > 100)) return bad(res, 'Please enter a valid discount.');
  const gstMode = ['incl', 'excl'].includes(body.gst_mode) ? body.gst_mode : 'none';
  const gstPct = gstMode === 'none' ? 0 : Number(body.gst_percent);
  if (!Number.isFinite(gstPct) || gstPct < 0 || gstPct > 28) return bad(res, 'GST % should be between 0 and 28.');
  const asUdhaar = body.udhaar === true;
  if (asUdhaar && !effectiveLimits(req.user).khata) return proRequired(res, 'Udhaar khata');
  if (asUdhaar && customerName.length < 2) return bad(res, 'Udhaar ke liye customer ka naam likhein. / Enter the customer name for udhaar.', 'customer_name');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the store row so bill numbers stay in order, then the medicines being sold.
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [req.user.id]);
    const blim = effectiveLimits(req.user);
    if (blim.maxBillsPerMonth && (await billsThisMonth(client, req.user.id)) >= blim.maxBillsPerMonth) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'limit', message: limitMsg(blim, `mahine ke ${blim.maxBillsPerMonth} bill`) });
    }
    const ids = [...new Set(lines.map((l) => l.id))];
    const mq = await client.query(`SELECT ${MED_COLS} FROM medicines WHERE user_id=$1 AND id = ANY($2::int[]) FOR UPDATE`, [req.user.id, ids]);
    const meds = new Map(mq.rows.map((m) => [m.id, m]));
    const want = new Map();
    for (const l of lines) {
      const m = meds.get(l.id);
      if (!m) { await client.query('ROLLBACK'); return bad(res, 'A medicine on this bill is no longer in your stock. Please remove it and try again.'); }
      if (m.days_left < 0) { await client.query('ROLLBACK'); return bad(res, `${m.name}${m.batch ? ' (batch ' + m.batch + ')' : ''} has expired. Expired medicine cannot be billed.`); }
      want.set(l.id, (want.get(l.id) || 0) + l.qty);
    }
    for (const [id, q] of want) {
      const m = meds.get(id);
      if (q > m.qty) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'not_enough_stock', medicine_id: id, available: m.qty, message: `Only ${m.qty} of ${m.name}${m.batch ? ' (batch ' + m.batch + ')' : ''} in stock. You asked for ${q}.` });
      }
    }
    const subtotal = round2(lines.reduce((s, l) => s + round2(l.qty * l.price), 0));
    let discount = dType === 'percent' ? round2(subtotal * dValue / 100) : round2(dValue);
    if (discount > subtotal) { await client.query('ROLLBACK'); return bad(res, 'Discount cannot be more than the bill amount.'); }
    const taxable = round2(subtotal - discount);
    let gst = 0, total = taxable;
    if (gstMode === 'incl') gst = round2(taxable - taxable / (1 + gstPct / 100));
    if (gstMode === 'excl') { gst = round2(taxable * gstPct / 100); total = round2(taxable + gst); }
    const no = await client.query('SELECT COALESCE(max(bill_no),0)+1 AS n FROM bills WHERE user_id=$1', [req.user.id]);
    const bill = await client.query(
      `INSERT INTO bills(user_id, bill_no, customer_name, customer_phone, subtotal, discount_type, discount_value, discount_amount, gst_percent, gst_mode, gst_amount, total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [req.user.id, no.rows[0].n, customerName, customerPhone, subtotal, dType, round2(dValue), discount, gstPct, gstMode, gst, total]);
    const billId = bill.rows[0].id;
    for (const l of lines) {
      const m = meds.get(l.id);
      await client.query('INSERT INTO bill_items(bill_id, medicine_id, name, batch, expiry, qty, price, amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [billId, m.id, m.name, m.batch, m.expiry, l.qty, l.price, round2(l.qty * l.price)]);
    }
    for (const [id, q] of want) await client.query('UPDATE medicines SET qty=qty-$1, updated_at=now() WHERE id=$2 AND user_id=$3', [q, id, req.user.id]);
    if (asUdhaar && total > 0) {
      const cust = await findOrCreateCustomer(client, req.user.id, customerName, customerPhone);
      await client.query("INSERT INTO khata_entries(user_id, customer_id, kind, amount, note, bill_id, entry_date) VALUES ($1,$2,'udhaar',$3,$4,$5,$6)",
        [req.user.id, cust.id, total, `Bill #${no.rows[0].n}`, billId, istDate(0)]);
    }
    await client.query('COMMIT');
    const b = await pool.query(`SELECT ${BILL_COLS} FROM bills b WHERE b.id=$1`, [billId]);
    const items = await pool.query("SELECT id, medicine_id, name, batch, to_char(expiry,'YYYY-MM-DD') AS expiry, qty, price::float AS price, amount::float AS amount FROM bill_items WHERE bill_id=$1 ORDER BY id", [billId]);
    res.status(201).json({ bill: { ...b.rows[0], items: items.rows } });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}));

// Cancel a bill: the sold quantity goes back into stock (if the medicine still exists).
app.delete('/api/bills/:id', requireUser, requireAccess, wrap(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const b = await client.query('SELECT id FROM bills WHERE id=$1 AND user_id=$2 FOR UPDATE', [Number(req.params.id) || 0, req.user.id]);
    if (!b.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not_found', message: 'Bill not found.' }); }
    const items = await client.query('SELECT medicine_id, qty FROM bill_items WHERE bill_id=$1 AND medicine_id IS NOT NULL', [b.rows[0].id]);
    for (const it of items.rows) await client.query('UPDATE medicines SET qty=qty+$1, updated_at=now() WHERE id=$2 AND user_id=$3', [it.qty, it.medicine_id, req.user.id]);
    await client.query('DELETE FROM bills WHERE id=$1', [b.rows[0].id]);
    await client.query('COMMIT');
    res.json({ ok: true, restored: items.rowCount });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
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
    if (c.rows[0].n >= lim.maxReminders) return res.status(403).json({ error: 'limit', message: limitMsg(lim, `${lim.maxReminders} refill reminders`) });
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
  if (!effectiveLimits(req.user).csvExport) return res.status(403).json({ error: 'limit', message: 'CSV download Pro plan mein hai (₹149/mahina). / CSV download is part of the Pro plan.' });
  const q = await pool.query(`SELECT ${REM_COLS} FROM reminders WHERE user_id=$1 ORDER BY next_due ASC`, [req.user.id]);
  const lines = [['Patient', 'Mobile', 'Medicine', 'Every (days)', 'Next refill'].join(',')];
  q.rows.forEach((r) => lines.push([r.patient_name, r.phone, r.medicine, r.every_days, r.next_due].map(csvCell).join(',')));
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="dawalekh-reminders.csv"');
  res.send('\ufeff' + lines.join('\n'));
}));

// ---------- purchase entry (stock in from a supplier bill) ----------
const PUR_COLS = "p.id, p.supplier, p.invoice_no, to_char(p.purchase_date,'YYYY-MM-DD') AS purchase_date, p.total::float AS total, p.note, p.created_at";
const PUR_ITEM_COLS = "id, medicine_id, name, batch, to_char(expiry,'YYYY-MM-DD') AS expiry, qty, rate::float AS rate, mrp::float AS mrp, amount::float AS amount";

function readPurchase(b) {
  const p = { supplier: str(b.supplier, 80), invoice_no: str(b.invoice_no, 40), purchase_date: str(b.purchase_date, 10), note: str(b.note, 200) };
  if (p.supplier.length < 2) return { error: 'Supplier / distributor ka naam likhein. / Enter the supplier name.' };
  if (!isDate(p.purchase_date)) return { error: 'Purchase date sahi chunein. / Choose a valid purchase date.' };
  const raw = Array.isArray(b.items) ? b.items : [];
  if (!raw.length) return { error: 'Kam se kam ek dawai jodein. / Add at least one medicine.' };
  if (raw.length > 200) return { error: 'One purchase can have up to 200 lines.' };
  p.items = [];
  for (const it of raw) {
    const x = { name: str(it && it.name, 100), batch: str(it && it.batch, 40), expiry: str(it && it.expiry, 10), qty: Number(it && it.qty), rate: Number(it && it.rate), mrp: Number(it && it.mrp) };
    const tag = x.name || 'a line';
    if (x.name.length < 2) return { error: 'Har line mein dawai ka naam likhein. / Enter the medicine name on every line.' };
    if (!isDate(x.expiry)) return { error: `${tag}: expiry date sahi chunein. / Choose a valid expiry date.` };
    if (!Number.isInteger(x.qty) || x.qty < 1 || x.qty > 1000000) return { error: `${tag}: quantity 1 ya zyada (whole number). / Quantity must be 1 or more.` };
    if (!Number.isFinite(x.rate) || x.rate < 0 || x.rate > 1000000) return { error: `${tag}: purchase rate sahi likhein. / Enter a valid purchase rate.` };
    if (!Number.isFinite(x.mrp) || x.mrp < 0 || x.mrp > 1000000) return { error: `${tag}: MRP sahi likhein. / Enter a valid MRP.` };
    x.rate = round2(x.rate); x.mrp = round2(x.mrp); x.amount = round2(x.qty * x.rate);
    p.items.push(x);
  }
  p.total = round2(p.items.reduce((s, x) => s + x.amount, 0));
  return { p };
}

// Adds each line to stock: same name + batch -> quantity goes up (expiry, MRP, rate, supplier updated); otherwise a new medicine.
async function applyPurchaseItems(client, user, purchaseId, p) {
  const lim = effectiveLimits(user);
  for (const x of p.items) {
    const ex = await client.query('SELECT id FROM medicines WHERE user_id=$1 AND lower(name)=lower($2) AND lower(batch)=lower($3) ORDER BY id LIMIT 1 FOR UPDATE', [user.id, x.name, x.batch]);
    let medId;
    if (ex.rowCount) {
      medId = ex.rows[0].id;
      await client.query('UPDATE medicines SET qty=qty+$1, expiry=$2, price=$3, purchase_rate=$4, supplier=$5, updated_at=now() WHERE id=$6',
        [x.qty, x.expiry, x.mrp, x.rate, p.supplier, medId]);
    } else {
      if (lim.maxMedicines) {
        const c = await client.query('SELECT count(*)::int AS n FROM medicines WHERE user_id=$1', [user.id]);
        if (c.rows[0].n >= lim.maxMedicines) {
          const err = new Error('limit'); err.limitMessage = `${lim.name} plan mein ${lim.maxMedicines} dawai tak. "${x.name}" nayi dawai hai, isliye nahi jud saki. Pro lein (₹149/mahina). / The ${lim.name} plan allows up to ${lim.maxMedicines} medicines.`; throw err;
        }
      }
      const ins = await client.query('INSERT INTO medicines(user_id, name, batch, expiry, qty, price, purchase_rate, supplier) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
        [user.id, x.name, x.batch, x.expiry, x.qty, x.mrp, x.rate, p.supplier]);
      medId = ins.rows[0].id;
    }
    await client.query('INSERT INTO purchase_items(purchase_id, medicine_id, name, batch, expiry, qty, rate, mrp, amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [purchaseId, medId, x.name, x.batch, x.expiry, x.qty, x.rate, x.mrp, x.amount]);
  }
}

// Takes a purchase's quantities back out of stock (never below 0, since some may already be sold). Returns lines that could not be fully reversed.
async function reversePurchaseItems(client, userId, purchaseId) {
  const items = await client.query('SELECT medicine_id, name, qty FROM purchase_items WHERE purchase_id=$1', [purchaseId]);
  const short = [];
  for (const it of items.rows) {
    if (!it.medicine_id) continue;
    const m = await client.query('SELECT qty FROM medicines WHERE id=$1 AND user_id=$2 FOR UPDATE', [it.medicine_id, userId]);
    if (!m.rowCount) continue;
    const take = Math.min(m.rows[0].qty, it.qty);
    if (take < it.qty) short.push({ name: it.name, sold: it.qty - take });
    await client.query('UPDATE medicines SET qty=qty-$1, updated_at=now() WHERE id=$2', [take, it.medicine_id]);
  }
  await client.query('DELETE FROM purchase_items WHERE purchase_id=$1', [purchaseId]);
  return short;
}

async function purchaseWithItems(db, id) {
  const p = await db.query(`SELECT ${PUR_COLS} FROM purchases p WHERE p.id=$1`, [id]);
  const items = await db.query(`SELECT ${PUR_ITEM_COLS} FROM purchase_items WHERE purchase_id=$1 ORDER BY id`, [id]);
  return { ...p.rows[0], items: items.rows };
}

async function inTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query(out && out.rollback ? 'ROLLBACK' : 'COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}


// ---------- AI Assistant: public WhatsApp order link ----------
// Each store gets a random public code (not its numeric id) for /order?s=CODE. The page shows the store name and
// opens WhatsApp to the store's order number with the customer's list prefilled. Nothing is stored for the customer.
function newOrderCode() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const b = require('crypto').randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += abc[b[i] % abc.length];
  return out;
}
async function ensureOrderCode(u) {
  if (u.order_code) return u.order_code;
  for (let i = 0; i < 5; i++) {
    const code = newOrderCode();
    try {
      const r = await pool.query('UPDATE users SET order_code=$1 WHERE id=$2 AND order_code IS NULL RETURNING order_code', [code, u.id]);
      if (r.rowCount) return r.rows[0].order_code;
      const again = await pool.query('SELECT order_code FROM users WHERE id=$1', [u.id]);
      if (again.rows[0] && again.rows[0].order_code) return again.rows[0].order_code;
    } catch (e) { if (e.code !== '23505') throw e; }
  }
  throw new Error('could not make an order code');
}
app.get('/api/ai/order-link', requireUser, wrap(async (req, res) => {
  const code = await ensureOrderCode(req.user);
  res.json({ code, order_phone: req.user.order_phone || '', login_phone: req.user.phone, store_name: req.user.store_name });
}));
app.put('/api/ai/order-link', requireUser, requireAccess, wrap(async (req, res) => {
  const raw = cleanPhone((req.body || {}).order_phone);
  if (raw && !/^[6-9]\d{9}$/.test(raw)) return bad(res, 'WhatsApp number 10 digit ka hona chahiye (ya khaali chhodein — tab login wala number use hoga).', 'order_phone');
  await pool.query('UPDATE users SET order_phone=$1 WHERE id=$2', [raw || '', req.user.id]);
  res.json({ ok: true, order_phone: raw || '' });
}));
app.get('/api/public/store/:code', wrap(async (req, res) => {
  const code = String(req.params.code || '').toLowerCase();
  if (!/^[a-z0-9]{6,12}$/.test(code)) return res.status(404).json({ error: 'not_found', message: 'Store link sahi nahi hai.' });
  if (A.rateLimited(`pubstore:${clientIp(req)}`, 120, 60 * 1000)) return res.status(429).json({ error: 'rate_limited', message: 'Thodi der baad try karein.' });
  const r = await pool.query('SELECT store_name, city, store_address, phone, order_phone FROM users WHERE order_code=$1', [code]);
  const u = r.rows[0];
  if (!u) return res.status(404).json({ error: 'not_found', message: 'Ye store link nahi mila. Store se naya link maangein.' });
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ store_name: u.store_name, city: u.city, store_address: u.store_address || '', wa: '91' + (u.order_phone || u.phone) });
}));

app.get('/api/purchases', requireUser, requireAccess, wrap(async (req, res) => {
  const supplier = str(req.query.supplier, 80);
  const q = await pool.query(
    `SELECT ${PUR_COLS}, (SELECT count(*)::int FROM purchase_items i WHERE i.purchase_id=p.id) AS item_count
       FROM purchases p WHERE p.user_id=$1 AND ($2 = '' OR lower(p.supplier)=lower($2))
       ORDER BY p.purchase_date DESC, p.id DESC LIMIT 500`, [req.user.id, supplier]);
  const sup = await pool.query(
    `SELECT min(supplier) AS supplier, count(*)::int AS count, COALESCE(sum(total),0)::float AS total, to_char(max(purchase_date),'YYYY-MM-DD') AS last_date
       FROM purchases WHERE user_id=$1 GROUP BY lower(supplier) ORDER BY sum(total) DESC`, [req.user.id]);
  const month = await pool.query(
    `SELECT count(*)::int AS count, COALESCE(sum(total),0)::float AS total FROM purchases
      WHERE user_id=$1 AND purchase_date >= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')::date`, [req.user.id]);
  res.json({ purchases: q.rows, suppliers: sup.rows, this_month: month.rows[0] });
}));

app.get('/api/purchases/:id', requireUser, requireAccess, wrap(async (req, res) => {
  const own = await pool.query('SELECT id FROM purchases WHERE id=$1 AND user_id=$2', [Number(req.params.id) || 0, req.user.id]);
  if (!own.rowCount) return res.status(404).json({ error: 'not_found', message: 'Purchase not found.' });
  res.json({ purchase: await purchaseWithItems(pool, own.rows[0].id) });
}));

app.post('/api/purchases', requireUser, requireAccess, requirePro('Purchase entry'), wrap(async (req, res) => {
  const { p, error } = readPurchase(req.body || {});
  if (error) return bad(res, error);
  try {
    const out = await inTx(async (client) => {
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [req.user.id]);
      const r = await client.query('INSERT INTO purchases(user_id, supplier, invoice_no, purchase_date, total, note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [req.user.id, p.supplier, p.invoice_no, p.purchase_date, p.total, p.note]);
      await applyPurchaseItems(client, req.user, r.rows[0].id, p);
      return { id: r.rows[0].id };
    });
    res.status(201).json({ purchase: await purchaseWithItems(pool, out.id) });
  } catch (e) {
    if (e.limitMessage) return res.status(403).json({ error: 'limit', message: e.limitMessage });
    throw e;
  }
}));

app.put('/api/purchases/:id', requireUser, requireAccess, requirePro('Purchase entry'), wrap(async (req, res) => {
  const { p, error } = readPurchase(req.body || {});
  if (error) return bad(res, error);
  try {
    const out = await inTx(async (client) => {
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [req.user.id]);
      const own = await client.query('SELECT id FROM purchases WHERE id=$1 AND user_id=$2 FOR UPDATE', [Number(req.params.id) || 0, req.user.id]);
      if (!own.rowCount) return { rollback: true, notFound: true };
      const id = own.rows[0].id;
      const short = await reversePurchaseItems(client, req.user.id, id);
      await client.query('UPDATE purchases SET supplier=$1, invoice_no=$2, purchase_date=$3, total=$4, note=$5, updated_at=now() WHERE id=$6',
        [p.supplier, p.invoice_no, p.purchase_date, p.total, p.note, id]);
      await applyPurchaseItems(client, req.user, id, p);
      return { id, short };
    });
    if (out.notFound) return res.status(404).json({ error: 'not_found', message: 'Purchase not found.' });
    res.json({ purchase: await purchaseWithItems(pool, out.id), short: out.short });
  } catch (e) {
    if (e.limitMessage) return res.status(403).json({ error: 'limit', message: e.limitMessage });
    throw e;
  }
}));

app.delete('/api/purchases/:id', requireUser, requireAccess, requirePro('Purchase entry'), wrap(async (req, res) => {
  const out = await inTx(async (client) => {
    const own = await client.query('SELECT id FROM purchases WHERE id=$1 AND user_id=$2 FOR UPDATE', [Number(req.params.id) || 0, req.user.id]);
    if (!own.rowCount) return { rollback: true, notFound: true };
    const short = await reversePurchaseItems(client, req.user.id, own.rows[0].id);
    await client.query('DELETE FROM purchases WHERE id=$1', [own.rows[0].id]);
    return { short };
  });
  if (out.notFound) return res.status(404).json({ error: 'not_found', message: 'Purchase not found.' });
  res.json({ ok: true, short: out.short });
}));

// ---------- udhaar khata (customer credit ledger) ----------
async function findOrCreateCustomer(db, userId, name, phone) {
  const r = phone
    ? await db.query('SELECT * FROM customers WHERE user_id=$1 AND phone=$2 ORDER BY id LIMIT 1', [userId, phone])
    : await db.query("SELECT * FROM customers WHERE user_id=$1 AND phone='' AND lower(name)=lower($2) ORDER BY id LIMIT 1", [userId, name]);
  if (r.rowCount) return r.rows[0];
  const ins = await db.query('INSERT INTO customers(user_id, name, phone) VALUES ($1,$2,$3) RETURNING *', [userId, name, phone]);
  return ins.rows[0];
}

const CUST_BAL = `COALESCE((SELECT sum(CASE WHEN e.kind='udhaar' THEN e.amount ELSE -e.amount END) FROM khata_entries e WHERE e.customer_id=c.id),0)::float`;

function readCustomer(b) {
  const name = str(b.name, 80);
  const phone = cleanPhone(b.phone);
  if (name.length < 2) return { error: 'Customer ka naam likhein. / Enter the customer name.' };
  if (phone && !/^[6-9]\d{9}$/.test(phone)) return { error: 'Mobile number 10 digit ka hona chahiye (ya khaali chhodein). / Mobile should be 10 digits.' };
  return { c: { name, phone } };
}

app.get('/api/khata', requireUser, requireAccess, wrap(async (req, res) => {
  const q = await pool.query(
    `SELECT c.id, c.name, c.phone, ${CUST_BAL} AS balance,
            (SELECT to_char(max(e.entry_date),'YYYY-MM-DD') FROM khata_entries e WHERE e.customer_id=c.id) AS last_date
       FROM customers c WHERE c.user_id=$1 ORDER BY balance DESC, c.name ASC LIMIT 1000`, [req.user.id]);
  const owing = q.rows.filter((r) => r.balance > 0.004);
  res.json({ customers: q.rows, total_due: round2(owing.reduce((s, r) => s + r.balance, 0)), owing_count: owing.length });
}));

app.post('/api/khata/customers', requireUser, requireAccess, requirePro('Udhaar khata'), wrap(async (req, res) => {
  const { c, error } = readCustomer(req.body || {});
  if (error) return bad(res, error);
  if (c.phone) {
    const d = await pool.query('SELECT id, name FROM customers WHERE user_id=$1 AND phone=$2 LIMIT 1', [req.user.id, c.phone]);
    if (d.rowCount) return res.status(409).json({ error: 'duplicate', message: `Is number pe pehle se customer hai: ${d.rows[0].name}. / A customer with this number exists.`, existing: d.rows[0] });
  }
  const r = await pool.query('INSERT INTO customers(user_id, name, phone) VALUES ($1,$2,$3) RETURNING id, name, phone', [req.user.id, c.name, c.phone]);
  res.status(201).json({ customer: { ...r.rows[0], balance: 0 } });
}));

app.get('/api/khata/customers/:id', requireUser, requireAccess, wrap(async (req, res) => {
  const c = await pool.query(`SELECT c.id, c.name, c.phone, ${CUST_BAL} AS balance FROM customers c WHERE c.id=$1 AND c.user_id=$2`, [Number(req.params.id) || 0, req.user.id]);
  if (!c.rowCount) return res.status(404).json({ error: 'not_found', message: 'Customer not found.' });
  const e = await pool.query(
    `SELECT e.id, e.kind, e.amount::float AS amount, e.note, e.bill_id, b.bill_no, to_char(e.entry_date,'YYYY-MM-DD') AS entry_date, e.created_at
       FROM khata_entries e LEFT JOIN bills b ON b.id=e.bill_id WHERE e.customer_id=$1 ORDER BY e.entry_date ASC, e.id ASC`, [c.rows[0].id]);
  let run = 0;
  const entries = e.rows.map((x) => { run = round2(run + (x.kind === 'udhaar' ? x.amount : -x.amount)); return { ...x, balance: run }; });
  res.json({ customer: c.rows[0], entries: entries.reverse() });
}));

app.put('/api/khata/customers/:id', requireUser, requireAccess, requirePro('Udhaar khata'), wrap(async (req, res) => {
  const { c, error } = readCustomer(req.body || {});
  if (error) return bad(res, error);
  const r = await pool.query('UPDATE customers SET name=$1, phone=$2 WHERE id=$3 AND user_id=$4 RETURNING id, name, phone', [c.name, c.phone, Number(req.params.id) || 0, req.user.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'not_found', message: 'Customer not found.' });
  res.json({ customer: r.rows[0] });
}));

app.delete('/api/khata/customers/:id', requireUser, requireAccess, requirePro('Udhaar khata'), wrap(async (req, res) => {
  const r = await pool.query('DELETE FROM customers WHERE id=$1 AND user_id=$2', [Number(req.params.id) || 0, req.user.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'not_found', message: 'Customer not found.' });
  res.json({ ok: true });
}));

// One entry: kind 'udhaar' (customer took on credit) or 'payment' (customer paid back).
// Customer by customer_id, or by name + phone (found or created). Optional bill_id links an existing bill (once).
app.post('/api/khata/entries', requireUser, requireAccess, wrap(async (req, res) => {
  const b = req.body || {};
  const kind = b.kind === 'payment' ? 'payment' : b.kind === 'udhaar' ? 'udhaar' : null;
  if (!kind) return bad(res, 'Choose udhaar or payment.');
  if (kind === 'udhaar' && !effectiveLimits(req.user).khata) return proRequired(res, 'Udhaar khata');
  const amount = round2(Number(b.amount));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000) return bad(res, 'Amount sahi likhein (0 se zyada). / Enter a valid amount.', 'amount');
  const date = b.entry_date ? str(b.entry_date, 10) : istDate(0);
  if (!isDate(date)) return bad(res, 'Date sahi chunein. / Choose a valid date.', 'entry_date');
  const note = str(b.note, 120);
  const out = await inTx(async (client) => {
    let cust;
    if (b.customer_id) {
      const c = await client.query('SELECT * FROM customers WHERE id=$1 AND user_id=$2', [Number(b.customer_id) || 0, req.user.id]);
      if (!c.rowCount) return { rollback: true, status: 404, body: { error: 'not_found', message: 'Customer not found.' } };
      cust = c.rows[0];
    } else {
      const { c, error } = readCustomer({ name: b.customer_name, phone: b.customer_phone });
      if (error) return { rollback: true, status: 400, body: { error: 'invalid', message: error, field: 'customer_name' } };
      cust = await findOrCreateCustomer(client, req.user.id, c.name, c.phone);
    }
    let billId = null;
    if (b.bill_id) {
      const bl = await client.query('SELECT id, bill_no FROM bills WHERE id=$1 AND user_id=$2', [Number(b.bill_id) || 0, req.user.id]);
      if (!bl.rowCount) return { rollback: true, status: 404, body: { error: 'not_found', message: 'Bill not found.' } };
      const used = await client.query('SELECT 1 FROM khata_entries WHERE bill_id=$1', [bl.rows[0].id]);
      if (used.rowCount) return { rollback: true, status: 409, body: { error: 'duplicate', message: 'Ye bill pehle se udhaar mein hai. / This bill is already in the udhaar khata.' } };
      billId = bl.rows[0].id;
    }
    const e = await client.query('INSERT INTO khata_entries(user_id, customer_id, kind, amount, note, bill_id, entry_date) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [req.user.id, cust.id, kind, amount, note, kind === 'udhaar' ? billId : null, date]);
    return { status: 201, body: { entry_id: e.rows[0].id, customer_id: cust.id } };
  });
  res.status(out.status).json(out.body);
}));

app.delete('/api/khata/entries/:id', requireUser, requireAccess, requirePro('Udhaar khata'), wrap(async (req, res) => {
  const r = await pool.query('DELETE FROM khata_entries WHERE id=$1 AND user_id=$2', [Number(req.params.id) || 0, req.user.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'not_found', message: 'Entry not found.' });
  res.json({ ok: true });
}));

// Is this bill already written in the udhaar khata? (bill view uses it)
app.get('/api/bills/:id/udhaar', requireUser, requireAccess, wrap(async (req, res) => {
  const r = await pool.query('SELECT e.customer_id, c.name FROM khata_entries e JOIN customers c ON c.id=e.customer_id JOIN bills b ON b.id=e.bill_id WHERE e.bill_id=$1 AND b.user_id=$2', [Number(req.params.id) || 0, req.user.id]);
  res.json({ udhaar: r.rows[0] || null });
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
      [pay.plan, String(planDays(pay.plan)), pay.user_id]
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
  const base = process.env.PUBLIC_URL || 'https://dawalekh.publicvm.com';
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
