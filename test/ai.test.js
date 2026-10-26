// AI Assistant: public order link (random code), order number, CORS + bearer-token sessions for the own-domain copy. Needs TEST_DATABASE_URL.
const test = require('node:test');
const assert = require('node:assert');

const DB = process.env.TEST_DATABASE_URL;
test('ai: order link, public store, bearer token, CORS', { skip: !DB && 'TEST_DATABASE_URL not set' }, async () => {
  process.env.DATABASE_URL = DB;
  const { app, pool, migrate } = require('../server');
  await migrate();
  await pool.query('TRUNCATE users, sessions, medicines, reminders, payments, webhook_events, contact_messages, bills, bill_items, purchases, purchase_items, customers, khata_entries RESTART IDENTITY CASCADE');
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const r = await fetch(base + url, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: body === undefined ? undefined : JSON.stringify(body) });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : await r.text() };
  };
  try {
    const ORIGIN = 'https://dawalekh.publicvm.com';
    // preflight from the own domain
    let r = await call('OPTIONS', '/api/login', undefined, { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' });
    assert.strictEqual(r.status, 204);
    assert.strictEqual(r.headers.get('access-control-allow-origin'), ORIGIN);
    // unknown origin gets no CORS header
    r = await call('GET', '/api/health', undefined, { Origin: 'https://evil.example' });
    assert.strictEqual(r.headers.get('access-control-allow-origin'), null);

    // signup with token auth -> token in body, works as Bearer without cookies
    r = await call('POST', '/api/signup', { store_name: 'Gupta Medical', owner_name: 'Ravi', phone: '9876500011', city: 'Patna', password: 'secret123', accept_terms: true }, { Origin: ORIGIN, 'X-Token-Auth': '1' });
    assert.strictEqual(r.status, 201);
    assert.ok(r.body.token && r.body.token.length > 20, 'token returned');
    const auth = { Authorization: 'Bearer ' + r.body.token, Origin: ORIGIN };
    // normal signup (no header) gets no token
    const r2 = await call('POST', '/api/signup', { store_name: 'B Med', owner_name: 'Asha', phone: '9876500012', city: 'Gaya', password: 'secret123', accept_terms: true });
    assert.strictEqual(r2.body.token, undefined);

    r = await call('GET', '/api/me', undefined, auth);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.user.store_name, 'Gupta Medical');

    // order link: random code, stable
    r = await call('GET', '/api/ai/order-link', undefined, auth);
    assert.strictEqual(r.status, 200);
    const code = r.body.code;
    assert.match(code, /^[a-z0-9]{8}$/);
    assert.strictEqual((await call('GET', '/api/ai/order-link', undefined, auth)).body.code, code);

    // public store info by code (no login)
    r = await call('GET', '/api/public/store/' + code);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(Object.keys(r.body).sort(), ['city', 'store_address', 'store_name', 'wa']);
    assert.strictEqual(r.body.wa, '919876500011');
    assert.strictEqual((await call('GET', '/api/public/store/1')).status, 404);
    assert.strictEqual((await call('GET', '/api/public/store/zzzzzzzz')).status, 404);

    // separate order number
    assert.strictEqual((await call('PUT', '/api/ai/order-link', { order_phone: '12345' }, auth)).status, 400);
    r = await call('PUT', '/api/ai/order-link', { order_phone: '+91 98765 43210' }, auth);
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await call('GET', '/api/public/store/' + code)).body.wa, '919876543210');
    await call('PUT', '/api/ai/order-link', { order_phone: '' }, auth);
    assert.strictEqual((await call('GET', '/api/public/store/' + code)).body.wa, '919876500011');

    // read-only store: order number can't change, link still works
    await pool.query("UPDATE users SET trial_ends_at = now() - interval '1 hour' WHERE phone='9876500011'");
    assert.strictEqual((await call('PUT', '/api/ai/order-link', { order_phone: '9876543210' }, auth)).status, 402);
    assert.strictEqual((await call('GET', '/api/public/store/' + code)).status, 200);

    // logout with bearer kills the session
    assert.strictEqual((await call('POST', '/api/logout', {}, auth)).status, 200);
    assert.strictEqual((await call('GET', '/api/me', undefined, auth)).status, 401);
  } finally {
    srv.close();
    await pool.query('TRUNCATE users, sessions RESTART IDENTITY CASCADE');
  }
});
