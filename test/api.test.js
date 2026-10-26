// Integration test: needs a Postgres in TEST_DATABASE_URL (skipped otherwise).
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const DB = process.env.TEST_DATABASE_URL;
test('API flow: signup, trial, stock, alerts, reminders, paywall, webhook', { skip: !DB && 'TEST_DATABASE_URL not set' }, async () => {
  process.env.DATABASE_URL = DB;
  process.env.RAZORPAY_KEY_ID = '';
  process.env.RAZORPAY_KEY_SECRET = '';
  process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test_123';
  const { app, pool, migrate } = require('../server');
  await migrate();
  await pool.query('TRUNCATE users, sessions, medicines, reminders, payments, webhook_events, contact_messages RESTART IDENTITY CASCADE');
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie, ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text() };
  };
  try {
    let r = await call('POST', '/api/signup', { store_name: 'Test Medical', owner_name: 'Ravi', phone: '98765 43210', city: 'Gaya', password: 'short', accept_terms: true });
    assert.strictEqual(r.status, 400);
    r = await call('POST', '/api/signup', { store_name: 'Test Medical', owner_name: 'Ravi', phone: '+91 98765 43210', city: 'Gaya', password: 'secret123', accept_terms: true });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.user.status.state, 'trial');
    assert.ok(r.body.user.status.ms_left > 13.9 * 864e5 && r.body.user.status.ms_left <= 14 * 864e5, 'trial is 14 days');
    const hash = (await pool.query('SELECT password_hash FROM users')).rows[0].password_hash;
    assert.ok(hash.startsWith('scrypt$') && !hash.includes('secret123'));
    r = await call('POST', '/api/signup', { store_name: 'X', owner_name: 'Ravi', phone: '9876543210', city: 'Gaya', password: 'secret123', accept_terms: true });
    assert.notStrictEqual(r.status, 201);

    await call('POST', '/api/logout');
    cookie = '';
    assert.strictEqual((await call('GET', '/api/me')).status, 401);
    assert.strictEqual((await call('POST', '/api/login', { login: '9876543210', password: 'wrongpass' })).status, 401);
    assert.strictEqual((await call('POST', '/api/login', { login: '9876543210', password: 'secret123' })).status, 200);

    const day = (n) => new Date(Date.now() + n * 864e5 + 5.5 * 3600e3).toISOString().slice(0, 10);
    r = await call('POST', '/api/medicines', { name: 'Amoxicillin 500', batch: 'A1', expiry: day(10), qty: 5, price: 12.5, min_qty: 10 });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const medId = r.body.medicine.id;
    await call('POST', '/api/medicines', { name: 'Pantoprazole 40', batch: 'P1', expiry: day(45), qty: 50, price: 8, min_qty: 10 });
    await call('POST', '/api/medicines', { name: 'Vitamin D3', batch: 'V1', expiry: day(80), qty: 20, price: 30, min_qty: 5 });
    await call('POST', '/api/medicines', { name: 'Old Syrup', batch: 'O1', expiry: day(-3), qty: 2, price: 50, min_qty: 1 });
    assert.strictEqual((await call('POST', '/api/medicines', { name: 'Bad', expiry: 'nope', qty: 1, price: 1 })).status, 400);
    r = await call('PUT', `/api/medicines/${medId}`, { name: 'Amoxicillin 500 mg', batch: 'A1', expiry: day(10), qty: 4, price: 12.5, min_qty: 10 });
    assert.strictEqual(r.body.medicine.name, 'Amoxicillin 500 mg');
    r = await call('GET', '/api/alerts');
    assert.strictEqual(r.body.within30.length, 1);
    assert.strictEqual(r.body.within60.length, 1);
    assert.strictEqual(r.body.within90.length, 1);
    assert.strictEqual(r.body.expired.length, 1);
    assert.strictEqual(r.body.lowStock.length, 1);
    assert.strictEqual(r.body.totals.medicines, 4);
    r = await call('GET', '/api/medicines.csv');
    assert.strictEqual(r.status, 200);
    assert.ok(String(r.body).includes('Amoxicillin 500 mg'));

    r = await call('POST', '/api/reminders', { patient_name: 'Ramesh', phone: '9123456789', medicine: 'Metformin', every_days: 30, next_due: day(0) });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    r = await call('POST', `/api/reminders/${r.body.reminder.id}/sent`);
    assert.strictEqual(r.body.reminder.days_left, 30);

    // another user cannot see this store's data
    const mine = cookie;
    cookie = '';
    await call('POST', '/api/signup', { store_name: 'Other Store', owner_name: 'Sita', phone: '9000000001', city: 'Patna', password: 'secret123', accept_terms: true });
    assert.strictEqual((await call('GET', '/api/medicines')).body.medicines.length, 0);
    assert.strictEqual((await call('DELETE', `/api/medicines/${medId}`)).status, 404);
    cookie = mine;

    // payments not connected
    r = await call('POST', '/api/billing/order', { plan: 'monthly' });
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.body.error, 'payments_not_connected');

    // trial ends -> store drops to the Free plan (nothing locked, limits apply)
    await pool.query("UPDATE users SET trial_ends_at = now() - interval '1 minute' WHERE phone='9876543210'");
    assert.strictEqual((await call('GET', '/api/medicines')).status, 200);
    r = await call('GET', '/api/me');
    assert.strictEqual(r.body.user.status.state, 'free');
    assert.strictEqual(r.body.limits.maxMedicines, 100);
    assert.strictEqual(r.body.limits.maxBillsPerMonth, 50);
    assert.strictEqual((await call('GET', '/api/medicines.csv')).status, 403);

    // webhook marks the account active
    const uid = (await pool.query("SELECT id FROM users WHERE phone='9876543210'")).rows[0].id;
    await pool.query("INSERT INTO payments(user_id, plan, amount_paise, razorpay_order_id) VALUES ($1,'monthly',14900,'order_TEST1')", [uid]);
    const payload = JSON.stringify({ event: 'order.paid', created_at: 1, payload: { payment: { entity: { id: 'pay_TEST1', order_id: 'order_TEST1' } }, order: { entity: { id: 'order_TEST1' } } } });
    assert.strictEqual((await call('POST', '/api/razorpay/webhook', payload, { 'x-razorpay-signature': 'bad' })).status, 400);
    const sig = crypto.createHmac('sha256', 'whsec_test_123').update(payload).digest('hex');
    r = await call('POST', '/api/razorpay/webhook', payload, { 'x-razorpay-signature': sig, 'x-razorpay-event-id': 'evt_1' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    r = await call('POST', '/api/razorpay/webhook', payload, { 'x-razorpay-signature': sig, 'x-razorpay-event-id': 'evt_1' });
    assert.strictEqual(r.body.duplicate, true);
    r = await call('GET', '/api/me');
    assert.strictEqual(r.body.user.status.state, 'active');
    assert.strictEqual(r.body.user.status.plan, 'monthly');
    const days = r.body.user.status.ms_left / 864e5;
    assert.ok(days > 29.9 && days <= 30.01, `paid days ${days}`);
    assert.strictEqual((await call('GET', '/api/medicines')).status, 200);
    r = await call('GET', '/api/billing/history');
    assert.strictEqual(r.body.payments[0].status, 'paid');

    // contact form
    assert.strictEqual((await call('POST', '/api/contact', { name: 'A', contact: 'x', message: 'hi' })).status, 400);
    assert.strictEqual((await call('POST', '/api/contact', { name: 'Asha', contact: 'asha@example.com', message: 'Please call me' })).status, 201);
    // static pages served
    r = await call('GET', '/pricing');
    assert.ok(String(r.body).includes('Simple, honest pricing'));
  } finally {
    srv.close();
    await pool.end();
  }
});
