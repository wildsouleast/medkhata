// MedKhata app: dashboard, stock, refill reminders and billing.
(function () {
  'use strict';
  var state = { user: null, limits: null, config: null, meds: [], reminders: [], filter: 'all', tab: 'home', timer: null };
  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function rupees(n) { return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
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
          if (!r.ok) { var e = new Error((j && j.message) || 'Something went wrong. Please try again.'); e.status = r.status; throw e; }
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
    document.querySelectorAll('.tabs button').forEach(function (b) { b.setAttribute('aria-selected', b.dataset.tab === name ? 'true' : 'false'); });
    ['home', 'stock', 'refills', 'plan'].forEach(function (t) { $('tab-' + t).hidden = t !== name; });
    if (name === 'home') loadHome();
    if (name === 'stock') loadMeds();
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
        '<div class="stat"><small>Stock value</small><strong>' + rupees(t.stockValue) + '</strong></div>' +
        '<div class="stat red"><small>Expired / ≤30 days</small><strong>' + (a.expired.length + a.within30.length) + '</strong></div>' +
        '<div class="stat amber"><small>Low stock</small><strong>' + a.lowStock.length + '</strong></div>' +
        '<div class="stat green"><small>Refills due</small><strong>' + t.remindersDue + '</strong></div>';
      if (!t.medicines) {
        $('alerts').innerHTML = '<div class="empty"><p><strong>Welcome to MedKhata!</strong></p><p>Add your first medicine to start getting expiry and low-stock alerts.</p><button class="btn btn-primary" type="button" data-add-med>+ Add your first medicine</button></div>';
        return;
      }
      $('alerts').innerHTML =
        (a.expired.length ? group('Already expired', 'b-red', a.expired, '') : '') +
        group('Expiring within 30 days', 'b-red', a.within30, 'Nothing expiring in the next 30 days. 👍') +
        group('Expiring in 31–60 days', 'b-amber', a.within60, 'Nothing in this range.') +
        group('Expiring in 61–90 days', 'b-yellow', a.within90, 'Nothing in this range.') +
        group('Low stock', 'b-amber', a.lowStock, 'All medicines are above their low-stock level.', function (m) { return '<span class="badge b-amber">Only ' + m.qty + ' left</span>'; }) +
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
      if (state.filter === 'expiring' && m.days_left > 90) return false;
      if (state.filter === 'low' && m.qty > m.min_qty) return false;
      if (!q) return true;
      return (m.name + ' ' + m.batch + ' ' + m.supplier).toLowerCase().indexOf(q) !== -1;
    });
    if (!state.meds.length) { $('med-list').innerHTML = '<div class="empty">No medicines yet. Tap “+ Add medicine” to add your first one.</div>'; return; }
    if (!list.length) { $('med-list').innerHTML = '<div class="empty">No medicines match.</div>'; return; }
    $('med-list').innerHTML = list.map(function (m) {
      var low = m.qty <= m.min_qty ? ' <span class="badge b-amber">Low stock</span>' : '';
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
    (editingMed ? api('PUT', '/api/medicines/' + editingMed.id, data) : api('POST', '/api/medicines', data))
      .then(function () { $('med-dlg').close(); toast(editingMed ? 'Medicine updated' : 'Medicine added'); refreshCurrent(); })
      .catch(function (x) { err.textContent = x.message; err.hidden = false; })
      .finally(function () { btn.disabled = false; });
  });
  $('m-del').addEventListener('click', function () {
    if (!editingMed || !confirm('Delete ' + editingMed.name + '? This cannot be undone.')) return;
    api('DELETE', '/api/medicines/' + editingMed.id).then(function () { $('med-dlg').close(); toast('Medicine deleted'); refreshCurrent(); }).catch(function (x) { $('m-err').textContent = x.message; $('m-err').hidden = false; });
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
    var f = $('profile-form'); f.store_name.value = u.store_name; f.owner_name.value = u.owner_name; f.city.value = u.city;
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
        name: 'MedKhata', description: o.plan.name + ' plan · 30 days',
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
    api('PUT', '/api/me', { store_name: f.store_name.value, owner_name: f.owner_name.value, city: f.city.value }).then(function (r) { state.user = r.user; $('store-name').textContent = r.user.store_name; toast('Details saved'); }).catch(function (x) { toast(x.message); });
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
    else if (t.dataset.editMed) openMed(findMed(t.dataset.editMed));
    else if (t.dataset.editRem) openRem(state.reminders.filter(function (r) { return r.id === Number(t.dataset.editRem); })[0]);
    else if (t.dataset.pay) pay(t.dataset.pay, t);
    else if (t.hasAttribute('data-close')) t.closest('dialog').close();
    else if (t.dataset.sent) {
      var id = t.dataset.sent;
      setTimeout(function () { api('POST', '/api/reminders/' + id + '/sent').then(function () { toast('Marked as sent. Next refill date updated.'); loadReminders(); }).catch(function () {}); }, 400);
    }
  });
  document.querySelectorAll('.chip').forEach(function (c) {
    c.addEventListener('click', function () {
      state.filter = c.dataset.filter;
      document.querySelectorAll('.chip').forEach(function (x) { x.setAttribute('aria-pressed', x === c ? 'true' : 'false'); });
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
    state.user = res[0].user; state.limits = res[0].limits; state.config = res[1];
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
