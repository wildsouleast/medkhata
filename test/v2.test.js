// v2/v3 integration test: Basic plan limits, read-only after trial, purchase entry -> stock, udhaar khata. Needs TEST_DATABASE_URL.
const test = require('node:test');
const assert = require('node:assert');

const DB = process.env.TEST_DATABASE_URL;
test('v2/v3: purchase entry, udhaar khata, Basic limits, read-only, trial migration', { skip: !DB && 'TEST_DATABASE_URL not set' }, async () => {
  process.env.DATABASE_URL = DB;
  const { app, pool, migrate } = require('../server');
  await migrate();
  await pool.query('TRUNCATE users, sessions, medicines, reminders, payments, webhook_events, contact_messages, bills, bill_items, purchases, purchase_items, customers, khata_entries, app_migrations RESTART IDENTITY CASCADE');
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  let cookie = '';
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text() };
  };
  const day = (n) => new Date(Date.now() + 5.5 * 3600e3 + n * 864e5).toISOString().slice(0, 10);
  try {
    // v3 one-time migration: a never-paid account gets a fresh 7-day trial from now; a paid one is untouched; runs once
    await pool.query("INSERT INTO users(store_name, owner_name, phone, city, password_hash, trial_ends_at, created_at) VALUES ('Old','A','9000000001','Patna','x', now() + interval '10 days', now() - interval '3 days')");
    await pool.query("INSERT INTO users(store_name, owner_name, phone, city, password_hash, trial_ends_at, paid_until, plan, created_at) VALUES ('Paid','B','9000000002','Patna','x', now() - interval '1 day', now() + interval '5 days', 'pro', now() - interval '3 days')");
    await migrate();
    const left = (await pool.query("SELECT extract(epoch FROM trial_ends_at - now())/86400 AS d FROM users WHERE phone='9000000001'")).rows[0].d;
    assert.ok(Number(left) > 6.99 && Number(left) <= 7, `trial left ${left}`);
    const paid = (await pool.query("SELECT trial_ends_at < now() AS past FROM users WHERE phone='9000000002'")).rows[0].past;
    assert.strictEqual(paid, true);
    await pool.query("UPDATE users SET trial_ends_at = now() - interval '1 hour' WHERE phone='9000000001'");
    await migrate();
    assert.strictEqual((await pool.query("SELECT trial_ends_at < now() AS past FROM users WHERE phone='9000000001'")).rows[0].past, true, 'migration runs only once');

    let r = await call('POST', '/api/signup', { store_name: 'Shiv Medical', owner_name: 'Ravi', phone: '9876500001', city: 'Patna', password: 'secret123', accept_terms: true });
    assert.strictEqual(r.status, 201);

    // existing stock line, then a purchase that adds to it and creates a new one
    r = await call('POST', '/api/medicines', { name: 'Dolo 650', batch: 'D1', expiry: day(300), qty: 5, price: 30 });
    assert.strictEqual(r.status, 201);
    const doloId = r.body.medicine.id;
    r = await call('POST', '/api/purchases', { supplier: 'Maa Tara Pharma', invoice_no: 'MT-101', purchase_date: day(0), items: [
      { name: 'dolo 650', batch: 'd1', expiry: day(320), qty: 10, rate: 22.5, mrp: 32 },
      { name: 'Pan 40', batch: 'P9', expiry: day(400), qty: 20, rate: 8, mrp: 12.5 },
    ] });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const pid = r.body.purchase.id;
    assert.strictEqual(r.body.purchase.total, 385);
    let meds = (await call('GET', '/api/medicines')).body.medicines;
    let dolo = meds.find((m) => m.id === doloId);
    assert.strictEqual(dolo.qty, 15);
    assert.strictEqual(dolo.price, 32);
    let pan = meds.find((m) => m.name === 'Pan 40');
    assert.strictEqual(pan.qty, 20);
    assert.strictEqual(meds.length, 2);

    // bad input
    assert.strictEqual((await call('POST', '/api/purchases', { supplier: 'X', purchase_date: day(0), items: [] })).status, 400);
    assert.strictEqual((await call('POST', '/api/purchases', { supplier: 'Abc', purchase_date: day(0), items: [{ name: 'Y1', expiry: '2026-02-30', qty: 1, rate: 1, mrp: 1 }] })).status, 400);

    // second purchase, other supplier; supplier-wise totals
    r = await call('POST', '/api/purchases', { supplier: 'Bihar Drug House', purchase_date: day(-1), items: [{ name: 'Azee 500', batch: 'A1', expiry: day(200), qty: 6, rate: 60, mrp: 80 }] });
    assert.strictEqual(r.status, 201);
    const pid2 = r.body.purchase.id;
    r = await call('GET', '/api/purchases');
    assert.strictEqual(r.body.purchases.length, 2);
    assert.strictEqual(r.body.suppliers[0].supplier, 'Maa Tara Pharma');
    assert.strictEqual(r.body.suppliers[0].total, 385);
    assert.strictEqual(r.body.suppliers[1].total, 360);
    assert.strictEqual((await call('GET', '/api/purchases?supplier=bihar%20drug%20house')).body.purchases.length, 1);

    // edit: Pan qty 20 -> 12 (stock follows), dolo line unchanged
    r = await call('GET', `/api/purchases/${pid}`);
    const items = r.body.purchase.items.map((i) => ({ ...i }));
    items[1].qty = 12;
    r = await call('PUT', `/api/purchases/${pid}`, { supplier: 'Maa Tara Pharma', invoice_no: 'MT-101', purchase_date: day(0), items });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    meds = (await call('GET', '/api/medicines')).body.medicines;
    assert.strictEqual(meds.find((m) => m.name === 'Pan 40').qty, 12);
    assert.strictEqual(meds.find((m) => m.id === doloId).qty, 15);

    // bill 3 Pan on udhaar to a customer
    pan = meds.find((m) => m.name === 'Pan 40');
    r = await call('POST', '/api/bills', { customer_name: 'Ramesh', customer_phone: '9811122233', udhaar: true, items: [{ medicine_id: pan.id, qty: 3, price: 12.5 }] });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const billId = r.body.bill.id;
    assert.strictEqual((await call('POST', '/api/bills', { udhaar: true, items: [{ medicine_id: pan.id, qty: 1, price: 12.5 }] })).status, 400);
    r = await call('GET', '/api/khata');
    assert.strictEqual(r.body.customers.length, 1);
    assert.strictEqual(r.body.total_due, 37.5);
    const cid = r.body.customers[0].id;
    assert.strictEqual((await call('GET', `/api/bills/${billId}/udhaar`)).body.udhaar.customer_id, cid);
    // same bill cannot be added twice
    assert.strictEqual((await call('POST', '/api/khata/entries', { kind: 'udhaar', customer_id: cid, amount: 37.5, bill_id: billId })).status, 409);
    // manual udhaar (same phone -> same customer), then payment
    r = await call('POST', '/api/khata/entries', { kind: 'udhaar', customer_name: 'Ramesh ji', customer_phone: '+91 98111 22233', amount: 100, note: 'Manual' });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.customer_id, cid);
    r = await call('POST', '/api/khata/entries', { kind: 'payment', customer_id: cid, amount: 50 });
    assert.strictEqual(r.status, 201);
    assert.strictEqual((await call('POST', '/api/khata/entries', { kind: 'payment', customer_id: cid, amount: 0 })).status, 400);
    r = await call('GET', `/api/khata/customers/${cid}`);
    assert.strictEqual(r.body.customer.balance, 87.5);
    assert.strictEqual(r.body.entries[0].balance, 87.5);
    assert.strictEqual(r.body.entries.length, 3);
    // second customer without phone
    r = await call('POST', '/api/khata/entries', { kind: 'udhaar', customer_name: 'Sita Devi', amount: 20 });
    assert.strictEqual(r.status, 201);
    r = await call('GET', '/api/khata');
    assert.strictEqual(r.body.total_due, 107.5);
    assert.strictEqual(r.body.owing_count, 2);
    assert.strictEqual(r.body.customers[0].name, 'Ramesh');
    // cancelling the bill removes its udhaar line
    assert.strictEqual((await call('DELETE', `/api/bills/${billId}`)).status, 200);
    assert.strictEqual((await call('GET', `/api/khata/customers/${cid}`)).body.customer.balance, 50);

    // delete purchase 2 after selling 4 Azee: stock goes to 0 (not negative), short reported
    meds = (await call('GET', '/api/medicines')).body.medicines;
    const azee = meds.find((m) => m.name === 'Azee 500');
    assert.strictEqual((await call('POST', '/api/bills', { items: [{ medicine_id: azee.id, qty: 4, price: 80 }] })).status, 201);
    r = await call('DELETE', `/api/purchases/${pid2}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.short[0].sold, 4);
    meds = (await call('GET', '/api/medicines')).body.medicines;
    assert.strictEqual(meds.find((m) => m.name === 'Azee 500').qty, 0);

    // another store cannot see these
    const mine = cookie;
    cookie = '';
    await call('POST', '/api/signup', { store_name: 'Other', owner_name: 'Om', phone: '9876500002', city: 'Patna', password: 'secret123', accept_terms: true });
    assert.strictEqual((await call('GET', `/api/purchases/${pid}`)).status, 404);
    assert.strictEqual((await call('GET', `/api/khata/customers/${cid}`)).status, 404);
    assert.strictEqual((await call('GET', '/api/khata')).body.customers.length, 0);
    cookie = mine;

    // Basic plan (₹49): 100 medicines, 50 bills / month, no purchase entry / new udhaar (payments on old udhaar allowed)
    await pool.query("UPDATE users SET trial_ends_at = now() - interval '1 minute', plan='basic_monthly', paid_until = now() + interval '30 days' WHERE phone='9876500001'");
    r = await call('GET', '/api/me');
    assert.strictEqual(r.body.user.status.state, 'active');
    assert.strictEqual(r.body.user.status.tier, 'basic');
    assert.strictEqual(r.body.usage.bills_this_month, 1);
    const uid = r.body.user.id;
    await pool.query("INSERT INTO medicines(user_id, name, expiry, qty, price) SELECT $1, 'Filler ' || g, now() + interval '200 days', 1, 1 FROM generate_series(1, 96) g", [uid]);
    assert.strictEqual((await call('POST', '/api/medicines', { name: 'Med 100', expiry: day(100), qty: 1, price: 1 })).status, 201);
    r = await call('POST', '/api/medicines', { name: 'Med 101', expiry: day(100), qty: 1, price: 1 });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.error, 'limit');
    r = await call('POST', '/api/purchases', { supplier: 'Maa Tara Pharma', purchase_date: day(0), items: [{ name: 'Pan 40', batch: 'P9', expiry: day(400), qty: 5, rate: 8, mrp: 12.5 }] });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.error, 'pro_required');
    assert.strictEqual((await call('GET', '/api/purchases')).status, 200);
    r = await call('POST', '/api/khata/entries', { customer_id: cid, kind: 'udhaar', amount: 10 });
    assert.strictEqual(r.body.error, 'pro_required');
    r = await call('POST', '/api/khata/entries', { customer_id: cid, kind: 'payment', amount: 1 });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    meds = (await call('GET', '/api/medicines')).body.medicines;
    pan = meds.find((m) => m.name === 'Pan 40');
    r = await call('POST', '/api/bills', { items: [{ medicine_id: pan.id, qty: 1, price: 12.5 }], udhaar: true, customer_name: 'Sita' });
    assert.strictEqual(r.body.error, 'pro_required');
    assert.strictEqual((await call('GET', '/api/medicines.csv')).status, 403);
    // 50 bills a month
    await pool.query("INSERT INTO bills(user_id, bill_no, total) SELECT $1, 1000 + g, 10 FROM generate_series(1, 49) g", [uid]);
    r = await call('POST', '/api/bills', { items: [{ medicine_id: pan.id, qty: 1, price: 12.5 }] });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.error, 'limit');
    // bills from last month do not count
    await pool.query("UPDATE bills SET created_at = now() - interval '40 days' WHERE user_id=$1 AND bill_no > 1000", [uid]);
    r = await call('POST', '/api/bills', { items: [{ medicine_id: pan.id, qty: 1, price: 12.5 }] });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));

    // plan over, not renewed -> READ-ONLY: everything visible, nothing new, nothing deleted
    await pool.query("UPDATE users SET paid_until = now() - interval '1 minute' WHERE id=$1", [uid]);
    r = await call('GET', '/api/me');
    assert.strictEqual(r.body.user.status.state, 'expired');
    const nBills = (await call('GET', '/api/bills')).body.bills.length;
    assert.ok(nBills > 0);
    assert.strictEqual((await call('GET', '/api/khata')).status, 200);
    assert.strictEqual((await call('GET', '/api/purchases')).status, 200);
    assert.strictEqual((await call('GET', '/api/medicines.csv')).status, 200);
    assert.strictEqual((await call('POST', '/api/bills', { items: [{ medicine_id: pan.id, qty: 1, price: 12.5 }] })).status, 402);
    assert.strictEqual((await call('POST', '/api/purchases', { supplier: 'X', purchase_date: day(0), items: [{ name: 'Y', expiry: day(400), qty: 1, rate: 1, mrp: 1 }] })).status, 402);
    assert.strictEqual((await call('DELETE', `/api/medicines/${pan.id}`)).status, 402);
    assert.strictEqual((await call('GET', '/api/bills')).body.bills.length, nBills);
  } finally {
    srv.close();
    await pool.end();
  }
});
