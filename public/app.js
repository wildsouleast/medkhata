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
          if (r.status === 402 && j && j.error === 'plan_required') { setTimeout(function () { refreshMe(); readOnlyWall(); }, 0); }
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
  function usageLine() {
    var u = state.usage, L = state.limits;
    if (!u || !L || !L.maxMedicines) return '';
    return u.medicines + '/' + L.maxMedicines + ' dawai · ' + u.bills_this_month + '/' + L.maxBillsPerMonth + ' bill (is mahine)';
  }
  function renderStatus() {
    var el = $('status'); var s = state.user && state.user.status; if (!s) return;
    el.hidden = false;
    document.body.classList.toggle('readonly', s.state === 'expired');
    var end = s.state === 'trial' ? new Date(s.trial_ends_at) : s.state === 'active' ? new Date(s.paid_until) : null;
    var left = end ? end.getTime() - Date.now() : 0;
    if (s.state === 'trial' && left > 0) {
      el.className = 'status trial';
      el.innerHTML = '<span>⏳ Free trial: <strong>' + remaining(left) + '</strong> left · sab features khule</span><button class="btn btn-primary btn-sm" type="button" data-go="plan">Plans</button>';
    } else if (s.state === 'active' && left > 0) {
      var days = Math.ceil(left / 86400000);
      var basic = s.tier === 'basic';
      el.className = 'status active';
      el.innerHTML = '<span>✅ ' + esc(s.plan_name) + ' active · ' + (days <= 5 ? '<strong>' + days + (days === 1 ? ' day' : ' days') + ' left</strong>' : 'till ' + fmtDate(s.paid_until)) + (basic && usageLine() ? '<br><small>' + usageLine() + '</small>' : '') + '</span>' +
        (days <= 5 ? '<button class="btn btn-primary btn-sm" type="button" data-go="plan">Renew</button>' : basic ? '<button class="btn btn-ghost btn-sm" type="button" data-go="plan">Pro ₹149</button>' : '');
    } else if (s.state === 'expired') {
      el.className = 'status expired';
      el.innerHTML = '<span>🔒 ' + (s.ended === 'paid' ? 'Plan khatam' : 'Free trial khatam') + ' · store <strong>read-only</strong> hai (data safe)</span><button class="btn btn-primary btn-sm" type="button" data-go="plan">Plan lo</button>';
    } else { refreshMe(); }
  }
  // Read-only "plan lo" screen: shown once per visit when the trial/plan is over, and whenever a change is refused.
  function readOnlyWall() {
    var s = state.user && state.user.status;
    document.querySelectorAll('dialog[open]').forEach(function (d) { if (d.id !== 'ro-dlg') d.close(); });
    var d = $('ro-dlg');
    if (!d) {
      d = document.createElement('dialog'); d.id = 'ro-dlg'; d.className = 'ro-dlg';
      document.body.appendChild(d);
      d.addEventListener('click', function (e) {
        var b = e.target.closest('button'); if (!b) return;
        d.close(); if (b.dataset.act === 'plan') showTab('plan');
      });
    }
    var trialDays = (state.config && state.config.trial_days) || 7;
    var paidEnded = s && s.ended === 'paid';
    var plans = (state.config && state.config.plans) || [];
    var cheapest = plans.reduce(function (m, p) { return m == null || p.price < m ? p.price : m; }, null) || 49;
    d.innerHTML = '<div class="ro-icon" aria-hidden="true">🔒</div>' +
      '<h2>' + (paidEnded ? 'Aapka plan khatam ho gaya' : 'Aapka ' + trialDays + ' din ka free trial khatam ho gaya') + '</h2>' +
      '<p class="muted">Store ab <b>read-only</b> hai. Plan lete hi sab turant chalu.</p>' +
      '<ul class="ro-list"><li>✅ Aapka sara data <b>safe</b> hai, kuch delete nahi hoga</li><li>👀 Stock, purane bill, udhaar sab <b>dekh</b> sakte ho, CSV download bhi</li><li>🚫 Naya bill, purchase ya badlav ke liye plan chahiye</li></ul>' +
      '<div class="ro-prices"><span><b>Basic ₹' + cheapest + '</b>/mahina</span><span><b>Pro ₹149</b>/mahina</span></div>' +
      '<button class="btn btn-primary btn-block" type="button" data-act="plan">Plan lo, ₹' + cheapest + ' se</button>' +
      '<button class="btn btn-ghost btn-block" type="button" data-act="close">Abhi sirf dekhna hai</button>';
    if (!d.open) d.showModal();
  }
  var refreshing = false;
  function refreshMe() {
    if (refreshing) return Promise.resolve();
    refreshing = true;
    return api('GET', '/api/me').then(function (r) { state.user = r.user; state.limits = r.limits; state.usage = r.usage; applyLimits(); renderStatus(); }).catch(function () {}).finally(function () { refreshing = false; });
  }
  function applyLimits() {
    [$('csv-stock'), $('csv-rem')].forEach(function (a) {
      if (!state.limits.csvExport) { a.setAttribute('aria-disabled', 'true'); a.dataset.reason = 'CSV download Pro plan mein hai (₹149/mahina).'; }
      else a.removeAttribute('aria-disabled');
    });
  }
  function lockApp() {}

  // ---------- tabs ----------
  function showTab(name) {
    state.tab = name;
    if (document.body.classList.contains('readonly') && (name === 'newbill' || name === 'purchaseform')) { readOnlyWall(); return; }
    var NAV = { newbill: 'bills', billview: 'bills', purchases: 'stock', purchaseform: 'stock', customer: 'udhaar', refills: 'more', plan: 'more' };
    var navName = NAV[name] || name;
    document.querySelectorAll('.tabs button').forEach(function (b) { b.setAttribute('aria-selected', b.dataset.tab === navName ? 'true' : 'false'); });
    ['home', 'bills', 'newbill', 'billview', 'stock', 'purchases', 'purchaseform', 'udhaar', 'customer', 'more', 'refills', 'plan', 'ai'].forEach(function (t) { $('tab-' + t).hidden = t !== name; });
    if (name === 'purchases') loadPurchases();
    if (name === 'udhaar') loadKhata();
    if (name === 'home') loadHome();
    if (name === 'stock') loadMeds();
    if (name === 'bills') loadBills();
    if (name === 'newbill') startBill();
    if (name === 'refills') loadReminders();
    if (name === 'plan') loadPlan();
    if (name === 'ai') loadAI();
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
    if (state.user && (state.user.status.state === 'expired' || state.user.status.tier === 'basic')) refreshMe();
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
    $('b-refill').checked = false; $('b-refill-days-f').hidden = true; $('b-refill-row').hidden = !hasPro();
    api('GET', '/api/medicines').then(function (r) {
      state.meds = r.medicines;
      var pick = state.pendingBill; state.pendingBill = null;
      if (pick && pick.length) { pick.forEach(function (id) { addLine(id); }); toast(pick.length + ' dawai parchi scan se bill mein daali — qty/price check karein'); }
    }).catch(showError);
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
  $('b-refill').addEventListener('change', function () { $('b-refill-days-f').hidden = !this.checked; });
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
      customer_name: $('b-cname').value, customer_phone: $('b-cphone').value, udhaar: $('b-udhaar').checked,
      items: bill.lines.map(function (l) { return { medicine_id: l.med.id, qty: l.qty, price: l.price }; }),
      discount_type: t.dt, discount_value: t.dv, gst_mode: t.mode, gst_percent: t.pct,
    };
    btn.disabled = true; err.hidden = true; btn.textContent = 'Saving…';
    var refill = $('b-refill').checked && hasPro();
    if (refill && (!data.customer_name.trim() || !/^[6-9]\d{9}$/.test(String(data.customer_phone).replace(/\D/g, '').slice(-10)))) {
      err.textContent = 'Monthly dawai reminder ke liye customer ka naam aur 10 digit mobile number likhein.'; err.hidden = false; return;
    }
    var refillMeds = bill.lines.map(function (l) { return l.med.name; }).filter(function (n, i, a) { return a.indexOf(n) === i; }).join(', ').slice(0, 120);
    var refillDays = Number($('b-refill-days').value) || 30;
    api('POST', '/api/bills', data).then(function (r) {
      if (refill) {
        api('POST', '/api/reminders', { patient_name: data.customer_name.trim(), phone: String(data.customer_phone).replace(/\D/g, '').slice(-10), medicine: refillMeds, every_days: refillDays, next_due: todayISO(refillDays) })
          .then(function () { toast('🔁 Refill reminder laga: ' + refillDays + ' din baad'); }).catch(function (x) { toast('Reminder nahi laga: ' + x.message); });
      }
      toast('Bill #' + r.bill.bill_no + ' saved. Stock updated.' + (data.udhaar ? ' Udhaar mein likha.' : ''));
      if (state.usage) state.usage.bills_this_month++;
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
    var ub = $('bv-udhaar'); ub.disabled = true; ub.textContent = '📒 Udhaar mein likho';
    api('GET', '/api/bills/' + b.id + '/udhaar').then(function (r) {
      if (currentBill !== b) return;
      if (r.udhaar) { ub.textContent = '📒 Udhaar: ' + r.udhaar.name + ' ✓'; ub.dataset.cust = r.udhaar.customer_id; }
      else { ub.disabled = false; delete ub.dataset.cust; }
      ub.disabled = false;
    }).catch(function () { ub.disabled = false; });
  }
  $('bv-udhaar').addEventListener('click', function () {
    if (!currentBill) return;
    if (this.dataset.cust) { openCustomer(Number(this.dataset.cust)); return; }
    openKhata('udhaar', null, { name: currentBill.customer_name, phone: currentBill.customer_phone, amount: currentBill.total, bill: currentBill });
  });
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
    var cur, fmtEnd = function (d) { return new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); };
    var minPrice = cfg.plans.reduce(function (m, p) { return m == null || p.price < m ? p.price : m; }, null);
    if (s.state === 'trial') cur = '<h3>Free trial (' + (cfg.trial_days || 7) + ' din)</h3><p class="muted" style="margin:0">Sab Pro features <strong>' + fmtEnd(s.trial_ends_at) + '</strong> tak khule. Uske baad store <b>read-only</b> ho jayega: data safe rahega, dekh aur download kar sakte ho, par naya bill banane ke liye plan lena hoga (Basic ₹' + minPrice + '/mahina se). Plan kabhi bhi lein; paid din trial ke baad shuru honge.</p>';
    else if (s.state === 'active') cur = '<h3>' + esc(s.plan_name) + '</h3><p class="muted" style="margin:0">Active till <strong>' + fmtDate(s.paid_until) + '</strong>. Dobara pay karne pe din aage jud jayenge.' + (s.tier === 'basic' && usageLine() ? ' Use: <strong>' + usageLine() + '</strong>.' : '') + '</p>';
    else cur = '<div class="ro-head"><h3>🔒 Store read-only hai</h3><p style="margin:0">' + (s.ended === 'paid' ? 'Aapka plan khatam ho gaya.' : 'Aapka ' + (cfg.trial_days || 7) + ' din ka free trial khatam ho gaya.') + ' Aapka sara data safe hai. Stock, bill aur udhaar dekh sakte ho, CSV download kar sakte ho. <b>Naya bill / purchase ke liye neeche se plan lo.</b></p></div>';
    $('plan-current').innerHTML = cur;
    $('plan-cards').innerHTML = cfg.plans.map(function (p) {
      var isCur = s.state === 'active' && s.plan === p.id;
      var per = p.period === 'year' ? ' / saal' : ' / mahina';
      var monthlyPro = cfg.plans.filter(function (q) { return q.tier === 'pro' && q.period === 'month'; })[0];
      var save = p.period === 'year' && monthlyPro ? '<div class="save-tag">₹' + (monthlyPro.price * 12 - p.price).toLocaleString('en-IN') + ' bachao (₹' + Math.round(p.price / 12) + '/mahina)</div>' : '';
      var tag = p.tier === 'basic' ? '<div class="muted" style="font-size:.9rem">Chhoti dukaan ke liye</div>' : '';
      return '<div class="card' + (isCur ? ' current' : '') + (p.period === 'year' ? ' best' : '') + '"><h3 style="margin:0">' + esc(p.name) + (isCur ? ' <span class="badge b-green">Current</span>' : '') + '</h3>' + tag + '<div class="price">₹' + p.price.toLocaleString('en-IN') + '<small>' + per + '</small></div>' + save + '<ul>' + p.features.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>' +
        '<button class="btn ' + (p.period === 'year' ? 'btn-primary' : 'btn-ghost') + ' btn-block" type="button" data-pay="' + p.id + '"' + (cfg.payments.enabled ? '' : ' disabled') + '>' + (isCur ? 'Renew' : 'Pay') + ' ₹' + p.price.toLocaleString('en-IN') + '</button></div>';
    }).join('');
    var f = $('profile-form'); f.store_name.value = u.store_name; f.owner_name.value = u.owner_name; f.city.value = u.city; f.store_address.value = u.store_address || ''; f.gstin.value = u.gstin || ''; f.drug_licence.value = u.drug_licence || '';
    $('p-login').textContent = 'Login: +91 ' + u.phone + (u.email ? ' · ' + u.email : '');
    api('GET', '/api/billing/history').then(function (r) {
      if (!r.payments.length) { $('pay-history').textContent = 'No payments yet.'; return; }
      $('pay-history').innerHTML = '<div class="list">' + r.payments.map(function (p) {
        var st = p.status === 'paid' ? '<span class="badge b-green">Paid</span>' : '<span class="badge b-red">Failed</span>';
        var PN = { basic_monthly: 'Basic', monthly: 'Pro (monthly)', yearly: 'Pro (yearly)', clinic: 'Clinic+', basic: 'Basic (old)', pro: 'Pro' };
        return '<div class="item"><div class="main"><b>' + esc(PN[p.plan] || p.plan) + ' · ' + rupees(p.amount_paise / 100) + (p.live_mode ? '' : ' <span class="badge b-yellow">Test</span>') + '</b><small>' + fmtDate(p.paid_at || p.created_at) + (p.razorpay_payment_id ? ' · ' + esc(p.razorpay_payment_id) : '') + '</small></div><div class="side">' + st + '</div></div>';
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
        name: 'Dawalekh', description: o.plan.name + (o.plan.id === 'yearly' ? ' · 365 days' : ' · 30 days'),
        prefill: o.prefill, notes: { plan: o.plan.id }, theme: { color: '#0f766e' },
        handler: function (resp) {
          btn.textContent = 'Confirming…';
          api('POST', '/api/billing/verify', resp).then(function (r) {
            state.user = r.user; refreshMe(); unlock(); toast('Payment successful! ' + o.plan.name + ' is active.'); loadPlan();
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
    else if (t.hasAttribute('data-new-purchase')) openPurchase(null);
    else if (t.dataset.purchase) api('GET', '/api/purchases/' + t.dataset.purchase).then(function (r) { openPurchase(r.purchase); }).catch(showError);
    else if (t.dataset.supplier !== undefined && t.classList.contains('sup-row')) { purState.supplier = t.dataset.supplier; loadPurchases(); }
    else if (t.hasAttribute('data-clear-sup')) { purState.supplier = ''; loadPurchases(); }
    else if (t.dataset.khata) openKhata(t.dataset.khata, t.hasAttribute('data-for-current') ? curCustomer : null);
    else if (t.dataset.customer) openCustomer(Number(t.dataset.customer));
    else if (t.dataset.delEntry) delEntry(Number(t.dataset.delEntry));
    else if (t.dataset.pick) addLine(t.dataset.pick);
    else if (t.dataset.bill) api('GET', '/api/bills/' + t.dataset.bill).then(function (r) { openBill(r.bill); }).catch(showError);
    else if (t.dataset.editMed) openMed(findMed(t.dataset.editMed));
    else if (t.dataset.editRem) openRem(state.reminders.filter(function (r) { return r.id === Number(t.dataset.editRem); })[0]);
    else if (t.dataset.pay) pay(t.dataset.pay, t);
    else if (t.hasAttribute('data-close')) t.closest('dialog').close();
    else if (t.dataset.sent) {
      var id = t.dataset.sent;
      setTimeout(function () { api('POST', '/api/reminders/' + id + '/sent').then(function () { toast('Marked as sent. Next refill date updated.'); if (state.tab === 'ai') loadAIDue(); else loadReminders(); }).catch(function () {}); }, 400);
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

  // ---------- purchase entry ----------
  var purState = { supplier: '', current: null, suppliers: [] };
  function loadPurchases() {
    var q = purState.supplier ? '?supplier=' + encodeURIComponent(purState.supplier) : '';
    return api('GET', '/api/purchases' + q).then(function (r) {
      purState.suppliers = r.suppliers;
      $('pur-card').innerHTML = '<div><small>Is mahine ki khareed</small><strong>' + rupees(r.this_month.total) + '</strong></div><div><small>Purchase bills</small><strong>' + r.this_month.count + '</strong></div>';
      $('pur-filter').innerHTML = purState.supplier ? '<p class="small"><span class="badge b-green">Supplier: ' + esc(purState.supplier) + '</span> <button class="linkbtn" type="button" data-clear-sup>✕ sab dikhao</button></p>' : '';
      $('pur-list').innerHTML = r.purchases.length ? r.purchases.map(function (p) {
        return '<button type="button" class="item bill-item li-row" data-purchase="' + p.id + '"><div class="main"><b>' + esc(p.supplier) + (p.invoice_no ? ' · #' + esc(p.invoice_no) : '') + '</b><small>' + fmtDate(p.purchase_date) + ' · ' + p.item_count + (p.item_count === 1 ? ' item' : ' items') + '</small></div><div class="side"><strong>' + rupees(p.total) + '</strong></div></button>';
      }).join('') : '<div class="empty"><p><strong>Abhi koi purchase nahi.</strong></p><p>Distributor ka bill aaye to yahan likhein — stock apne aap badh jayega.</p><button class="btn btn-primary" type="button" data-new-purchase>+ Pehli purchase entry</button></div>';
      $('sup-wrap').hidden = !r.suppliers.length;
      $('sup-list').innerHTML = r.suppliers.map(function (x) {
        return '<button type="button" class="item bill-item li-row sup-row" data-supplier="' + esc(x.supplier) + '"><div class="main"><b>' + esc(x.supplier) + '</b><small>' + x.count + (x.count === 1 ? ' bill' : ' bills') + ' · last ' + fmtDate(x.last_date) + '</small></div><div class="side"><strong>' + rupees(x.total) + '</strong></div></button>';
      }).join('');
    }).catch(showError);
  }
  function lineHTML(i, x) {
    x = x || {};
    var v = function (k) { return x[k] == null ? '' : esc(x[k]); };
    return '<div class="section-card pf-line" data-line>' +
      '<div class="pf-line-head"><b>Item ' + (i + 1) + '</b><button class="linkbtn danger" type="button" data-rm-line aria-label="Remove line">✕ Hatao</button></div>' +
      '<div class="field"><label>Medicine name</label><input data-k="name" list="med-names" maxlength="100" value="' + v('name') + '" placeholder="e.g. Dolo 650"></div>' +
      '<div class="row2"><div class="field"><label>Batch</label><input data-k="batch" maxlength="40" value="' + v('batch') + '"></div><div class="field"><label>Expiry</label><input data-k="expiry" type="date" value="' + v('expiry') + '"></div></div>' +
      '<div class="row3"><div class="field"><label>Qty</label><input data-k="qty" type="number" inputmode="numeric" min="1" step="1" value="' + v('qty') + '"></div><div class="field"><label>Rate ₹</label><input data-k="rate" type="number" inputmode="decimal" min="0" step="0.01" value="' + v('rate') + '" placeholder="kharid"></div><div class="field"><label>MRP ₹</label><input data-k="mrp" type="number" inputmode="decimal" min="0" step="0.01" value="' + v('mrp') + '"></div></div>' +
      '<div class="small muted pf-amt" data-amt></div></div>';
  }
  function readLines() {
    return Array.prototype.map.call(document.querySelectorAll('#pf-lines [data-line]'), function (el) {
      var g = function (k) { return el.querySelector('[data-k="' + k + '"]').value; };
      return { name: g('name').trim(), batch: g('batch').trim(), expiry: g('expiry'), qty: g('qty') === '' ? NaN : Number(g('qty')), rate: g('rate') === '' ? 0 : Number(g('rate')), mrp: g('mrp') === '' ? 0 : Number(g('mrp')) };
    });
  }
  function renderLineNums() {
    document.querySelectorAll('#pf-lines [data-line]').forEach(function (el, i) { el.querySelector('.pf-line-head b').textContent = 'Item ' + (i + 1); });
  }
  function pfTotals() {
    var tot = 0;
    document.querySelectorAll('#pf-lines [data-line]').forEach(function (el) {
      var q = Number(el.querySelector('[data-k="qty"]').value) || 0, r = Number(el.querySelector('[data-k="rate"]').value) || 0;
      var amt = Math.round(q * r * 100) / 100; tot += amt;
      el.querySelector('[data-amt]').textContent = q && r ? q + ' × ' + rupees(r) + ' = ' + rupees(amt) : '';
    });
    $('pf-total').textContent = rupees(Math.round(tot * 100) / 100);
  }
  function addPurchaseLine(x) {
    var n = document.querySelectorAll('#pf-lines [data-line]').length;
    $('pf-lines').insertAdjacentHTML('beforeend', lineHTML(n, x));
    pfTotals();
  }
  function openPurchase(p) {
    purState.current = p;
    showTab('purchaseform');
    $('pf-title').textContent = p ? 'Edit purchase' : 'New purchase';
    $('pf-err').hidden = true; $('pf-del').hidden = !p;
    $('pf-sup').value = p ? p.supplier : (purState.supplier || '');
    $('pf-inv').value = p ? p.invoice_no : '';
    $('pf-date').value = p ? p.purchase_date : todayISO(0);
    $('pf-lines').innerHTML = '';
    (p ? p.items : [{}]).forEach(function (x) { addPurchaseLine(x); });
    $('sup-names').innerHTML = purState.suppliers.map(function (x) { return '<option value="' + esc(x.supplier) + '">'; }).join('');
    var fill = function () { var seen = {}; $('med-names').innerHTML = state.meds.filter(function (m) { var k = m.name.toLowerCase(); if (seen[k]) return false; seen[k] = 1; return true; }).map(function (m) { return '<option value="' + esc(m.name) + '">'; }).join(''); };
    if (state.meds.length) fill(); else api('GET', '/api/medicines').then(function (r) { state.meds = r.medicines; fill(); }).catch(function () {});
    if (!purState.suppliers.length) api('GET', '/api/purchases').then(function (r) { purState.suppliers = r.suppliers; $('sup-names').innerHTML = r.suppliers.map(function (x) { return '<option value="' + esc(x.supplier) + '">'; }).join(''); }).catch(function () {});
  }
  $('pf-add').addEventListener('click', function () { addPurchaseLine({}); var l = document.querySelectorAll('#pf-lines [data-line]'); l[l.length - 1].querySelector('input').focus(); });
  $('pf-lines').addEventListener('input', function (e) {
    var inp = e.target;
    if (inp.dataset.k === 'name') {
      var line = inp.closest('[data-line]'), name = inp.value.trim().toLowerCase();
      var m = state.meds.filter(function (x) { return x.name.toLowerCase() === name; })[0];
      if (m) {
        var mrp = line.querySelector('[data-k="mrp"]'), batch = line.querySelector('[data-k="batch"]');
        if (!mrp.value && m.price) mrp.value = m.price;
        if (!batch.value && m.batch) batch.placeholder = 'pichhla: ' + m.batch;
      }
    }
    pfTotals();
  });
  $('pf-lines').addEventListener('click', function (e) {
    var b = e.target.closest('[data-rm-line]'); if (!b) return;
    if (document.querySelectorAll('#pf-lines [data-line]').length === 1) { toast('Kam se kam ek line chahiye.'); return; }
    b.closest('[data-line]').remove(); renderLineNums(); pfTotals();
  });
  $('pur-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var err = $('pf-err'), btn = $('pf-save'), p = purState.current;
    var data = { supplier: $('pf-sup').value, invoice_no: $('pf-inv').value, purchase_date: $('pf-date').value, items: readLines() };
    btn.disabled = true; err.hidden = true; btn.textContent = 'Saving…';
    api(p ? 'PUT' : 'POST', '/api/purchases' + (p ? '/' + p.id : ''), data).then(function (r) {
      state.meds = [];
      var sh = (r.short || []).map(function (x) { return x.name + ' (' + x.sold + ' bik chuki)'; }).join(', ');
      toast((p ? 'Purchase update ho gayi.' : 'Purchase saved. ' + r.purchase.items.length + ' dawai stock mein judi.') + (sh ? ' Note: ' + sh : ''));
      purState.current = null; showTab('purchases');
    }).catch(function (x) { err.textContent = x.message; err.hidden = false; err.scrollIntoView({ block: 'center' }); })
      .finally(function () { btn.disabled = false; btn.textContent = 'Save purchase / स्टॉक में जोड़ें'; });
  });
  $('pf-del').addEventListener('click', function () {
    var p = purState.current;
    if (!p || !confirm('Delete this purchase from ' + p.supplier + '? Its quantity will be taken out of stock.\n\nYe purchase delete karein? Iski quantity stock se ghat jayegi.')) return;
    api('DELETE', '/api/purchases/' + p.id).then(function (r) {
      state.meds = [];
      var sh = (r.short || []).map(function (x) { return x.name + ' (' + x.sold + ' pehle hi bik chuki)'; }).join(', ');
      toast('Purchase deleted. Stock kam kiya.' + (sh ? ' ' + sh : '')); purState.current = null; showTab('purchases');
    }).catch(showError);
  });

  // ---------- udhaar khata ----------
  var khState = { customers: [], current: null };
  var curCustomer = null;
  function loadKhata() {
    return api('GET', '/api/khata').then(function (r) {
      khState.customers = r.customers;
      $('udh-card').innerHTML = '<div><small>Kul baaki (total due)</small><strong>' + rupees(r.total_due) + '</strong></div><div><small>Kitne logon pe</small><strong>' + r.owing_count + '</strong></div>';
      renderKhata();
    }).catch(showError);
  }
  function renderKhata() {
    var q = ($('udh-search').value || '').trim().toLowerCase();
    var list = khState.customers.filter(function (c) { return !q || c.name.toLowerCase().indexOf(q) >= 0 || (c.phone || '').indexOf(q) >= 0; });
    if (!khState.customers.length) { $('udh-list').innerHTML = '<div class="empty"><p><strong>Udhaar khata khaali hai.</strong></p><p>Kisi ne udhaar liya? Yahan likhein; payment aane pe "Payment mila" dabayein. Baaki apne aap jud jayega.</p><button class="btn btn-primary" type="button" data-khata="udhaar">+ Pehla udhaar likho</button></div>'; return; }
    $('udh-list').innerHTML = list.map(function (c) {
      var due = c.balance > 0.004, adv = c.balance < -0.004;
      return '<button type="button" class="item bill-item li-row" data-customer="' + c.id + '"><div class="main"><b>' + esc(c.name) + '</b><small>' + (c.phone ? esc(c.phone) + ' · ' : '') + (c.last_date ? 'last ' + fmtDate(c.last_date) : '') + '</small></div><div class="side">' +
        (due ? '<strong class="due">' + rupees(c.balance) + '</strong>' : adv ? '<span class="badge b-green">Advance ' + rupees(-c.balance) + '</span>' : '<span class="badge b-green">Clear ✓</span>') + '</div></button>';
    }).join('') || '<div class="empty">Koi customer nahi mila.</div>';
  }
  $('udh-search').addEventListener('input', renderKhata);
  function waReminder(c) {
    var store = (state.user && state.user.store_name) || '';
    return 'Namaste ' + c.name + ' ji, aapka ' + rupees(c.balance) + ' baaki hai — ' + store + '. Dhanyavaad 🙏';
  }
  function openCustomer(id) {
    return api('GET', '/api/khata/customers/' + id).then(function (r) {
      var c = r.customer; curCustomer = c;
      showTab('customer');
      $('cu-name').textContent = c.name;
      var due = c.balance > 0.004;
      $('cu-card').innerHTML = '<div><small>' + (due ? 'Baaki (due)' : c.balance < -0.004 ? 'Advance' : 'Hisaab') + '</small><strong class="' + (due ? 'due' : 'ok') + '">' + (due || c.balance < -0.004 ? rupees(Math.abs(c.balance)) : 'Clear ✓') + '</strong></div><div><small>Mobile</small><strong class="sm">' + (c.phone ? esc(c.phone) : '—') + '</strong></div>';
      var wa = $('cu-wa');
      if (due) { wa.hidden = false; wa.href = 'https://wa.me/' + (c.phone ? '91' + c.phone : '') + '?text=' + encodeURIComponent(waReminder(c)); }
      else wa.hidden = true;
      $('cu-entries').innerHTML = r.entries.length ? r.entries.map(function (e) {
        var u = e.kind === 'udhaar';
        return '<div class="item k-entry li-row"><div class="main"><b class="' + (u ? 'due' : 'ok') + '">' + (u ? '+ Udhaar ' : '− Payment ') + rupees(e.amount) + '</b><small>' + fmtDate(e.entry_date) + (e.bill_no ? ' · Bill #' + e.bill_no : '') + (e.note && !(e.bill_no && e.note === 'Bill #' + e.bill_no) ? ' · ' + esc(e.note) : '') + '</small></div><div class="side"><small class="muted">Baaki ' + rupees(e.balance) + '</small><button class="linkbtn danger" type="button" data-del-entry="' + e.id + '" aria-label="Delete entry">✕</button></div></div>';
      }).join('') : '<div class="empty">Abhi koi entry nahi.</div>';
    }).catch(showError);
  }
  function delEntry(id) {
    if (!confirm('Ye entry delete karein? / Delete this entry?')) return;
    api('DELETE', '/api/khata/entries/' + id).then(function () { toast('Entry deleted'); if (curCustomer) openCustomer(curCustomer.id); }).catch(showError);
  }
  var khCtx = null;
  function openKhata(kind, cust, pre) {
    pre = pre || {};
    khCtx = { kind: kind, cust: cust, bill: pre.bill || null };
    $('kh-title').textContent = kind === 'payment' ? 'Payment mila / भुगतान' : 'Udhaar likho / उधार';
    $('kh-err').hidden = true;
    $('kh-cust').hidden = !!cust;
    $('kh-for').hidden = !cust && !pre.bill;
    $('kh-for').innerHTML = cust ? 'Customer: <b>' + esc(cust.name) + '</b>' + (cust.balance > 0.004 ? ' · baaki ' + rupees(cust.balance) : '') : pre.bill ? 'Bill #' + pre.bill.bill_no + ' udhaar mein jayega' : '';
    $('kh-name').value = pre.name || ''; $('kh-phone').value = pre.phone || '';
    $('kh-amt').value = pre.amount != null ? pre.amount : (kind === 'payment' && cust && cust.balance > 0 ? cust.balance : '');
    $('kh-date').value = todayISO(0); $('kh-note').value = '';
    $('cust-names').innerHTML = khState.customers.map(function (c) { return '<option value="' + esc(c.name) + '">' + (c.phone ? esc(c.phone) : '') + '</option>'; }).join('');
    $('kh-dlg').showModal();
    setTimeout(function () { (cust ? $('kh-amt') : $('kh-name')).focus(); }, 50);
  }
  $('kh-name').addEventListener('change', function () {
    var n = this.value.trim().toLowerCase();
    var c = khState.customers.filter(function (x) { return x.name.toLowerCase() === n; })[0];
    if (c && !$('kh-phone').value) $('kh-phone').value = c.phone || '';
  });
  $('kh-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var err = $('kh-err'), btn = $('kh-save');
    var data = { kind: khCtx.kind, amount: $('kh-amt').value, entry_date: $('kh-date').value, note: $('kh-note').value };
    if (khCtx.cust) data.customer_id = khCtx.cust.id; else { data.customer_name = $('kh-name').value; data.customer_phone = $('kh-phone').value; }
    if (khCtx.bill) data.bill_id = khCtx.bill.id;
    btn.disabled = true; err.hidden = true;
    api('POST', '/api/khata/entries', data).then(function (r) {
      $('kh-dlg').close();
      toast(khCtx.kind === 'payment' ? 'Payment likh liya ✓' : 'Udhaar likh liya ✓');
      openCustomer(r.customer_id);
    }).catch(function (x) { err.textContent = x.message; err.hidden = false; }).finally(function () { btn.disabled = false; });
  });
  $('cu-edit').addEventListener('click', function () {
    if (!curCustomer) return;
    $('cu-n').value = curCustomer.name; $('cu-p').value = curCustomer.phone || ''; $('cu-err').hidden = true; $('cu-dlg').showModal();
  });
  $('cu-form').addEventListener('submit', function (e) {
    e.preventDefault();
    api('PUT', '/api/khata/customers/' + curCustomer.id, { name: $('cu-n').value, phone: $('cu-p').value }).then(function () { $('cu-dlg').close(); toast('Saved'); openCustomer(curCustomer.id); })
      .catch(function (x) { $('cu-err').textContent = x.message; $('cu-err').hidden = false; });
  });
  $('cu-del').addEventListener('click', function () {
    if (!curCustomer || !confirm('Delete ' + curCustomer.name + ' and all their udhaar entries?\n\n' + curCustomer.name + ' aur unka poora hisaab delete karein?')) return;
    api('DELETE', '/api/khata/customers/' + curCustomer.id).then(function () { toast('Customer deleted'); curCustomer = null; showTab('udhaar'); }).catch(showError);
  });


  // ---------- AI Assistant (order link + QR, parchi scan, aaj ke reminders) ----------
  // Order links always point at the store's own-domain copy of the app, whichever host the owner is using.
  var ORDER_BASE = 'https://dawalekh.publicvm.com';
  var aiOrder = null, scanPicks = [];
  function hasPro() { return !!(state.limits && state.limits.purchases); }
  var scriptCache = {};
  function loadScript(src) {
    if (!scriptCache[src]) scriptCache[src] = new Promise(function (res, rej) { var s = document.createElement('script'); s.src = src; s.async = true; s.onload = res; s.onerror = function () { delete scriptCache[src]; rej(new Error('Internet slow hai — script load nahi hui. Dobara try karein.')); }; document.head.appendChild(s); });
    return scriptCache[src];
  }
  function orderUrl() { return ORDER_BASE + '/order?s=' + aiOrder.code; }
  function qrSvg(text) { var q = window.qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 6, margin: 2, scalable: true, alt: 'QR code: ' + text }); }
  function lockCard(what) {
    var s = state.user && state.user.status;
    var msg = s && s.state === 'expired' ? 'Store read-only hai. ' + what + ' ke liye plan lein.' : what + ' Pro plan mein hai (₹149/mahina). Trial mein sab khula hota hai.';
    return '<div class="ai-lock"><span>🔒</span><p>' + esc(msg) + '</p><button class="btn btn-primary btn-sm" type="button" data-go="plan">Pro dekho</button></div>';
  }
  function loadAI() {
    var s = state.user.status, pro = hasPro();
    $('ai-plan').innerHTML = s.state === 'trial' ? ''
      : s.state === 'expired' ? '<div class="alert alert-warn small">🔒 Store read-only hai. Order link chalta rahega; scan aur reminders ke liye plan lein.</div>'
      : pro ? '' : '<div class="alert alert-info small">Basic plan: WhatsApp order link + QR free. Parchi scan aur aaj ke reminders <b>Pro</b> mein.</div>';
    $('ai-scan-lock').hidden = pro; $('ai-scan-body').hidden = !pro; if (!pro) $('ai-scan-lock').innerHTML = lockCard('AI parchi scan');
    $('ai-refill-lock').hidden = pro; $('ai-refill-body').hidden = !pro; if (!pro) $('ai-refill-lock').innerHTML = lockCard('Aaj ke refill reminders');
    loadOrderLink();
    if (pro) loadAIDue();
  }
  function loadOrderLink() {
    Promise.all([api('GET', '/api/ai/order-link'), loadScript('/vendor/qrcode.min.js')]).then(function (res) {
      aiOrder = res[0]; renderOrderLink();
    }).catch(function (x) { $('ai-order-body').textContent = x.message || 'Link nahi bana. Page refresh karein.'; });
  }
  function renderOrderLink() {
    var url = orderUrl(), num = aiOrder.order_phone || aiOrder.login_phone;
    $('ai-order-body').innerHTML =
      '<div class="ord-grid"><div class="ord-qr" id="ord-qr">' + qrSvg(url) + '</div><div class="ord-side">' +
      '<label class="small muted" for="ord-url">Aapka order link</label><input id="ord-url" class="ord-url" readonly value="' + esc(url) + '">' +
      '<div class="ord-btns"><button class="btn btn-ghost btn-sm" type="button" id="ord-copy">📋 Copy</button>' +
      '<a class="btn btn-wa btn-sm" target="_blank" rel="noopener" href="https://wa.me/?text=' + encodeURIComponent('🙏 ' + aiOrder.store_name + ' se dawai ab WhatsApp par order karein — naam likhein ya parchi ki photo bhejein: ' + url) + '">📤 Customers ko bhejo</a>' +
      '<button class="btn btn-primary btn-sm" type="button" id="ord-poster">🖨️ Counter poster</button>' +
      '<a class="btn btn-ghost btn-sm" target="_blank" rel="noopener" href="' + esc(url) + '">👀 Dekho</a></div>' +
      '<p class="small muted" style="margin:8px 0 0">Orders is WhatsApp number par aayenge: <b>+91 ' + esc(num) + '</b> <button class="linkbtn" type="button" id="ord-chg">Badlo</button></p>' +
      '<form id="ord-form" class="ord-form" hidden><input id="ord-phone" inputmode="numeric" maxlength="10" placeholder="10 digit WhatsApp number" value="' + esc(aiOrder.order_phone || '') + '"><button class="btn btn-primary btn-sm" type="submit">Save</button></form>' +
      '</div></div>';
    $('ord-copy').addEventListener('click', function () {
      var done = function () { toast('Link copy ho gaya ✓'); };
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, function () { $('ord-url').select(); document.execCommand('copy'); done(); });
      else { $('ord-url').select(); document.execCommand('copy'); done(); }
    });
    $('ord-chg').addEventListener('click', function () { $('ord-form').hidden = !$('ord-form').hidden; if (!$('ord-form').hidden) $('ord-phone').focus(); });
    $('ord-form').addEventListener('submit', function (e) {
      e.preventDefault();
      api('PUT', '/api/ai/order-link', { order_phone: $('ord-phone').value }).then(function (r) { aiOrder.order_phone = r.order_phone; renderOrderLink(); toast('Order number save ho gaya ✓'); }).catch(showError);
    });
    $('ord-poster').addEventListener('click', printPoster);
  }
  function printPoster() {
    var url = orderUrl(), u = state.user;
    var w = window.open('', '_blank');
    if (!w) { toast('Popup block hua — browser mein popup allow karein.'); return; }
    w.document.write('<!doctype html><html lang="hi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Order poster — ' + esc(u.store_name) + '</title><style>' +
      '@page{size:A4;margin:12mm}body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",sans-serif;margin:0;color:#0f172a;text-align:center}' +
      '.p{border:6px solid #0f766e;border-radius:28px;padding:28px 22px;max-width:640px;margin:16px auto}h1{font-size:40px;margin:6px 0 2px;color:#0f766e}' +
      '.s{font-size:26px;font-weight:800;margin:0}.c{color:#475569;font-size:17px;margin:4px 0 16px}.q{width:330px;max-width:80vw;margin:6px auto}.q svg{width:100%;height:auto}' +
      '.st{display:flex;justify-content:center;gap:10px;flex-wrap:wrap;margin:16px 0 8px}.st div{background:#f0fdfa;border:2px solid #99f6e4;border-radius:14px;padding:10px 12px;font-size:16px;font-weight:700;min-width:150px}' +
      '.u{font-size:13px;color:#64748b;word-break:break-all}.wa{display:inline-block;background:#16a34a;color:#fff;border-radius:999px;padding:6px 18px;font-weight:800;font-size:20px;margin-top:6px}' +
      '.b{margin-top:14px}@media print{.b{display:none}}button{font:inherit;font-size:18px;padding:10px 22px;border-radius:12px;border:0;background:#0f766e;color:#fff}</style></head><body><div class="p">' +
      '<p class="s">' + esc(u.store_name) + '</p><p class="c">' + esc([u.store_address, u.city].filter(Boolean).join(', ')) + '</p>' +
      '<h1>Dawai WhatsApp par order karein</h1><span class="wa">📱 Scan karo → order bhejo</span>' +
      '<div class="q">' + qrSvg(url) + '</div>' +
      '<div class="st"><div>1. Camera se QR scan karein</div><div>2. Dawai likhein ya parchi photo lagayein</div><div>3. WhatsApp par bhejein ✅</div></div>' +
      '<p class="u">' + esc(url) + '</p></div><div class="b"><button onclick="window.print()">🖨️ Print karo</button></div>' +
      '<script>setTimeout(function(){window.print()},600)<\/script></body></html>');
    w.document.close();
  }

  // Refill reminders due today (or overdue).
  function aiWa(r) {
    var store = (state.user && state.user.store_name) || 'aapka medical store';
    var msg = 'Namaste ' + r.patient_name + ' ji 🙏\n' + store + ' se yaad dila rahe hain — aapki monthly dawai (' + r.medicine + ') khatam hone wali hogi.\nRefill ke liye store aa jaiye, ya isi number par reply karein — hum dawai ready rakh denge.\nDhanyavaad!';
    return 'https://wa.me/91' + r.phone + '?text=' + encodeURIComponent(msg);
  }
  function loadAIDue() {
    return api('GET', '/api/reminders').then(function (r) {
      state.reminders = r.reminders;
      var due = r.reminders.filter(function (x) { return x.days_left <= 0; });
      var soon = r.reminders.filter(function (x) { return x.days_left > 0 && x.days_left <= 3; }).length;
      $('ai-due').innerHTML = (due.length ? due.map(function (x) {
        return '<div class="item"><div class="main"><b>' + esc(x.patient_name) + '</b><small>' + esc(x.medicine) + '</small><small>har ' + x.every_days + ' din' + (x.last_sent_at ? ' · pichhla reminder ' + fmtDate(x.last_sent_at) : '') + '</small></div><div class="side">' + dueBadge(x.days_left) +
          '<div class="acts"><a class="btn btn-wa btn-sm" href="' + aiWa(x) + '" target="_blank" rel="noopener" data-sent="' + x.id + '">💬 WhatsApp reminder</a></div></div></div>';
      }).join('') : '<div class="empty">Aaj koi refill due nahi hai 🎉' + (r.reminders.length ? '' : '<br><small>Bill banate waqt “🔁 Monthly dawai” tick karein.</small>') + '</div>') +
        (soon ? '<p class="small muted" style="margin:8px 0 0">Agle 3 din mein: <b>' + soon + '</b> patient</p>' : '');
    }).catch(showError);
  }

  // ---- AI parchi scan: in-browser OCR (Tesseract.js, English) + fuzzy match against this store's stock ----
  var TESS = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  var STOP = ('tab tabs tablet tablets cap caps capsule capsules syp syrup inj injection oint ointment cream gel drops drop susp suspension mg ml mcg gm gram ' +
    'daily once twice thrice times day days week weeks month after before food meal meals morning night evening noon bedtime empty stomach with water ' +
    'take dose doses od bd tds qid hs sos stat rx dr doctor patient name age sex male female date address phone clinic hospital signature sign reg regd mbbs md ' +
    'diagnosis advice review follow followup the and for one two three four five half every per hour hours qty quantity total').split(' ');
  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function lev(a, b) {
    if (a === b) return 0;
    var m = a.length, n = b.length; if (!m) return n; if (!n) return m;
    var prev = [], cur = [], i, j;
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) { cur = [i]; for (j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
    return prev[n];
  }
  function sim(a, b) { var d = lev(a, b); return 1 - d / Math.max(a.length, b.length); }
  // Common OCR slips in medicine names: 0↔o, 1↔l, 5↔s.
  function ocrFix(w) { return /[a-z]/.test(w) ? w.replace(/0/g, 'o').replace(/1/g, 'l').replace(/5/g, 's') : w; }
  function matchStock(text, meds) {
    var lines = String(text).split(/\n+/).map(norm).filter(Boolean);
    var words = [];
    lines.forEach(function (ln, li) { ln.split(' ').forEach(function (w) { words.push({ w: w, fx: ocrFix(w), line: li }); }); });
    var byName = {};
    meds.forEach(function (m) { var k = norm(m.name); (byName[k] = byName[k] || []).push(m); });
    var out = [];
    Object.keys(byName).forEach(function (k) {
      var parts = k.split(' '), head = parts.filter(function (p) { return p.length >= 3 && !/^\d+$/.test(p) && STOP.indexOf(p) < 0; })[0];
      if (!head) return;
      var strength = (k.match(/\d+(\.\d+)?/) || [])[0];
      var best = null;
      words.forEach(function (o, idx) {
        if (o.fx.length < 3 || STOP.indexOf(o.fx) >= 0 || /^\d+$/.test(o.fx)) return;
        var sc = sim(o.fx, head);
        var two = words[idx + 1] && words[idx + 1].line === o.line ? ocrFix(o.w + words[idx + 1].w) : null; // "Azi thral" split by OCR
        if (two) sc = Math.max(sc, sim(two, head));
        var need = head.length <= 4 ? 1 : head.length <= 6 ? 0.8 : 0.72;
        if (sc + 1e-9 < need) return;
        var bonus = 0;
        if (strength) { var near = lines[o.line] || ''; if ((' ' + near + ' ').indexOf(' ' + strength) >= 0 || near.indexOf(strength) >= 0) bonus = 0.1; }
        var total = Math.min(1, sc + bonus);
        if (!best || total > best.score) best = { score: total, word: o.w, line: o.line };
      });
      if (!best) return;
      // Prefer the batch that can be sold now and expires first (FEFO).
      var batches = byName[k].slice().sort(function (a, b) { var ok = function (m) { return m.qty > 0 && m.days_left >= 0 ? 0 : 1; }; return ok(a) - ok(b) || String(a.expiry).localeCompare(String(b.expiry)); });
      out.push({ med: batches[0], all: batches, score: best.score, word: best.word, line: best.line });
    });
    out.sort(function (a, b) { return b.score - a.score; });
    // Lines that look like prescription items but matched nothing in stock.
    var matchedLines = out.map(function (x) { return x.line; });
    var unmatched = String(text).split(/\n+/).map(function (s) { return s.trim(); }).filter(function (s, i) { return /^(tab|cap|syp|syr|inj|t\.|c\.|oint|drops?)\b/i.test(s) && matchedLines.indexOf(i) < 0; });
    return { matches: out.slice(0, 20), unmatched: unmatched.slice(0, 10) };
  }
  // Downscale + greyscale + contrast stretch before OCR: faster on phones and a little more accurate.
  function prepImage(file) {
    return new Promise(function (res, rej) {
      var img = new Image();
      img.onload = function () {
        var max = 1800, sc = Math.min(1, max / Math.max(img.width, img.height));
        if (Math.max(img.width, img.height) * sc < 1000) sc = Math.min(2, 1000 / Math.max(img.width, img.height));
        var c = document.createElement('canvas'); c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
        var g = c.getContext('2d'); g.drawImage(img, 0, 0, c.width, c.height);
        var d = g.getImageData(0, 0, c.width, c.height), p = d.data, lo = 255, hi = 0, i, v;
        for (i = 0; i < p.length; i += 4) { v = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]; p[i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
        var span = Math.max(1, hi - lo);
        for (i = 0; i < p.length; i += 4) { v = (p[i] - lo) * 255 / span; p[i] = p[i + 1] = p[i + 2] = v; }
        g.putImageData(d, 0, 0);
        URL.revokeObjectURL(img.src);
        res(c);
      };
      img.onerror = function () { rej(new Error('Photo khul nahi payi. JPG/PNG photo chunein.')); };
      img.src = URL.createObjectURL(file);
    });
  }
  function scanStatus(t, pct) {
    $('sc-status').hidden = false; $('sc-status').textContent = t;
    $('sc-prog').hidden = pct == null; if (pct != null) $('sc-bar').style.width = Math.round(pct * 100) + '%';
  }
  function runScan(file) {
    $('sc-result').hidden = true; scanPicks = [];
    $('sc-img').src = URL.createObjectURL(file); $('sc-prev').hidden = false;
    scanStatus('AI tool load ho raha hai (pehli baar ~10–15 MB, phir fast)…', 0.02);
    var medsP = api('GET', '/api/medicines').then(function (r) { state.meds = r.medicines; return r.medicines; });
    Promise.all([loadScript(TESS), prepImage(file), medsP]).then(function (res) {
      var canvas = res[1], meds = res[2];
      return window.Tesseract.recognize(canvas, 'eng', {
        logger: function (m) {
          if (m.status === 'recognizing text') scanStatus('Parchi padh rahe hain… ' + Math.round(m.progress * 100) + '%', 0.3 + m.progress * 0.7);
          else if (/load|initializ/.test(m.status)) scanStatus('AI tool taiyaar ho raha hai…', 0.05 + (m.progress || 0) * 0.25);
        },
      }).then(function (out) { return { text: out.data.text || '', conf: out.data.confidence, meds: meds }; });
    }).then(function (r) {
      var res = matchStock(r.text, r.meds);
      $('sc-text').textContent = r.text.trim() || '(kuch text nahi mila)';
      scanStatus(res.matches.length ? res.matches.length + ' dawai aapke stock se mili. Pharmacist check karke tick karein.' : 'Stock se koi dawai match nahi hui. Photo saaf/seedhi lekar dobara try karein, ya naam khud search karein.', null);
      if (r.conf != null && r.conf < 55) $('sc-status').textContent += ' (Photo ki quality kam lag rahi hai — handwriting/blur ho sakta hai.)';
      $('sc-matches').innerHTML = res.matches.map(function (x, i) {
        var m = x.med, bad = m.qty <= 0 ? 'Stock khatam' : m.days_left < 0 ? 'Expired' : '';
        var pct = Math.round(x.score * 100);
        return '<label class="item sc-item"><input type="checkbox" data-scan="' + i + '"' + (bad || pct < 80 ? '' : ' checked') + (bad ? ' disabled' : '') + '><div class="main"><b>' + esc(m.name) + '</b>' +
          '<small>Parchi mein: “' + esc(x.word) + '” · match ' + pct + '%</small><small>Stock ' + m.qty + (m.batch ? ' · Batch ' + esc(m.batch) : '') + ' · Exp ' + fmtDate(m.expiry) + ' · ' + money(m.price) + '</small>' +
          (bad ? '<small style="color:#b91c1c;font-weight:700">' + bad + '</small>' : '') + '</div><div class="side"><span class="badge ' + (pct >= 90 ? 'b-green' : pct >= 80 ? 'b-amber' : 'b-grey') + '">' + (pct >= 90 ? 'Pakka' : pct >= 80 ? 'Shayad' : 'Check') + '</span></div></label>';
      }).join('') + (res.unmatched.length ? '<div class="sc-un"><b>Parchi mein ye bhi likha hai, par stock mein nahi mila:</b><ul>' + res.unmatched.map(function (u) { return '<li>' + esc(u) + '</li>'; }).join('') + '</ul></div>' : '');
      scanPicks = res.matches;
      $('sc-result').hidden = false;
      $('sc-bill').hidden = !res.matches.length;
    }).catch(function (x) { scanStatus('Scan nahi hua: ' + (x && x.message ? x.message : 'error') + ' — dobara try karein.', null); });
  }
  $('sc-file').addEventListener('change', function () { var f = this.files && this.files[0]; if (f) runScan(f); this.value = ''; });
  $('sc-bill').addEventListener('click', function () {
    var ids = [];
    document.querySelectorAll('#sc-matches input[data-scan]:checked').forEach(function (c) { var x = scanPicks[Number(c.dataset.scan)]; if (x) ids.push(x.med.id); });
    if (!ids.length) { toast('Pehle dawai tick karein'); return; }
    if (document.body.classList.contains('readonly')) { readOnlyWall(); return; }
    state.pendingBill = ids;
    showTab('newbill');
  });
  window.__dlMatch = matchStock; // used by the automated test page only

  function showError(x) { if (x && x.message !== 'login' && x.status !== 402) toast(x.message); }

  // ---------- start ----------
  waitForServer().then(function () { return Promise.all([api('GET', '/api/me'), fetch('/api/config').then(function (r) { return r.json(); })]).then(function (res) {
    state.user = res[0].user; state.limits = res[0].limits; state.usage = res[0].usage; state.config = res[1]; renderEmailNote();
    $('loading').hidden = true;
    $('store-name').textContent = state.user.store_name;
    applyLimits();
    renderStatus();
    state.timer = setInterval(renderStatus, 30000);
    if (state.user.status.state === 'expired' && !sessionStorage.getItem('ro-seen')) { sessionStorage.setItem('ro-seen', '1'); setTimeout(readOnlyWall, 300); }
    var start = (location.hash || '').slice(1);
    showTab(['plan', 'udhaar', 'purchases', 'bills', 'stock', 'refills', 'ai'].indexOf(start) >= 0 ? start : 'home');
    if (/welcome=1/.test(location.search)) { toast('Welcome! Aapka ' + ((state.config && state.config.trial_days) || 7) + '-din ka free trial shuru ho gaya.'); history.replaceState(null, '', '/app'); }
  }); }).catch(function (x) { if (x.message !== 'login') { $('loading').textContent = 'Could not load your store. Please refresh the page.'; } });
})();
