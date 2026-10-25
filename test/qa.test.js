// Regression tests for the Oct 25 QA pass (needs TEST_DATABASE_URL; skipped otherwise).
const test = require('node:test');
const assert = require('node:assert');

const DB = process.env.TEST_DATABASE_URL;
test('QA fixes: dates, duplicates, CSV, stock value, forgot/reset password, sessions', { skip: !DB && 'TEST_DATABASE_URL not set' }, async () => {
  process.env.DATABASE_URL = DB;
  process.env.ADMIN_KEY = 'admin-key-for-tests-123';
  const { app, pool, migrate } = require('../server');
  await migrate();
  await pool.query('TRUNCATE users, sessions, medicines, reminders, payments, webhook_events, contact_messages, password_resets RESTART IDENTITY CASCADE');
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const mk = () => {
    let cookie = '';
    return async (method, url, body, headers = {}) => {
      const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      const ct = r.headers.get('content-type') || '';
      return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text() };
    };
  };
  const a = mk(); const a2 = mk();
  try {
    let r = await a('POST', '/api/signup', { store_name: 'QA Medical', owner_name: 'Ravi', phone: '9123456780', email: 'qa@example.com', city: 'Gaya', password: 'secret123', accept_terms: true });
    assert.strictEqual(r.status, 201);
    for (const bad of ['2026-02-30', '2025-02-29', '0000-01-01', '1999-12-31', '2026-13-01', '31/12/2026']) {
      r = await a('POST', '/api/medicines', { name: 'Bad date', expiry: bad, qty: 1, price: 1 });
      assert.strictEqual(r.status, 400, bad + ' ' + JSON.stringify(r.body));
      r = await a('POST', '/api/reminders', { patient_name: 'Sita', phone: '9876500000', medicine: 'Amlo 5', every_days: 30, next_due: bad });
      assert.strictEqual(r.status, 400, 'reminder ' + bad);
    }
    r = await a('POST', '/api/medicines', { name: 'Leap', expiry: '2028-02-29', qty: 1, price: 1 });
    assert.strictEqual(r.status, 201);
    // duplicate name + batch
    r = await a('POST', '/api/medicines', { name: 'ORS', batch: 'B1', expiry: '2030-01-01', qty: 5, price: 20 });
    assert.strictEqual(r.status, 201);
    r = await a('POST', '/api/medicines', { name: 'ors', batch: 'b1', expiry: '2030-01-01', qty: 5, price: 20 });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'duplicate');
    r = await a('POST', '/api/medicines', { name: 'ors', batch: 'b1', expiry: '2030-01-01', qty: 5, price: 20, allow_duplicate: true });
    assert.strictEqual(r.status, 201);
    // expired stock is not counted in stock value
    await a('POST', '/api/medicines', { name: 'Old syrup', batch: 'X', expiry: '2020-01-01', qty: 2, price: 50 });
    r = await a('GET', '/api/alerts');
    assert.strictEqual(r.body.totals.expiredValue, 100);
    assert.strictEqual(r.body.totals.stockValue, 1 + 100 + 100);
    // CSV keeps negative numbers as numbers
    r = await a('GET', '/api/medicines.csv');
    assert.match(r.body, /Old syrup,X,2020-01-01,-\d+,2,50/);
    // login limit counts failures only; a good login is not blocked by earlier good logins
    for (let i = 0; i < 10; i++) assert.strictEqual((await a2('POST', '/api/login', { login: '9123456780', password: 'secret123' })).status, 200);
    // forgot -> admin link -> reset
    r = await a2('POST', '/api/password/forgot', { login: '9123456780' });
    assert.strictEqual(r.status, 200);
    r = await a2('POST', '/api/password/forgot', { login: '9000000000' });
    assert.strictEqual(r.status, 200, 'same answer for unknown accounts');
    assert.strictEqual((await a2('POST', '/api/admin/reset-link', { login: '9123456780' })).status, 403);
    r = await a2('POST', '/api/admin/reset-link', { login: 'QA@example.com' }, { 'x-admin-key': 'admin-key-for-tests-123' });
    assert.strictEqual(r.status, 200);
    const token = new URL(r.body.link).searchParams.get('token');
    assert.strictEqual((await a2('POST', '/api/password/reset', { token: 'nope', password: 'newpass123' })).status, 400);
    r = await a2('POST', '/api/password/reset', { token, password: 'newpass123' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await a('GET', '/api/me')).status, 401, 'old sessions are logged out after a reset');
    assert.strictEqual((await a2('GET', '/api/me')).status, 200);
    assert.strictEqual((await a2('POST', '/api/password/reset', { token, password: 'again12345' })).status, 400, 'link works once');
    assert.strictEqual((await a('POST', '/api/login', { login: '9123456780', password: 'newpass123' })).status, 200);
    // changing password logs out the other device
    r = await a('POST', '/api/me/password', { current: 'newpass123', next: 'third12345' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await a('GET', '/api/me')).status, 200);
    assert.strictEqual((await a2('GET', '/api/me')).status, 401);
  } finally {
    srv.close();
    await pool.end();
  }
});
