// Dawalekh app: dashboard, stock, refill reminders and billing.
(function () {
  'use strict';
  var state = { user: null, limits: null, config: null, meds: [], reminders: [], filter: 'all', tab: 'home', timer: null };
  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function rupees(n) { var v = Number(n || 0); return '₹' + v.toLocaleString('en-IN', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 }); }
  function fmtDate(s) {
    if (!s) return '';
    var d = new Date(String(s).length === 10 ? s + 'T00:00:00' : s);
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function todayISO(offsetDays) {
    var d = new Date(Date.now() + (offsetDays || 0) * 86400000);
    var ist = new Date(d.getTime() + (330 + d.getTimezoneOffset()) * 60000);
    return ist.getFullYear() + '-' + String(ist.getMonth() + 1).padStart(2, '0') + '-' + String(ist.getDate()).padStart(2, '0');
  }
  function toast(msg) {
    var t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 2800);
  }

  function waitForServer() {
    var started = Date.now();
    function ping() {
      return fetch('/api/health', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('x'); }).catch(function () {
        if (Date.now() - started > 120000) return;
        return new Promise(function (res) { setTimeout(res, 3000); }).then(ping);
      });
    }
    return ping();
  }
  function api(method, url, body) {
    return fetch(url, { method: method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (r.status === 401) { location.replace('/login'); throw new Error('login'); }
          if (r.status === 402) { state.user && (state.user.status.state = 'expired'); renderStatus(); lockApp(); }
          if (!r.ok) { var e = new Error((j && j.message) || (r.status === 403 ? 'This text was blocked by our security filter. Please remove special symbols and try again.' : 'Something went wrong. Please try again.')); e.status = r.status; e.j = j; throw e; }
          return j;
        });
      });
  }

  function expiryBadge(days) {
    if (days < 0) return '<span class="badge b-red">Expired ' + Math.abs(days) + (Math.abs(days) === 1 ? ' day' : ' days') + ' ago</span>';
    if (days === 0) return '<span class="badge b-red">Expires today</span>';
    var label = 'Expires in ' + days + (days === 1 ? ' day' : ' days');
    if (days <= 30) return '<span class="badge b-red">' + label + '</span>';
    if (days <= 60) return '<span class="badge b-amber">' + label + '</span>';
    if (days <= 90) return '<span class="badge b-yellow">' + label + '</span>';
    return '<span class="badge b-green">OK · ' + fmtDate(todayISO(days)) + '</span>';
  }

  // ---------- status banner ----------
  function remaining(ms) {
    var h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
    if (h >= 48) { var d = Math.floor(h / 24); return d + ' days ' + (h % 24) + ' hrs'; }
    if (h >= 24) return '1 day ' + (h - 24) + ' hrs ' + m + ' min';
    return h + ' hrs ' + m + ' min';
  }
  function renderEmailNote() {
    var el = $('email-note'), u = state.user;
    if (!el || !u || !u.email || u.email_verified || !(state.config && state.config.email_enabled)) { if (el) el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = '<span>📧 Please confirm your email <strong>' + esc(u.email) + '</strong>. We sent you a link.</span><button class="btn btn-ghost btn-sm" type="button" id="resend-verify">Send again</button>';
    $('resend-verify').addEventListener('click', function () {
      var b = this; b.disabled = true;
      api('POST', '/api/email/resend').then(function (r) { toast(r.message || 'Email sent'); }).catch(function (x) { toast(x.message); b.disabled = false; });
    });
  }
  function renderStatus() {
    var el = $('status'); var s = state.user && state.user.status; if (!s) return;
    el.hidden = false;
    var end = s.state === 'trial' ? new Date(s.trial_ends_at) : s.state === 'active' ? new Date(s.paid_until) : null;
    var left = end ? end.getTime() - Date.now() : 0;
    if (s.state === 'trial' && left > 0) {
      el.className = 'status trial';
      el.innerHTML = '<span>⏳ Free trial: <strong>' + remaining(left) + '</strong> left</span><button class="btn btn-primary btn-sm" type="button" data-go="plan">Choose a plan</button>';
    } else if (s.state === 'active' && left > 0) {
      var days = Math.ceil(left / 86400000);
      el.className = 'status active';
      el.innerHTML = '<span>✅ ' + esc(s.plan_name) + ' plan active · ' + (days <= 5 ? '<strong>' + days + (days === 1 ? ' day' : ' days') + ' left</strong>' : 'till ' + fmtDate(s.paid_until)) + '</span>' + (days <= 5 ? '<button class="btn btn-primary btn-sm" type="button" data-go="plan">Renew</button>' : '');
    } else {
      el.className = 'status expired';
      el.innerHTML = '<span>' + (s.plan === 'trial' || !s.paid_until ? 'Your free trial has ended.' : 'Your plan has ended.') + ' Your data is safe. Choose a plan to continue.</span><button class="btn btn-primary btn-sm" type="button" data-go="plan">Choose a plan</button>';
      if (s.state !== 'expired') { s.state = 'expired'; lockApp(); }
    }
  }
  function lockApp() {
    document.querySelectorAll('.tabs button').forEach(function (b) { if (b.dataset.tab !== 'plan') b.disabled = true; });
    if (state.tab !== 'plan') showTab('plan');
  }

  // ---------- tabs ----------
  function showTab(name) {
    state.tab = name;
    var navName = (name === 'newbill' || name === 'billview') ? 'bills' : name;
    document.querySelectorAll('.tabs button').forEach(function (b) { b.setAttribute('aria-selected', b.dataset.tab === navName ? 'true' : 'false'); });
    ['home', 'bills', 'newbill', 'billview', 'stock', 'refills', 'plan'].forEach(function (t) { $('tab-' + t).hidden = t !== name; });
    if (name === 'home') loadHome();
    if (name === 'stock') loadMeds();
    if (name === 'bills') loadBills();
    if (name === 'newbill') startBill();
    if (name === 'refills') loadReminders();
    if (name === 'plan') loadPlan();
    window.scrollTo(0, 0);
  }

  // ---------- home ----------
  function medRow(m, extra) {
    return '<div class="item"><div class="main"><b>' + esc(m.name) + '</b><small>' + (m.batch ? 'Batch ' + esc(m.batch) + ' · ' : '') + 'Qty ' + m.qty + ' · Exp ' + fmtDate(m.expiry) + '</small></div><div class="side">' + (extra || expiryBadge(m.days_left)) + '<button class="btn btn-ghost btn-sm" type="button" data-edit-med="' + m.id + '">Edit</button></div></div>';
  }
  function group(title, badgeCls, list, emptyText, extraFn) {
    var html = '<div class="group"><h3><span class="badge ' + badgeCls + '">' + list.length + '</span> ' + title + '</h3>';
    if (!list.length) return html + '<div class="empty">' + emptyText + '</div></div>';
    return html + '<div class="list">' + list.map(function (m) { return medRow(m, extraFn && extraFn(m)); }).join('') + '</div></div>';
  }
  function loadHome() {
    return api('GET', '/api/alerts').then(function (a) {
      state.alertsMeds = [].concat(a.expired, a.within30, a.within60, a.within90, a.lowStock);
      var t = a.totals;
      $('stats').innerHTML =
        '<div class="stat"><small>Medicines</small><strong>' + t.medicines + '</strong></div>' +
        '<div class="stat"><small>Stock value</small><strong>' + rupees(t.stockValue) + '</strong>' + (t.expiredValue ? '<small class="stat-note">+ ' + rupees(t.expiredValue) + ' expired</small>' : '') + '</div>' +
        '<div class="stat red"><small>Expired / ≤30 days</small><strong>' + (a.expired.length + a.within30.length) + '</strong></div>' +
        '<div class="stat amber"><small>Low stock</small><strong>' + a.lowStock.length + '</strong></div>' +
        '<div class="stat green"><small>Refills due</small><strong>' + t.remindersDue + '</strong></div>';
      if (!t.medicines) {
        $('alerts').innerHTML = '<div class="empty"><p><strong>Welcome to Dawalekh!</strong></p><p>Add your first medicine to start getting expiry and low-stock alerts.</p><button class="btn btn-primary" type="button" data-add-med>+ Add your first medicine</button></div>';
        return;
      }
      $('alerts').innerHTML =
        (a.expired.length ? group('Already expired' + (t.expiredValue ? ' · ' + rupees(t.expiredValue) + ' of stock' : ''), 'b-red', a.expired, '') : '') +
        group('Expiring within 30 days', 'b-red', a.within30, 'Nothing expiring in the next 30 days. 👍') +
        group('Expiring in 31–60 days', 'b-amber', a.within60, 'Nothing in this range.') +
        group('Expiring in 61–90 days', 'b-yellow', a.within90, 'Nothing in this range.') +
        group('Low stock', 'b-amber', a.lowStock, 'All medicines are above their low-stock level.', function (m) { return m.qty === 0 ? '<span class="badge b-red">Out of stock</span>' : '<span class="badge b-amber">Only ' + m.qty + ' left</span>'; }) +
        (t.remindersDue ? '<div class="group"><h3><span class="badge b-green">' + t.remindersDue + '</span> Refills due today</h3><button class="btn btn-wa btn-sm" type="button" data-go="refills">Open refill reminders</button></div>' : '');
    }).catch(showError);
  }

  // ---------- stock ----------
  function loadMeds() {
    return api('GET', '/api/medicines').then(function (r) { state.meds = r.medicines; renderMeds(); }).catch(showError);
  }
  function renderMeds() {
    var q = ($('search').value || '').trim().toLowerCase();
    var list = state.meds.filter(function (m) {
      if (state.filter === 'expired' && m.days_left >= 0) return false;
      if (state.filter === 'expiring' && (m.days_left < 0 || m.days_left > 90)) return false;
      if (state.filter === 'low' && m.qty > m.min_qty) return false;
      if (!q) return true;
      return (m.name + ' ' + m.batch + ' ' + m.supplier).toLowerCase().indexOf(q) !== -1;
    });
    if (!state.meds.length) { $('med-list').innerHTML = '<div class="empty">No medicines yet. Tap “+ Add medicine” to add your first one.</div>'; return; }
    if (!list.length) { $('med-list').innerHTML = '<div class="empty">No medicines match.</div>'; return; }
    $('med-list').innerHTML = list.map(function (m) {
      var low = m.qty === 0 ? ' <span class="badge b-red">Out of stock</span>' : m.qty <= m.min_qty ? ' <span class="badge b-amber">Low stock</span>' : '';
      return '<div class="item"><div class="main"><b>' + esc(m.name) + '</b><small>' + (m.batch ? 'Batch ' + esc(m.batch) + ' · ' : '') + 'Exp ' + fmtDate(m.expiry) + '</small><small>Qty <strong>' + m.qty + '</strong> · ' + rupees(m.price) + ' each' + (m.supplier ? ' · ' + esc(m.supplier) : '') + '</small></div><div class="side">' + expiryBadge(m.days_left) + low + '<button class="btn btn-ghost btn-sm" type="button" data-edit-med="' + m.id + '">Edit</button></div></div>';
    }).join('');
  }

  var editingMed = null;
  function openMed(m) {
    editingMed = m || null;
    var f = $('med-form'); f.reset(); $('m-err').hidden = true;
    $('med-title').textContent = m ? 'Edit medicine' : 'Add medicine';
    $('m-del').hidden = !m;
    if (m) { f.name.value = m.name; f.batch.value = m.batch; f.expiry.value = m.expiry; f.qty.value = m.qty; f.price.value = m.price; f.min_qty.value = m.min_qty; f.supplier.value = m.supplier; }
    else { f.min_qty.value = 10; }
    $('med-dlg').showModal();
    setTimeout(function () { f.name.focus(); }, 50);
  }
  function findMed(id) {
    id = Number(id);
    return state.meds.concat(state.alertsMeds || []).filter(function (m) { return m.id === id; })[0];
  }
  function refreshCurrent() { if (state.tab === 'home') loadHome(); else if (state.tab === 'stock') loadMeds(); }

  $('med-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target, err = $('m-err'), btn = f.querySelector('button[type=submit]');
    var data = { name: f.name.value, batch: f.batch.value, expiry: f.expiry.value, qty: f.qty.value === '' ? NaN : Number(f.qty.value), price: f.price.value === '' ? NaN : Number(f.price.value), min_qty: f.min_qty.value === '' ? 10 : Number(f.min_qty.value), supplier: f.supplier.value };
    if (!data.name.trim()) { err.textContent = 'Please enter the medicine name.'; err.hidden = false; return; }
    if (!data.expiry) { err.textContent = 'Please choose the expiry date.'; err.hidden = false; return; }
    if (!Number.isFinite(data.qty)) { err.textContent = 'Please enter the quantity.'; err.hidden = false; return; }
    if (!Number.isFinite(data.price)) { err.textContent = 'Please enter the price.'; err.hidden = false; return; }
    btn.disabled = true; err.hidden = true;
    function save(d) { return editingMed ? api('PUT', '/api/medicines/' + editingMed.id, d) : api('POST', '/api/medicines', d); }
    save(data)
      .catch(function (x) {
        if (x.status === 409 && x.j && x.j.error === 'duplicate' && confirm(x.message + '\n\nAdd it as a separate entry anyway?')) { data.allow_duplicate = true; return save(data); }
        throw x;
      })
      .then(function () { $('med-dlg').close(); toast(editingMed ? 'Medicine updated' : 'Medicine added'); refreshCurrent(); })
      .catch(function (x) { err.textContent = x.message; err.hidden = false; })
      .finally(function () { btn.disabled = false; });
  });
  $('m-del').addEventListener('click', function () {
    if (!editingMed || !confirm('Delete ' + editingMed.name + '? This cannot be undone.')) return;
    api('DELETE', '/api/medicines/' + editingMed.id).then(function () { $('med-dlg').close(); toast('Medicine deleted'); refreshCurrent(); }).catch(function (x) { $('m-err').textContent = x.message; $('m-err').hidden = false; });
  });

  // ---------- customer bills ----------
  var bill = { lines: [] }, billRange = { from: todayISO(0), to: todayISO(0) }, currentBill = null;
  function r2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
  function money(n) { return '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function fmtDateTime(s) { return new Date(s).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }); }

  function loadBills() {
    $('bf-from').value = billRange.from; $('bf-to').value = billRange.to;
    return api('GET', '/api/bills?from=' + billRange.from + '&to=' + billRange.to).then(function (r) {
      var single = r.from === r.to;
      var label = single ? (r.from === todayISO(0) ? 'Today’s sales / आज की बिक्री' : 'Sales on ' + fmtDate(r.from)) : 'Sales ' + fmtDate(r.from) + ' – ' + fmtDate(r.to);
      $('sales-card').innerHTML = '<div><small>' + label + '</small><strong>' + money(r.summary.total) + '</strong><small>' + r.summary.count + (r.summary.count === 1 ? ' bill' : ' bills') + '</small></div>' +
        (single && r.from === todayISO(0) ? '' : '<div><small>Today / आज</small><strong style="font-size:1.1rem">' + money(r.today.total) + '</strong><small>' + r.today.count + ' bills</small></div>');
      if (!r.bills.length) { $('bill-list').innerHTML = '<div class="empty">No bills for these dates. Tap “+ New bill” to make one.</div>'; return; }
      $('bill-list').innerHTML = r.bills.map(function (b) {
        return '<button type="button" class="item bill-item" data-bill="' + b.id + '" style="text-align:left;font:inherit;cursor:pointer;width:100%"><div class="main"><b>Bill #' + b.bill_no + (b.customer_name ? ' · ' + esc(b.customer_name) : '') + '</b><small>' + fmtDateTime(b.created_at) + ' · ' + b.item_count + (b.item_count === 1 ? ' item' : ' items') + (b.customer_phone ? ' · ' + esc(b.customer_phone) : '') + '</small></div><div class="side"><strong>' + money(b.total) + '</strong></div></button>';
      }).join('');
    }).catch(showError);
  }
  function setRange(kind) {
    if (kind === 'today') billRange = { from: todayISO(0), to: todayISO(0) };
    else if (kind === 'yesterday') billRange = { from: todayISO(-1), to: todayISO(-1) };
    else billRange = { from: todayISO(-(Number(kind) - 1)), to: todayISO(0) };
    document.querySelectorAll('[data-range]').forEach(function (x) { x.setAttribute('aria-pressed', x.dataset.range === kind ? 'true' : 'false'); });
    loadBills();
  }
  document.querySelectorAll('[data-range]').forEach(function (c) { c.addEventListener('click', function () { setRange(c.dataset.range); }); });
  ['bf-from', 'bf-to'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      var f = $('bf-from').value, t = $('bf-to').value; if (!f) return;
      if (!t || t < f) { t = f; $('bf-to').value = t; }
      billRange = { from: f, to: t };
      document.querySelectorAll('[data-range]').forEach(function (x) { x.setAttribute('aria-pressed', 'false'); });
      loadBills();
    });
  });

  function startBill() {
    bill = { lines: [] };
    $('bill-form').reset(); $('b-err').hidden = true; $('b-results').innerHTML = '';
    $('b-disc-type').value = 'percent'; $('b-gst-mode').value = 'none'; $('b-gst').value = '12';
    renderLines();
    api('GET', '/api/medicines').then(function (r) { state.meds = r.medicines; }).catch(showError);
  }
  function renderResults() {
    var q = ($('b-search').value || '').trim().toLowerCase();
    if (!q) { $('b-results').innerHTML = ''; return; }
    var list = state.meds.filter(function (m) { return (m.name + ' ' + m.batch).toLowerCase().indexOf(q) !== -1; }).slice(0, 8);
    if (!list.length) { $('b-results').innerHTML = '<div class="small muted">No medicine found in stock.</div>'; return; }
    $('b-results').innerHTML = list.map(function (m) {
      var why = m.days_left < 0 ? 'Expired – cannot sell' : m.qty <= 0 ? 'Out of stock' : '';
      return '<button type="button" class="pick" data-pick="' + m.id + '"' + (why ? ' disabled' : '') + '><span><b>' + esc(m.name) + '</b><small>' + (m.batch ? 'Batch ' + esc(m.batch) + ' · ' : '') + 'Exp ' + fmtDate(m.expiry) + ' · Stock ' + m.qty + ' · ' + money(m.price) + '</small>' + (why ? '<small style="color:#b91c1c;font-weight:700">' + why + '</small>' : (m.days_left <= 30 ? '<small style="color:#b45309;font-weight:700">Expires in ' + m.days_left + ' days</small>' : '')) + '</span><span class="add">' + (why ? '' : '+') + '</span></button>';
    }).join('');
  }
  $('b-search').addEventListener('input', renderResults);
  $('b-search').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); var p = $('b-results').querySelector('.pick:not([disabled])'); if (p) p.click(); } });

  function addLine(id) {
    var m = state.meds.filter(function (x) { return x.id === Number(id); })[0]; if (!m) return;
    var ex = bill.lines.filter(function (l) { return l.med.id === m.id; })[0];
    if (ex) ex.qty += 1; else bill.lines.push({ med: m, qty: 1, price: m.price });
    $('b-search').value = ''; $('b-results').innerHTML = '';
    renderLines();
  }
  function totals() {
    var sub = r2(bill.lines.reduce(function (s, l) { return s + r2((Number(l.qty) || 0) * (Number(l.price) || 0)); }, 0));
    var dv = Number($('b-disc').value) || 0, dt = $('b-disc-type').value;
    var disc = dt === 'percent' ? r2(sub * Math.min(dv, 100) / 100) : r2(dv);
    var taxable = r2(sub - disc), mode = $('b-gst-mode').value, pct = Number($('b-gst').value) || 0, gst = 0, total = taxable;
    if (mode === 'incl') gst = r2(taxable - taxable / (1 + pct / 100));
    if (mode === 'excl') { gst = r2(taxable * pct / 100); total = r2(taxable + gst); }
    return { sub: sub, disc: disc, dv: dv, dt: dt, mode: mode, pct: pct, gst: gst, total: total, badDisc: disc > sub || dv < 0 };
  }
  function renderTotals() {
    var t = totals();
    $('b-gst').disabled = t.mode === 'none';
    $('b-totals').innerHTML = '<div><span>Subtotal</span><span>' + money(t.sub) + '</span></div>' +
      (t.disc ? '<div><span>Discount' + (t.dt === 'percent' ? ' (' + t.dv + '%)' : '') + '</span><span>− ' + money(t.disc) + '</span></div>' : '') +
      (t.mode === 'incl' ? '<div class="muted"><span>GST ' + t.pct + '% (included)</span><span>' + money(t.gst) + '</span></div>' : '') +
      (t.mode === 'excl' ? '<div><span>GST ' + t.pct + '%</span><span>+ ' + money(t.gst) + '</span></div>' : '') +
      '<div class="grand"><span>Total / कुल</span><span>' + money(t.total) + '</span></div>' +
      (t.badDisc ? '<div style="color:#b91c1c;font-weight:700">Discount is more than the bill amount.</div>' : '');
    var over = bill.lines.some(function (l) { return l.qty > l.med.qty || !(l.qty >= 1); });
    $('b-save').disabled = !bill.lines.length || over || t.badDisc;
  }
  function renderLines() {
    if (!bill.lines.length) { $('b-lines').innerHTML = '<div class="empty" style="padding:14px">No medicine added yet. Search above and tap a medicine.</div>'; renderTotals(); return; }
    $('b-lines').innerHTML = bill.lines.map(function (l, i) {
      var m = l.med, over = l.qty > m.qty;
      return '<div class="bline' + (over ? ' over' : '') + '" data-line="' + i + '"><div class="bline-top"><div><b>' + esc(m.name) + '</b><small>' + (m.batch ? 'Batch ' + esc(m.batch) + ' · ' : '') + 'Exp ' + fmtDate(m.expiry) + ' · In stock ' + m.qty + '</small></div><button type="button" class="bline-x" data-rm="' + i + '" aria-label="Remove ' + esc(m.name) + '">×</button></div>' +
        '<div class="bline-row"><div><label for="lq' + i + '">Qty</label><input id="lq' + i + '" type="number" inputmode="numeric" min="1" step="1" value="' + l.qty + '" data-q="' + i + '"></div><div><label for="lp' + i + '">Price ₹ (MRP)</label><input id="lp' + i + '" type="number" inputmode="decimal" min="0" step="0.01" value="' + l.price + '" data-p="' + i + '"></div><div class="bline-amt" id="la' + i + '">' + money(r2(l.qty * l.price)) + '</div></div>' +
        (over ? '<div class="warn">⚠️ Only ' + m.qty + ' in stock / स्टॉक में सिर्फ ' + m.qty + '</div>' : '') + '</div>';
    }).join('');
    renderTotals();
  }
  $('b-lines').addEventListener('input', function (e) {
    var t = e.target, i;
    if (t.dataset.q !== undefined) { i = Number(t.dataset.q); bill.lines[i].qty = t.value === '' ? 0 : Math.floor(Number(t.value)); }
    else if (t.dataset.p !== undefined) { i = Number(t.dataset.p); bill.lines[i].price = Number(t.value) || 0; }
    else return;
    var l = bill.lines[i], box = t.closest('.bline');
    $('la' + i).textContent = money(r2(l.qty * l.price));
    var over = l.qty > l.med.qty;
    box.classList.toggle('over', over);
    var w = box.querySelector('.warn');
    if (over && !w) { w = document.createElement('div'); w.className = 'warn'; box.appendChild(w); }
    if (w) { if (over) w.textContent = '⚠️ Only ' + l.med.qty + ' in stock / स्टॉक में सिर्फ ' + l.med.qty; else w.remove(); }
    renderTotals();
  });
  $('b-lines').addEventListener('click', function (e) {
    var b = e.target.closest('[data-rm]'); if (!b) return;
    bill.lines.splice(Number(b.dataset.rm), 1); renderLines();
  });
  ['b-disc', 'b-disc-type', 'b-gst-mode', 'b-gst'].forEach(function (id) { $(id).addEventListener('input', renderTotals); $(id).addEventListener('change', renderTotals); });

  $('bill-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var err = $('b-err'), btn = $('b-save'), t = totals();
    if (!bill.lines.length) { err.textContent = 'Add at least one medicine.'; err.hidden = false; return; }
    var data = {
      customer_name: $('b-cname').value, customer_phone: $('b-cphone').value,
      items: bill.lines.map(function (l) { return { medicine_id: l.med.id, qty: l.qty, price: l.price }; }),
      discount_type: t.dt, discount_value: t.dv, gst_mode: t.mode, gst_percent: t.pct,
    };
    btn.disabled = true; err.hidden = true; btn.textContent = 'Saving…';
    api('POST', '/api/bills', data).then(function (r) {
      toast('Bill #' + r.bill.bill_no + ' saved. Stock updated.');
      openBill(r.bill);
    }).catch(function (x) {
      err.textContent = x.message; err.hidden = false;
      if (x.status === 409 && x.j && x.j.medicine_id) {
        bill.lines.forEach(function (l) { if (l.med.id === x.j.medicine_id) l.med.qty = x.j.available; });
        renderLines();
      }
    }).finally(function () { btn.textContent = 'Save bill / बिल सेव करें'; renderTotals(); });
  });

  function waText(b) {
    var u = state.user, lines = [];
    lines.push('*' + u.store_name + '*');
    lines.push('Bill No. ' + b.bill_no + ' · ' + fmtDateTime(b.created_at));
    if (b.customer_name) lines.push('Customer: ' + b.customer_name);
    lines.push('');
    b.items.forEach(function (it, i) { lines.push((i + 1) + '. ' + it.name + ' × ' + it.qty + ' = ' + money(it.amount)); });
    lines.push('');
    if (b.discount_amount || b.gst_mode === 'excl') lines.push('Subtotal: ' + money(b.subtotal));
    if (b.discount_amount) lines.push('Discount: −' + money(b.discount_amount));
    if (b.gst_mode === 'excl') lines.push('GST ' + b.gst_percent + '%: +' + money(b.gst_amount));
    lines.push('*Total: ' + money(b.total) + '*');
    if (b.gst_mode === 'incl') lines.push('(GST ' + b.gst_percent + '% included: ' + money(b.gst_amount) + ')');
    lines.push('');
    lines.push('Dhanyavaad! 🙏 Jaldi swasth ho jaiye.');
    return lines.join('\n');
  }
  function invoiceHTML(b) {
    var u = state.user;
    var head = '<div class="inv-head"><h1>' + esc(u.store_name) + '</h1>' +
      (u.store_address ? '<p>' + esc(u.store_address) + '</p>' : '') + '<p>' + (u.store_address && u.store_address.toLowerCase().indexOf(String(u.city || '').toLowerCase()) !== -1 ? '' : esc(u.city) + ' · ') + 'Ph ' + esc(u.phone) + '</p>' +
      (u.gstin ? '<p>GSTIN: ' + esc(u.gstin) + '</p>' : '') + (u.drug_licence ? '<p>D.L. No: ' + esc(u.drug_licence) + '</p>' : '') + '</div>';
    var title = '<div class="inv-title">' + (b.gst_mode !== 'none' && u.gstin ? 'TAX INVOICE' : 'BILL / CASH MEMO') + '</div>';
    var meta = '<div class="inv-meta"><span><b>Bill No:</b> ' + b.bill_no + '</span><span>' + fmtDateTime(b.created_at) + '</span>' +
      (b.customer_name || b.customer_phone ? '<span style="flex-basis:100%"><b>Customer:</b> ' + esc(b.customer_name || '') + (b.customer_phone ? ' · ' + esc(b.customer_phone) : '') + '</span>' : '') + '</div>';
    var rows = b.items.map(function (it, i) {
      return '<tr><td>' + (i + 1) + '. ' + esc(it.name) + '<small>' + (it.batch ? 'B: ' + esc(it.batch) + ' · ' : '') + (it.expiry ? 'Exp: ' + esc(it.expiry.slice(5, 7) + '/' + it.expiry.slice(2, 4)) : '') + '</small></td><td class="n">' + it.qty + '</td><td class="n">' + Number(it.price).toFixed(2) + '</td><td class="n">' + Number(it.amount).toFixed(2) + '</td></tr>';
    }).join('');
    var table = '<table class="inv-items"><thead><tr><th>Item</th><th class="n">Qty</th><th class="n">Rate</th><th class="n">Amt</th></tr></thead><tbody>' + rows + '</tbody></table>';
    var tot = '<div class="inv-tot"><div><span>Subtotal</span><span>' + money(b.subtotal) + '</span></div>' +
      (b.discount_amount ? '<div><span>Discount' + (b.discount_type === 'percent' ? ' (' + b.discount_value + '%)' : '') + '</span><span>−' + money(b.discount_amount) + '</span></div>' : '') +
      (b.gst_mode === 'excl' ? '<div><span>GST ' + b.gst_percent + '%</span><span>+' + money(b.gst_amount) + '</span></div>' : '') +
      '<div class="grand"><span>TOTAL</span><span>' + money(b.total) + '</span></div>' +
      (b.gst_mode === 'incl' ? '<div><span>Incl. GST ' + b.gst_percent + '%</span><span>' + money(b.gst_amount) + '</span></div>' : '') + '</div>';
    var foot = '<div class="inv-foot">Dhanyavaad! Get well soon 🙏<small>Items: ' + b.items.length + ' · Qty: ' + b.items.reduce(function (s, it) { return s + it.qty; }, 0) + '</small><small>Bill by Dawalekh</small></div>';
    return head + title + meta + table + tot + foot;
  }
  function openBill(b) {
    currentBill = b;
    showTab('billview');
    var paper = localStorage.getItem('dl_paper') || '80';
    $('bv-paper').value = paper; setPaper(paper);
    $('invoice').innerHTML = invoiceHTML(b);
    var phone = (b.customer_phone || '').replace(/\D/g, '');
    $('bv-wa').href = 'https://wa.me/' + (phone ? '91' + phone : '') + '?text=' + encodeURIComponent(waText(b));
  }
  function setPaper(p) { $('invoice').className = 'invoice inv-' + p; }
  $('bv-paper').addEventListener('change', function () { localStorage.setItem('dl_paper', this.value); setPaper(this.value); });
  $('bv-print').addEventListener('click', function () {
    var p = $('bv-paper').value, st = $('page-size');
    if (!st) { st = document.createElement('style'); st.id = 'page-size'; document.head.appendChild(st); }
    if (p === 'a4') st.textContent = '@page{size:A4;margin:12mm}';
    else {
      var mm = Math.ceil($('invoice').getBoundingClientRect().height * 25.4 / 96) + 8;
      st.textContent = '@page{size:' + p + 'mm ' + mm + 'mm;margin:0}';
    }
    window.print();
  });
  $('bv-del').addEventListener('click', function () {
    if (!currentBill || !confirm('Cancel Bill #' + currentBill.bill_no + '? Its medicines will be added back to stock.\n\nBill cancel karein? Stock wapas jud jayega.')) return;
    api('DELETE', '/api/bills/' + currentBill.id).then(function () { toast('Bill cancelled. Stock added back.'); currentBill = null; showTab('bills'); }).catch(showError);
  });

  // ---------- refill reminders ----------
  function loadReminders() {
    return api('GET', '/api/reminders').then(function (r) { state.reminders = r.reminders; renderReminders(); }).catch(showError);
  }
  function dueBadge(d) {
    if (d < 0) return '<span class="badge b-red">Overdue ' + Math.abs(d) + (Math.abs(d) === 1 ? ' day' : ' days') + '</span>';
    if (d === 0) return '<span class="badge b-green">Due today</span>';
    if (d <= 3) return '<span class="badge b-amber">Due in ' + d + (d === 1 ? ' day' : ' days') + '</span>';
    return '<span class="badge b-grey">Due ' + fmtDate(todayISO(d)) + '</span>';
  }
  function waLink(r) {
    var store = (state.user && state.user.store_name) || 'your medical store';
    var msg = 'Namaste ' + r.patient_name + ' ji, ' + store + ' se yaad dila rahe hain: aapki dawa ' + r.medicine + ' ka refill due hai. Kripya store par aayein ya is message ka reply karein. Dhanyavaad!';
    return 'https://wa.me/91' + r.phone + '?text=' + encodeURIComponent(msg);
  }
  function renderReminders() {
    if (!state.reminders.length) { $('rem-list').innerHTML = '<div class="empty">No patients yet. Tap “+ Add patient” to add a regular patient and their refill cycle.</div>'; return; }
    $('rem-list').innerHTML = state.reminders.map(function (r) {
      return '<div class="item"><div class="main"><b>' + esc(r.patient_name) + '</b><small>' + esc(r.medicine) + '</small><small>+91 ' + esc(r.phone) + ' · every ' + r.every_days + ' days' + (r.last_sent_at ? ' · last sent ' + fmtDate(r.last_sent_at) : '') + '</small></div><div class="side">' + dueBadge(r.days_left) +
        '<div class="acts"><a class="btn btn-wa btn-sm" href="' + waLink(r) + '" target="_blank" rel="noopener" data-sent="' + r.id + '">Send on WhatsApp</a><button class="btn btn-ghost btn-sm" type="button" data-edit-rem="' + r.id + '">Edit</button></div></div></div>';
    }).join('');
  }
  var editingRem = null;
  function openRem(r) {
    editingRem = r || null;
    var f = $('rem-form'); f.reset(); $('r-err').hidden = true;
    $('rem-title').textContent = r ? 'Edit patient reminder' : 'Add patient reminder';
    $('r-del').hidden = !r;
    if (r) { f.patient_name.value = r.patient_name; f.phone.value = r.phone; f.medicine.value = r.medicine; f.every_days.value = r.every_days; f.next_due.value = r.next_due; }
    else { f.every_days.value = 30; f.next_due.value = todayISO(30); }
    $('rem-dlg').showModal();
    setTimeout(function () { f.patient_name.focus(); }, 50);
  }
  $('add-rem').addEventListener('click', function () { openRem(null); });
  $('rem-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target, err = $('r-err'), btn = f.querySelector('button[type=submit]');
    var data = { patient_name: f.patient_name.value, phone: f.phone.value, medicine: f.medicine.value, every_days: Number(f.every_days.value), next_due: f.next_due.value };
    btn.disabled = true; err.hidden = true;
    (editingRem ? api('PUT', '/api/reminders/' + editingRem.id, data) : api('POST', '/api/reminders', data))
      .then(function () { $('rem-dlg').close(); toast(editingRem ? 'Reminder updated' : 'Patient added'); loadReminders(); })
      .catch(function (x) { err.textContent = x.message; err.hidden = false; })
      .finally(function () { btn.disabled = false; });
  });
  $('r-del').addEventListener('click', function () {
    if (!editingRem || !confirm('Delete the reminder for ' + editingRem.patient_name + '?')) return;
    api('DELETE', '/api/reminders/' + editingRem.id).then(function () { $('rem-dlg').close(); toast('Reminder deleted'); loadReminders(); }).catch(function (x) { $('r-err').textContent = x.message; $('r-err').hidden = false; });
  });

  // ---------- plan & billing ----------
  function loadPlan() {
    var cfg = state.config, u = state.user, s = u.status;
    var note = '';
    if (!cfg.payments.enabled) note = '<div class="alert alert-warn" style="margin-bottom:14px">Online payments are being set up and will be available soon. Your trial and data are not affected.</div>';
    else if (cfg.payments.test_mode) note = '<div class="test-note">🧪 Test mode — no real money is charged</div>';
    $('pay-note').innerHTML = note;
    var cur;
    if (s.state === 'trial') cur = '<h3>Free trial</h3><p class="muted" style="margin:0">All features are open until <strong>' + new Date(s.trial_ends_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) + '</strong>. Choose a plan any time; paid days start after your trial ends.</p>';
    else if (s.state === 'active') cur = '<h3>' + esc(s.plan_name) + ' plan</h3><p class="muted" style="margin:0">Active till <strong>' + fmtDate(s.paid_until) + '</strong>. Paying again adds 30 more days.</p>';
    else cur = '<h3>No active plan</h3><p class="muted" style="margin:0">Your data is safe. Choose a plan below to unlock your store again.</p>';
    $('plan-current').innerHTML = cur;
    $('plan-cards').innerHTML = cfg.plans.map(function (p) {
      var isCur = s.state === 'active' && s.plan === p.id;
      return '<div class="card' + (isCur ? ' current' : '') + '"><h3 style="margin:0">' + esc(p.name) + (isCur ? ' <span class="badge b-green">Current</span>' : '') + '</h3><div class="price">₹' + p.price + '<small> / 30 days</small></div><ul>' + p.features.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>' +
        '<button class="btn ' + (p.id === 'pro' ? 'btn-primary' : 'btn-ghost') + ' btn-block" type="button" data-pay="' + p.id + '"' + (cfg.payments.enabled ? '' : ' disabled') + '>' + (isCur ? 'Renew' : 'Pay') + ' ₹' + p.price + '</button></div>';
    }).join('');
    var f = $('profile-form'); f.store_name.value = u.store_name; f.owner_name.value = u.owner_name; f.city.value = u.city; f.store_address.value = u.store_address || ''; f.gstin.value = u.gstin || ''; f.drug_licence.value = u.drug_licence || '';
    $('p-login').textContent = 'Login: +91 ' + u.phone + (u.email ? ' · ' + u.email : '');
    api('GET', '/api/billing/history').then(function (r) {
      if (!r.payments.length) { $('pay-history').textContent = 'No payments yet.'; return; }
      $('pay-history').innerHTML = '<div class="list">' + r.payments.map(function (p) {
        var st = p.status === 'paid' ? '<span class="badge b-green">Paid</span>' : '<span class="badge b-red">Failed</span>';
        return '<div class="item"><div class="main"><b>' + esc(p.plan === 'clinic' ? 'Clinic+' : p.plan.charAt(0).toUpperCase() + p.plan.slice(1)) + ' · ' + rupees(p.amount_paise / 100) + (p.live_mode ? '' : ' <span class="badge b-yellow">Test</span>') + '</b><small>' + fmtDate(p.paid_at || p.created_at) + (p.razorpay_payment_id ? ' · ' + esc(p.razorpay_payment_id) : '') + '</small></div><div class="side">' + st + '</div></div>';
      }).join('') + '</div>';
    }).catch(function () {});
  }

  function loadCheckoutScript() {
    return new Promise(function (resolve, reject) {
      if (window.Razorpay) return resolve();
      var s = document.createElement('script'); s.src = 'https://checkout.razorpay.com/v1/checkout.js';
      s.onload = resolve; s.onerror = function () { reject(new Error('Could not load the payment window. Please check your internet and try again.')); };
      document.head.appendChild(s);
    });
  }
  function pay(planId, btn) {
    var label = btn.textContent; btn.disabled = true; btn.textContent = 'Opening payment…';
    var reset = function () { btn.disabled = false; btn.textContent = label; };
    Promise.all([loadCheckoutScript(), api('POST', '/api/billing/order', { plan: planId })]).then(function (res) {
      var o = res[1];
      var rzp = new window.Razorpay({
        key: o.key_id, amount: o.amount, currency: o.currency, order_id: o.order_id,
        name: 'Dawalekh', description: o.plan.name + ' plan · 30 days',
        prefill: o.prefill, notes: { plan: o.plan.id }, theme: { color: '#0f766e' },
        handler: function (resp) {
          btn.textContent = 'Confirming…';
          api('POST', '/api/billing/verify', resp).then(function (r) {
            state.user = r.user; renderStatus(); unlock(); toast('Payment successful! ' + o.plan.name + ' plan is active.'); loadPlan();
          }).catch(function (x) { alert(x.message); }).finally(reset);
        },
        modal: { ondismiss: reset },
      });
      rzp.on('payment.failed', function (resp) { toast('Payment failed: ' + ((resp.error && resp.error.description) || 'please try again')); });
      rzp.open();
    }).catch(function (x) { alert(x.message); reset(); });
  }
  function unlock() { document.querySelectorAll('.tabs button').forEach(function (b) { b.disabled = false; }); }

  $('profile-form').addEventListener('submit', function (e) {
    e.preventDefault(); var f = e.target;
    api('PUT', '/api/me', { store_name: f.store_name.value, owner_name: f.owner_name.value, city: f.city.value, store_address: f.store_address.value, gstin: f.gstin.value, drug_licence: f.drug_licence.value }).then(function (r) { state.user = r.user; $('store-name').textContent = r.user.store_name; toast('Details saved'); }).catch(function (x) { toast(x.message); });
  });
  $('pw-form').addEventListener('submit', function (e) {
    e.preventDefault(); var f = e.target;
    api('POST', '/api/me/password', { current: f.current.value, next: f.next.value }).then(function () { f.reset(); toast('Password changed'); }).catch(function (x) { toast(x.message); });
  });

  // ---------- events ----------
  document.addEventListener('click', function (e) {
    var t = e.target.closest('button, a'); if (!t) return;
    if (t.dataset.tab && !t.disabled) showTab(t.dataset.tab);
    else if (t.dataset.go) showTab(t.dataset.go);
    else if (t.hasAttribute('data-add-med')) openMed(null);
    else if (t.hasAttribute('data-new-bill')) showTab('newbill');
    else if (t.dataset.pick) addLine(t.dataset.pick);
    else if (t.dataset.bill) api('GET', '/api/bills/' + t.dataset.bill).then(function (r) { openBill(r.bill); }).catch(showError);
    else if (t.dataset.editMed) openMed(findMed(t.dataset.editMed));
    else if (t.dataset.editRem) openRem(state.reminders.filter(function (r) { return r.id === Number(t.dataset.editRem); })[0]);
    else if (t.dataset.pay) pay(t.dataset.pay, t);
    else if (t.hasAttribute('data-close')) t.closest('dialog').close();
    else if (t.dataset.sent) {
      var id = t.dataset.sent;
      setTimeout(function () { api('POST', '/api/reminders/' + id + '/sent').then(function () { toast('Marked as sent. Next refill date updated.'); loadReminders(); }).catch(function () {}); }, 400);
    }
  });
  document.querySelectorAll('.chip[data-filter]').forEach(function (c) {
    c.addEventListener('click', function () {
      state.filter = c.dataset.filter;
      document.querySelectorAll('.chip[data-filter]').forEach(function (x) { x.setAttribute('aria-pressed', x === c ? 'true' : 'false'); });
      renderMeds();
    });
  });
  $('search').addEventListener('input', renderMeds);
  [$('csv-stock'), $('csv-rem')].forEach(function (a) {
    a.addEventListener('click', function (e) {
      if (a.getAttribute('aria-disabled') === 'true') { e.preventDefault(); toast(a.dataset.reason); }
    });
  });
  $('logout').addEventListener('click', function () { api('POST', '/api/logout').finally(function () { location.href = '/'; }); });

  function showError(x) { if (x && x.message !== 'login' && x.status !== 402) toast(x.message); }

  // ---------- start ----------
  waitForServer().then(function () { return Promise.all([api('GET', '/api/me'), fetch('/api/config').then(function (r) { return r.json(); })]).then(function (res) {
    state.user = res[0].user; state.limits = res[0].limits; state.config = res[1]; renderEmailNote();
    $('loading').hidden = true;
    $('store-name').textContent = state.user.store_name;
    if (!state.limits.csvExport) { $('csv-stock').setAttribute('aria-disabled', 'true'); $('csv-stock').dataset.reason = 'CSV download is part of the Pro and Clinic+ plans.'; }
    if (!(state.user.status.state === 'trial' || state.user.status.plan === 'clinic')) { $('csv-rem').setAttribute('aria-disabled', 'true'); $('csv-rem').dataset.reason = 'Reminder download is part of the Clinic+ plan.'; }
    renderStatus();
    state.timer = setInterval(renderStatus, 30000);
    if (state.user.status.state === 'expired') { lockApp(); return; }
    showTab(location.hash === '#plan' ? 'plan' : 'home');
    if (/welcome=1/.test(location.search)) { toast('Welcome! Your 2-day free trial has started.'); history.replaceState(null, '', '/app'); }
  }); }).catch(function (x) { if (x.message !== 'login') { $('loading').textContent = 'Could not load your store. Please refresh the page.'; } });
})();
