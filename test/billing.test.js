// Billing integration test: needs a Postgres in TEST_DATABASE_URL (skipped otherwise).
const test = require('node:test');
const assert = require('node:assert');

const DB = process.env.TEST_DATABASE_URL;
test('Bills: create, stock reduces, oversell blocked, expired blocked, list, cancel restores', { skip: !DB && 'TEST_DATABASE_URL not set' }, async () => {
  process.env.DATABASE_URL = DB;
  const { app, pool, migrate } = require('../server');
  await migrate();
  await pool.query('TRUNCATE users, sessions, medicines, reminders, payments, webhook_events, contact_messages, bills RESTART IDENTITY CASCADE');
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  let cookie = '';
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const day = (n) => new Date(Date.now() + n * 864e5 + 5.5 * 3600e3).toISOString().slice(0, 10);
  try {
    let r = await call('POST', '/api/signup', { store_name: 'Bill Medical', owner_name: 'Ravi', phone: '9876500000', city: 'Gaya', password: 'secret123', accept_terms: true });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    r = await call('PUT', '/api/me', { store_name: 'Bill Medical', owner_name: 'Ravi', city: 'Gaya', store_address: 'Main Road', gstin: 'bad', drug_licence: 'DL-1' });
    assert.strictEqual(r.status, 400);
    r = await call('PUT', '/api/me', { store_name: 'Bill Medical', owner_name: 'Ravi', city: 'Gaya', store_address: 'Main Road', gstin: '10abcde1234f1z5', drug_licence: 'DL-1' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.user.gstin, '10ABCDE1234F1Z5');
    assert.strictEqual(r.body.user.store_address, 'Main Road');
    r = await call('PUT', '/api/me', { store_name: 'Bill Medical', owner_name: 'Ravi', city: 'Gaya' });
    assert.strictEqual(r.body.user.drug_licence, 'DL-1', 'fields left out keep their value');

    const a = (await call('POST', '/api/medicines', { name: 'Dolo 650', batch: 'D1', expiry: day(100), qty: 10, price: 3.2, min_qty: 2 })).body.medicine;
    const b = (await call('POST', '/api/medicines', { name: 'Pan 40', batch: 'P1', expiry: day(50), qty: 5, price: 8, min_qty: 2 })).body.medicine;
    const old = (await call('POST', '/api/medicines', { name: 'Old Syrup', batch: 'O1', expiry: day(-2), qty: 3, price: 50, min_qty: 1 })).body.medicine;

    r = await call('POST', '/api/bills', { items: [] });
    assert.strictEqual(r.status, 400);
    r = await call('POST', '/api/bills', { items: [{ medicine_id: b.id, qty: 6, price: 8 }] });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.available, 5);
    r = await call('POST', '/api/bills', { items: [{ medicine_id: b.id, qty: 3, price: 8 }, { medicine_id: b.id, qty: 3, price: 8 }] });
    assert.strictEqual(r.status, 409, 'same medicine twice is summed');
    r = await call('POST', '/api/bills', { items: [{ medicine_id: old.id, qty: 1, price: 50 }] });
    assert.strictEqual(r.status, 400, 'expired cannot be billed');
    r = await call('POST', '/api/bills', { customer_phone: '12345', items: [{ medicine_id: a.id, qty: 1, price: 3.2 }] });
    assert.strictEqual(r.status, 400);

    r = await call('POST', '/api/bills', { customer_name: 'Ramesh', customer_phone: '+91 98765 43210', items: [{ medicine_id: a.id, qty: 4, price: 3.2 }, { medicine_id: b.id, qty: 2, price: 9 }], discount_type: 'percent', discount_value: 10, gst_mode: 'incl', gst_percent: 12 });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const bill1 = r.body.bill;
    assert.strictEqual(bill1.bill_no, 1);
    assert.strictEqual(bill1.customer_phone, '9876543210');
    assert.strictEqual(bill1.subtotal, 30.8);
    assert.strictEqual(bill1.discount_amount, 3.08);
    assert.strictEqual(bill1.total, 27.72);
    assert.strictEqual(bill1.gst_amount, 2.97);
    assert.strictEqual(bill1.items.length, 2);
    assert.strictEqual(bill1.items[0].batch, 'D1');

    let meds = (await call('GET', '/api/medicines')).body.medicines;
    assert.strictEqual(meds.find((m) => m.id === a.id).qty, 6);
    assert.strictEqual(meds.find((m) => m.id === b.id).qty, 3);

    r = await call('POST', '/api/bills', { items: [{ medicine_id: a.id, qty: 1, price: 100 }], discount_type: 'amount', discount_value: 10, gst_mode: 'excl', gst_percent: 5 });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.bill.bill_no, 2);
    assert.strictEqual(r.body.bill.total, 94.5);
    r = await call('POST', '/api/bills', { items: [{ medicine_id: a.id, qty: 1, price: 5 }], discount_type: 'amount', discount_value: 10 });
    assert.strictEqual(r.status, 400, 'discount above amount');

    r = await call('GET', '/api/bills');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.bills.length, 2);
    assert.strictEqual(r.body.summary.total, 122.22);
    assert.strictEqual(r.body.today.count, 2);
    r = await call('GET', `/api/bills?from=${day(-10)}&to=${day(-5)}`);
    assert.strictEqual(r.body.bills.length, 0);
    r = await call('GET', `/api/bills/${bill1.id}`);
    assert.strictEqual(r.body.bill.items.length, 2);

    r = await call('DELETE', `/api/bills/${bill1.id}`);
    assert.strictEqual(r.status, 200);
    meds = (await call('GET', '/api/medicines')).body.medicines;
    assert.strictEqual(meds.find((m) => m.id === a.id).qty, 9);
    assert.strictEqual(meds.find((m) => m.id === b.id).qty, 5);
    assert.strictEqual((await call('GET', `/api/bills/${bill1.id}`)).status, 404);

    // Another store cannot see these bills.
    cookie = '';
    await call('POST', '/api/signup', { store_name: 'Other Medical', owner_name: 'Sita', phone: '9876511111', city: 'Patna', password: 'secret123', accept_terms: true });
    assert.strictEqual((await call('GET', '/api/bills')).body.bills.length, 0);
    assert.strictEqual((await call('DELETE', `/api/bills/${r.body.bill ? 0 : 2}`)).status, 404);
  } finally {
    srv.close();
    await pool.end();
  }
});
